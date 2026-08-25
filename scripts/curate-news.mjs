#!/usr/bin/env node
/**
 * GeorgiaScience.org, automated news curation.
 *
 * Runs on a schedule from .github/workflows/news-curation.yml. It does two
 * things, mirroring the two phases of the manual curation skill:
 *
 *   1. CURATION. One Anthropic API call with the server-side web_search tool
 *      that looks for Georgia science education and science literacy news and
 *      returns a candidate list.
 *   2. DRAFTING. One call per candidate with the server-side web_fetch tool.
 *      The model must read the primary source before drafting, and must report
 *      which specific claims the source actually supports, with quotes.
 *
 * It writes schema-exact Markdown files into src/content/news/ and a
 * human-readable review checklist into the pull request body. It never
 * commits to main and never publishes. A human merges, or does not.
 *
 * The source recorded on an item is always a page the run actually opened and
 * quoted. Where an institution blocks automated reading, as gadoe.org does, the
 * run falls back to a reputable outlet it can read and links the institution's
 * own announcement in the body as well.
 *
 * Anything the model could not verify against a fetched source is discarded,
 * not smoothed over and not drafted. The same goes for anything that turns out,
 * on reading the page, to be a funding announcement rather than news.
 *
 * Env:
 *   ANTHROPIC_API_KEY   required
 *   NEWS_MODEL          default claude-sonnet-5
 *   NEWS_MAX_ITEMS      default 3
 *   NEWS_LOOKBACK_DAYS  default 45
 *   NEWS_PENDING_FILE   optional, lines harvested from open automation PRs
 *   NEWS_PR_BODY_FILE   default pr-body.md
 *   NEWS_DRY_RUN        "true" to skip writing .md files
 *   GITHUB_OUTPUT       set by Actions
 */

import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const NEWS_DIR = path.join(ROOT, 'src', 'content', 'news');
const API_URL = 'https://api.anthropic.com/v1/messages';

// Controlled vocabulary. This must stay identical to the enum in
// src/content.config.ts. Anything outside it fails the Astro build.
const CATEGORIES = ['scholarship', 'discovery', 'policy', 'event', 'resource'];

const MODEL = process.env.NEWS_MODEL || 'claude-sonnet-5';
const MAX_ITEMS = clampInt(process.env.NEWS_MAX_ITEMS, 3, 1, 5);
const LOOKBACK_DAYS = clampInt(process.env.NEWS_LOOKBACK_DAYS, 90, 7, 365);
const PR_BODY_FILE = process.env.NEWS_PR_BODY_FILE || 'pr-body.md';
// GitHub handle to @mention at the top of the pull request. A mention notifies
// under the default "Participating and @mentions" setting, so the notification
// does not depend on the repository Watch configuration.
const NOTIFY_HANDLE = (process.env.NEWS_NOTIFY_HANDLE || '').replace(/^@/, '').trim();
const DRY_RUN = String(process.env.NEWS_DRY_RUN || '').toLowerCase() === 'true';

/* ------------------------------------------------------------------ utils */

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalise a URL for duplicate detection: drop the scheme, a leading www,
 * tracking query parameters, the fragment, and any trailing slash. Two links
 * to the same story from two campaigns should collapse to one key.
 */
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let p = u.pathname.replace(/\/+$/, '');
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) continue;
      keep.append(k, v);
    }
    const q = keep.toString();
    return host + p + (q ? '?' + q : '');
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

function normalizeTitle(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
}

/**
 * House style is enforced mechanically where it can be: no em or en dashes,
 * no emoji, no decorative symbols. Anything that survives this is flagged for
 * the human instead of being silently shipped.
 */
function sanitizeText(input) {
  let s = String(input ?? '');
  s = s.replace(/\s*[—–]\s*/g, ', ');   // em and en dash to comma
  s = s.replace(/[‘’]/g, "'");
  s = s.replace(/[“”]/g, '"');
  s = s.replace(/[…]/g, '...');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ +\n/g, '\n');
  return s.trim();
}

function yamlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function log(...args) {
  console.log(...args);
}

/* ------------------------------------------------------- repository state */

/** Minimal frontmatter reader. The files are machine written, so this is enough. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Everything already published, so the same story does not resurface every
 * run. Keyed three ways because a story can reappear under a new headline or
 * a new campaign URL.
 */
async function loadPublished() {
  const state = { slugs: new Set(), urls: new Set(), titles: new Set(), list: [] };
  if (!existsSync(NEWS_DIR)) return state;
  const files = (await readdir(NEWS_DIR)).filter((f) => /\.mdx?$/.test(f));
  for (const file of files) {
    const raw = await readFile(path.join(NEWS_DIR, file), 'utf8');
    const fm = parseFrontmatter(raw);
    state.slugs.add(file.replace(/\.mdx?$/, ''));
    if (fm.source) state.urls.add(normalizeUrl(fm.source));
    if (fm.title) {
      state.titles.add(normalizeTitle(fm.title));
      state.list.push({ date: fm.date || '', title: fm.title, source: fm.source || '' });
    }
  }
  state.list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return state;
}

/**
 * Items sitting in an open automation pull request are not on main yet but are
 * already awaiting review. Drafting them again would produce a second PR for
 * the same story. The workflow harvests "+title:" and "+source:" lines from
 * open PR diffs into this file.
 */
async function loadPending(state) {
  const file = process.env.NEWS_PENDING_FILE;
  if (!file || !existsSync(file)) return;
  const raw = await readFile(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\+?\s*(title|source):\s*"?([^"]*)"?\s*$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'source') state.urls.add(normalizeUrl(m[2]));
    else state.titles.add(normalizeTitle(m[2]));
  }
}

/* --------------------------------------------------------------- api call */

async function callAnthropic({ system, userText, tools, maxTokens = 8000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    tools,
    messages: [{ role: 'user', content: userText }],
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err;
      await sleep(attempt * 5000);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return { text, usage: data.usage || {}, stopReason: data.stop_reason };
    }

    const detail = await res.text();
    lastError = new Error('Anthropic API ' + res.status + ': ' + detail.slice(0, 500));
    // Retry transient failures only. A 400 will not fix itself.
    if (res.status !== 429 && res.status < 500) break;
    await sleep(attempt * 10000);
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull the last JSON fence, or failing that the outermost braces. */
function extractJson(text) {
  const fences = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.map((f) => f[1]);
  const first = String(text).indexOf('{');
  const last = String(text).lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(String(text).slice(first, last + 1));
  for (const c of candidates.reverse()) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('No parsable JSON in model response: ' + String(text).slice(0, 400));
}

/* ----------------------------------------------------------- phase 1 */

const SCOPE_RULES = `
INCLUDE:
- Georgia science education and scientific literacy at any level, K-12, higher
  education, and public understanding.
- Policy and administrative decisions that affect how science is taught, funded,
  assessed, or resourced in Georgia. Standards adoption, curriculum decisions,
  assessment changes, appropriations that change classroom capacity, state board
  actions, and legislation. The intersection of policy and the quality of science
  education is a priority for this site.
- Health and medical science that bears on public understanding in Georgia,
  including public health decisions and communication.
- Technology, computing, engineering, and robotics education, including
  competitions, curricula, and training programs.
- Research findings from Georgia institutions that a general audience can learn
  something from.
- Programs, tools, curricula, competitions, scholarships, and materials that
  Georgia students, teachers, or members of the public can actually use.

Reputable Georgia institutions include the Georgia Department of Education, UGA,
Georgia Tech and its CEISMC, Georgia State, Emory, the University System of
Georgia, the Georgia Science Teachers Association, the Georgia Department of
Public Health, regional STEM centers, and school districts.

On policy items specifically. Report the decision, who made it, what the record
says about its effects, and what remains unknown. Do not assign blame, do not use
partisan framing, and do not characterise anyone's motives. A reader should be
able to see what happened and reach their own conclusion. That is both the house
standard and the harder version to dismiss.

EXCLUDE, without exception:
- Partisan political advocacy not about science education.
- Vendor or marketing promotion. A company press release pushing its own product
  is marketing, not news, even when it mentions schools.
- Unvetted or low quality sources.
- Content that overstates certainty or blurs evidence with speculation.
- Research funding announcements. A grant, award, contract, or selection for a
  program given to a Georgia institution or researcher is not a news item for
  this site, however large the figure or prestigious the funder. Money changing
  hands is not a finding, and it is not education. Report a research project
  only when there is an actual result to explain. A press release announcing
  that work will begin is the clearest example of what to drop.
- Conflict framing introduced by an aggregator or an AI overview. If the only
  "news" is a summary dressing a development up as a fight, report the underlying
  development plainly or drop the item.

Reputable Georgia news outlets are pointers to a primary source, not the primary
source themselves. Prefer the institution's own announcement page.

Bias toward grades 8 to 12 relevance, but include clearly relevant items outside
that band.

Not everything worth publishing is an event. A resource item, a program, tool,
competition, curriculum, or scholarship that Georgia students, teachers, or the
public can use, qualifies on being current and useful. It does not need a recent
announcement behind it. Summer programs, standing competitions, and available
curricula all count. Look for these deliberately, because they are easy to miss
when searching for news, and a site with nothing but breaking news serves its
readers less well than one that also points them at things they can use.

For a resource item the date must still come from the source: the program or
application start, a stated deadline, or the page's own publication or update
date. If the page states no date anywhere, drop the item rather than inventing
one.
`.trim();

const STYLE_RULES = `
- No em dashes and no en dashes. Use commas and periods.
- No emojis and no decorative symbols.
- Sentence case headings.
- Evidence language: "the evidence supports", "the data suggest", "this is
  consistent with". Never write that science "proves" anything.
- Distinguish evidence from interpretation from speculation.
- Minimal editorializing. Report, cite, and let the reader judge.
- Define jargon on first use or leave it out.
`.trim();

async function curate(published) {
  const recent = published.list
    .slice(0, 40)
    .map((i) => '- ' + i.date + ' ' + i.title + ' (' + i.source + ')')
    .join('\n');

  const system = `You are the curation pass of the news workflow for
GeorgiaScience.org, the public site of Georgia Citizens for Integrity in
Science Education. The organization models the verification practices it
teaches. Your job is to find candidate news items, not to publish them.

${SCOPE_RULES}

Quality bar: it is correct and expected to return zero items. An empty week is
better than a thin or recycled one. Never pad the list to reach a quota.`;

  const userText = `Today is ${today()}. Search for Georgia science education and
science literacy news published or announced between ${daysAgo(LOOKBACK_DAYS)}
and ${today()}.

Run several distinct searches rather than one broad one. Vary the terms across
scholarships, STEM grants and funding, science standards and policy, science
fairs and educator events, and research findings from Georgia institutions that
matter to a general audience. Search the Georgia Department of Education, UGA,
Georgia Tech, Georgia State, Emory, the University System of Georgia, the
Georgia Science Teachers Association, and official scholarship and STEM funding
program pages.

Already published on the site, do not return these or any restatement of them:
${recent || '(nothing published yet)'}

Return at most ${MAX_ITEMS} candidates, fewer if fewer clear the bar, and zero if
none do. Rank strongest first.

Respond with one JSON object and nothing else, in a \`\`\`json fence:

{
  "items": [
    {
      "headline": "plain statement of what happened",
      "sourceUrl": "https://primary-source",
      "sourceName": "publication or institution, whichever page you actually read",
  "originalAnnouncementUrl": "the institution's own page if you used a different source, otherwise null",
  "originalAnnouncementName": "the institution's name if the field above is set, otherwise null",
      "category": "scholarship | discovery | policy | event | resource",
      "eventDate": "YYYY-MM-DD, the date of the event or announcement",
      "location": "City or region, Georgia, or null if genuinely unknown",
      "whyItFits": "one line tying it to Georgia science education or literacy",
      "watchFor": "a caveat to check, or null"
    }
  ],
  "notes": "one or two sentences on what you searched and why anything was dropped"
}

The category must be exactly one of the five listed values. If an item does not
fit one of them, drop the item rather than approximating.`;

  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }];
  const res = await callAnthropic({ system, userText, tools, maxTokens: 8000 });
  const parsed = extractJson(res.text);
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    notes: parsed.notes || '',
    usage: res.usage,
  };
}

/* ----------------------------------------------------------- phase 2 */

async function draftItem(candidate) {
  const system = `You are the drafting pass of the news workflow for
GeorgiaScience.org. You draft one news item from a primary source you have
actually read. You never publish. A human reviews every word before it ships.

House style:
${STYLE_RULES}

Honesty rules, these matter more than a polished draft:
- Fetch and read the source before drafting. A link existing is not the same as
  the source saying what a draft claims.
- The link you record must be a page you actually opened and quoted. A reader
  following it has to be able to confirm what the draft says. An origin that
  cannot be read is worth less here than a readable account of the same facts.
- Every factual statement in the draft must be supported by text you read in the
  fetched page. If you cannot fetch the page, say so and set verified to false.
- Never restate a claim the source does not support. If a figure appears only in
  a secondary source, leave it out and note it.
- Add no background from your own knowledge. Not context about how a programme
  works, not an explanation of what a test measures, not history, however
  confident you are and however harmless it seems. If it is not on the page you
  read, it does not go in the item. Unsourced background is the most dangerous
  content you can produce here, because it looks like the rest of the draft and
  carries no quote for the reviewer to check.
- Report doubt rather than smoothing it over.`;

  const userText = `Draft one news item from this candidate.

Headline lead: ${candidate.headline}
Primary source: ${candidate.sourceUrl}
Suggested source name: ${candidate.sourceName || '(unknown)'}
Suggested category: ${candidate.category}
Suggested event date: ${candidate.eventDate || '(unknown)'}

Fetch that URL and read it first.

If that page cannot be read, and some institutional sites block automated
fetching and return only metadata, do not give up on the story yet. Search for
another page covering the same announcement that you can actually read, and
verify against that instead. Prefer in this order:

1. The institution's own announcement, if it can be read.
2. A reputable Georgia news outlet reporting the story itself.
3. A reputable outlet reprinting the announcement in full.

Never fall back to an aggregator, a content farm, an AI generated summary, a
social media post, or a site you cannot identify. If nothing readable and
reputable exists, set verified to false and stop.

Record in "source" whichever page you actually read and quoted, and name it in
"sourceName". If that page is not the institution's own announcement and the
institution does have one, put its URL in "originalAnnouncementUrl" so the item
can link both.

Then respond with one JSON object and nothing else, in a \`\`\`json fence:

{
  "verified": true or false,
  "inScope": true or false,
  "fetchNote": "one sentence on whether the page was fetched and what it is",
  "title": "Specific headline: what happened and who it affects",
  "date": "YYYY-MM-DD, the date of the event or announcement, not today",
  "category": "scholarship | discovery | policy | event | resource",
  "source": "the primary source URL you actually read",
  "sourceName": "publication or institution, whichever page you actually read",
  "originalAnnouncementUrl": "the institution's own page if you used a different source, otherwise null",
  "originalAnnouncementName": "the institution's name if the field above is set, otherwise null",
  "location": "City or region, Georgia, or null if the source does not say",
  "summary": "one to two plain language sentences for the list and home pages",
  "body": "one to three sentences of plain language explanation, no heading, no source link, the script adds the link",
  "claims": [
    { "claim": "a specific factual assertion made in the draft",
      "quote": "a short verbatim quote from the fetched page that supports it" }
  ],
  "unsupported": ["any claim in the candidate lead that the source did not support"],
  "missionSentence": "one optional sentence connecting this to science literacy in Georgia, or null"
}

Category meanings, applied strictly:
- scholarship: funding awarded to students. Not funding awarded to researchers
  or institutions, which is out of scope entirely.
- discovery: a research finding that has been made and can be explained. Never
  a project that has merely been funded, announced, or begun.
- policy: standards, law, or an official decision.
- event: a dated happening.
- resource: a program, tool, or material that a student, teacher, or member of
  the public can actually use.
Use exactly one of the five values.

Set "inScope" to false if, now that you have read the page, it turns out to be a
funding, grant, award, or contract announcement rather than a finding, an
education story, a policy decision, an event, or a usable resource. Judge this
from the page itself, not from the candidate description. An item marked out of
scope is discarded, so err toward false when the page is mostly about money
being awarded.

"claims" must cover the whole draft, not a selection from it. Every factual
assertion in your title, summary, and body needs an entry, including every
number, figure, date, grade level, and institution name. If you cannot supply a
verbatim quote for something, remove it from the draft rather than leaving it
unlisted. The reviewer checks the draft by reading these quotes, so anything not
listed reaches them unverified while looking verified. The quotes must be
verbatim from the page you read.`;

  const tools = [
    {
      type: 'web_fetch_20250910',
      name: 'web_fetch',
      max_uses: 6,
      max_content_tokens: 40000,
    },
    // Needed for the fallback: finding a readable account of the same story
    // when the institution's own page cannot be fetched.
    { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
  ];
  const res = await callAnthropic({ system, userText, tools, maxTokens: 6000 });
  const parsed = extractJson(res.text);
  return { draft: parsed, usage: res.usage };
}

/* -------------------------------------------------------------- validation */

/**
 * The build enforces the schema, so an invalid item must never reach a branch.
 * A category violation in particular fails the Astro build outright. Items that
 * fail here are dropped and reported, never repaired by guessing.
 */
function validateDraft(d) {
  const errors = [];
  const warnings = [];

  const title = sanitizeText(d.title);
  const summary = sanitizeText(d.summary);
  const body = sanitizeText(d.body);
  const sourceName = sanitizeText(d.sourceName);
  const location =
    d.location && String(d.location).trim() && !/^(null|n\/a|unknown|tbd)$/i.test(String(d.location).trim())
      ? sanitizeText(d.location)
      : null;
  const missionSentence =
    d.missionSentence && String(d.missionSentence).trim() && !/^null$/i.test(String(d.missionSentence).trim())
      ? sanitizeText(d.missionSentence)
      : null;

  if (!title) errors.push('title is empty');
  if (!summary) errors.push('summary is empty');
  if (!body) errors.push('body is empty');
  if (!sourceName) errors.push('sourceName is empty');

  if (!CATEGORIES.includes(d.category)) {
    errors.push('category "' + d.category + '" is not one of ' + CATEGORIES.join(', '));
  }

  if (!isIsoDate(d.date)) {
    errors.push('date "' + d.date + '" is not a valid YYYY-MM-DD date');
  } else {
    const t = today();
    if (d.date > t) warnings.push('date is in the future relative to the run date');
    if (d.date < daysAgo(365)) warnings.push('date is more than a year old');
  }

  let source = String(d.source || '').trim();
  try {
    const u = new URL(source);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('source is not an http(s) URL');
    source = u.toString();
  } catch {
    errors.push('source "' + source + '" is not a valid URL');
  }

  // Optional. A bad value here is dropped rather than failing the item, since
  // it is a courtesy link and not the source the claims were checked against.
  let originalUrl = null;
  let originalName = null;
  const rawOriginal = String(d.originalAnnouncementUrl || '').trim();
  if (rawOriginal && !/^(null|n\/a|none)$/i.test(rawOriginal)) {
    try {
      const u = new URL(rawOriginal);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && normalizeUrl(rawOriginal) !== normalizeUrl(d.source)) {
        originalUrl = u.toString();
        originalName = sanitizeText(d.originalAnnouncementName || '') || 'the original announcement';
      }
    } catch {
      warnings.push('originalAnnouncementUrl was not a valid URL and was dropped');
    }
  }

  const allText = [title, summary, body, missionSentence || ''].join(' ');
  if (/[—–]/.test(allText)) errors.push('an em or en dash survived sanitising');
  if (/\bprove[dsn]?\b|\bproof\b/i.test(allText)) {
    warnings.push('uses "prove" or "proof", check the wording against house style');
  }

  // Numbers are where unsourced background gives itself away. Anything numeric in
  // the draft that appears nowhere in the claims or their quotes is flagged for
  // the reviewer. This is the check that would have caught a draft asserting
  // "grades 3 through 8" from the model's own knowledge rather than the source.
  const numbersIn = (t) =>
    (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/[,]/g, ''));

  const claims = Array.isArray(d.claims)
    ? d.claims
        .filter((c) => c && c.claim)
        .map((c) => ({ claim: sanitizeText(c.claim), quote: sanitizeText(c.quote || '') }))
    : [];
  if (claims.length === 0) warnings.push('the model listed no verifiable claims');

  const unsupported = Array.isArray(d.unsupported)
    ? d.unsupported.filter(Boolean).map((u) => sanitizeText(u))
    : [];

  const supportText = claims.map((c) => c.claim + ' ' + c.quote).join(' ') + ' ' + String(d.date || '');
  const supported = new Set(numbersIn(supportText));
  const unbacked = [...new Set(numbersIn([title, summary, body].join(' ')))].filter(
    (n) => !supported.has(n)
  );
  if (unbacked.length) {
    warnings.push(
      'these numbers appear in the draft but in none of the quotes: ' + unbacked.join(', ')
    );
  }

  const inScope = d.inScope !== false;
  const verified = d.verified === true && claims.length > 0;
  if (!verified) warnings.push('the model did not confirm it read the source');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    item: {
      title,
      date: d.date,
      category: d.category,
      source,
      sourceName,
      originalUrl,
      originalName,
      location,
      summary,
      body,
      missionSentence,
      claims,
      unsupported,
      verified,
      inScope,
      fetchNote: sanitizeText(d.fetchNote || ''),
    },
  };
}

/* ----------------------------------------------------------------- output */

function buildMarkdown(item) {
  // Structural guarantee, not a stylistic one. An item the drafting pass could
  // not verify against a fetched source must never reach a branch, where it
  // would sit one tap away from publication. Callers drop these upstream; this
  // throw is here so a future change cannot quietly reopen the path.
  if (!item.verified) {
    throw new Error('Refusing to write an unverified item: ' + item.title);
  }
  const lines = ['---'];
  lines.push('title: ' + yamlString(item.title));
  lines.push('date: ' + item.date);
  lines.push('category: ' + item.category);
  lines.push('source: ' + yamlString(item.source));
  lines.push('sourceName: ' + yamlString(item.sourceName));
  if (item.location) lines.push('location: ' + yamlString(item.location));
  lines.push('summary: ' + yamlString(item.summary));
  lines.push('---');
  lines.push('');
  lines.push(item.body);
  lines.push('');
  lines.push('Read the [source](' + item.source + ').');
  if (item.originalUrl) {
    lines.push('');
    lines.push('Original announcement: [' + item.originalName + '](' + item.originalUrl + ').');
  }
  if (item.missionSentence) {
    lines.push('');
    lines.push(item.missionSentence);
  }
  lines.push('');
  return lines.join('\n');
}

function buildPrBody(results, meta) {
  const kept = results.filter((r) => r.kept);

  const out = [];
  if (NOTIFY_HANDLE) {
    out.push('@' + NOTIFY_HANDLE + ' news drafts are ready for your review.');
    out.push('');
  }
  out.push('Automated news curation, run of ' + today() + '.');
  out.push('');
  out.push(
    kept.length +
      (kept.length === 1 ? ' item drafted.' : ' items drafted.') +
      ' Nothing here is published until this pull request is merged.'
  );
  out.push('');
  out.push('Every item below was drafted from a source page the run actually read. Anything it could not read was discarded and is not here.');
  out.push('');
  out.push('**How to review on a phone.** For each item, open the source link, confirm the quoted lines are really on that page, and tick the boxes. If something is wrong, edit the file on this branch with the pencil icon, or close this pull request. Merging deploys the site.');
  out.push('');

  kept.forEach((r, idx) => {
    const it = r.item;
    out.push('---');
    out.push('');
    out.push('### ' + (idx + 1) + '. ' + it.title);
    out.push('');
    out.push('`' + r.file + '`');
    out.push('');
    out.push(
      'Category `' + it.category + '`  |  Date ' + it.date + (it.location ? '  |  ' + it.location : '')
    );
    out.push('');
    out.push('Source: [' + it.sourceName + '](' + it.source + ')');
    if (it.originalUrl) {
      out.push('');
      out.push(
        'Original announcement, which could not be read automatically: [' +
          it.originalName + '](' + it.originalUrl + ')'
      );
    }
    out.push('');
    out.push('> ' + it.summary);
    out.push('');
    out.push('Verify before merging:');
    out.push('');
    out.push('- [ ] The link opens, and the page is a reputable source, not an aggregator or an AI summary');
    out.push('- [ ] `' + it.date + '` is the date of the announcement or event, not the date this ran');
    out.push('- [ ] `' + it.category + '` is the right category');
    it.claims.forEach((c) => {
      const quote = c.quote
        ? '<br>Source says: "' + c.quote + '"'
        : '<br>No supporting quote was given, check this against the page yourself.';
      out.push('- [ ] ' + c.claim + quote);
    });
    if (it.unsupported.length) {
      out.push('');
      out.push('Dropped as unsupported by the source:');
      it.unsupported.forEach((u) => out.push('- ' + u));
    }
    if (r.warnings.length) {
      out.push('');
      out.push('Flags: ' + r.warnings.join('; '));
    }
    out.push('');
  });

  const dropped = results.filter((r) => !r.kept && !r.silent);
  if (dropped.length) {
    out.push('---');
    out.push('');
    out.push('### Not included');
    out.push('');
    dropped.forEach((r) => {
      out.push('- ' + (r.headline || 'untitled') + ': ' + r.reason);
    });
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('Curation notes: ' + (meta.notes || 'none'));
  out.push('');
  out.push(
    'Model `' + MODEL + '`. Run [' + (process.env.GITHUB_RUN_ID || 'local') + ']' +
      (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? '(' + process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID + ')'
        : '') + '.'
  );
  out.push('');
  out.push('Generated by `scripts/curate-news.mjs`. The curation and drafting rules live in that file.');
  return out.join('\n');
}

async function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  await appendFile(file, key + '=' + value + '\n');
}

/* ------------------------------------------------------------------- main */

async function main() {
  log('Curation run ' + today() + ', model ' + MODEL + ', max ' + MAX_ITEMS + ' items.');

  const published = await loadPublished();
  await loadPending(published);
  log('Known items: ' + published.urls.size + ' source URLs, ' + published.slugs.size + ' published files.');

  const { items: candidates, notes } = await curate(published);
  log('Curation returned ' + candidates.length + ' candidate(s).');
  if (notes) log('Notes: ' + notes);

  const results = [];
  const usedSlugs = new Set(published.slugs);

  for (const candidate of candidates.slice(0, MAX_ITEMS)) {
    const headline = candidate.headline || candidate.sourceUrl || 'untitled';

    if (!candidate.sourceUrl) {
      results.push({ kept: false, headline, reason: 'no source URL returned' });
      continue;
    }
    const urlKey = normalizeUrl(candidate.sourceUrl);
    if (published.urls.has(urlKey)) {
      results.push({ kept: false, headline, reason: 'already on the site or in an open pull request' });
      continue;
    }
    if (published.titles.has(normalizeTitle(headline))) {
      results.push({ kept: false, headline, reason: 'duplicate headline' });
      continue;
    }

    let drafted;
    try {
      drafted = await draftItem(candidate);
    } catch (err) {
      results.push({ kept: false, headline, reason: 'drafting failed: ' + err.message });
      continue;
    }

    const checked = validateDraft(drafted.draft);
    if (!checked.ok) {
      results.push({ kept: false, headline, reason: 'failed schema validation: ' + checked.errors.join('; ') });
      continue;
    }

    const item = checked.item;

    // Two gates, both applied after the page was read. Neither is surfaced in
    // the pull request body: an item that fails here is not a candidate the
    // reviewer needs to see, and listing it would only invite second guessing
    // of a decision made for want of evidence. Both are logged to the run.
    if (!item.verified) {
      results.push({
        kept: false,
        silent: true,
        headline,
        reason: 'could not be verified against a fetched source, discarded',
      });
      continue;
    }
    if (!item.inScope) {
      results.push({
        kept: false,
        silent: true,
        headline,
        reason: 'out of scope on reading the source, most likely a funding announcement',
      });
      continue;
    }

    const finalUrlKey = normalizeUrl(item.source);
    if (published.urls.has(finalUrlKey)) {
      results.push({ kept: false, headline, reason: 'the fetched source is already on the site' });
      continue;
    }

    let slug = item.date + '-' + (slugify(item.title) || 'news-item');
    let n = 2;
    while (usedSlugs.has(slug)) slug = item.date + '-' + slugify(item.title) + '-' + n++;
    usedSlugs.add(slug);
    published.urls.add(finalUrlKey);
    published.titles.add(normalizeTitle(item.title));

    const file = 'src/content/news/' + slug + '.md';
    if (!DRY_RUN) await writeFile(path.join(ROOT, file), buildMarkdown(item), 'utf8');
    log((DRY_RUN ? 'Would write ' : 'Wrote ') + file);

    results.push({ kept: true, headline, file, item, warnings: checked.warnings });
  }

  const kept = results.filter((r) => r.kept);
  await writeFile(path.join(ROOT, PR_BODY_FILE), buildPrBody(results, { notes }), 'utf8');

  await setOutput('item_count', String(kept.length));
  await setOutput('discarded_count', String(results.filter((r) => r.silent).length));

  // Everything dropped is logged here, including the silent drops that never
  // reach the pull request. This is where to look when a run finds nothing.
  for (const r of results.filter((x) => !x.kept)) {
    log('  dropped: ' + r.headline + ' (' + r.reason + ')');
  }
  if (kept.length === 0) {
    log('Nothing cleared the bar. No pull request will be opened.');
  } else {
    log(kept.length + ' item(s) ready for review.');
  }
}

// Only run when invoked directly, so the helpers above stay importable for tests.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Curation run failed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
export { validateDraft, buildMarkdown, buildPrBody, normalizeUrl, slugify, sanitizeText, parseFrontmatter };
