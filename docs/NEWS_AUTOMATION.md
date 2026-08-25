# Automated news curation

This document describes the scheduled workflow that drafts News items for
review. Read the "What this deliberately does not do" section before changing
anything.

## What it does

Every Monday morning, a GitHub Actions workflow:

1. Reads every item already in `src/content/news/`, plus every item sitting in an
   open automation pull request, so the same story does not resurface.
2. Calls the Anthropic API with server side web search to look for Georgia
   science education and science literacy news from the last 45 days.
3. For each candidate, makes a second call that fetches and reads the primary
   source, then drafts the item and reports which specific claims the source
   supports, with verbatim quotes.
4. Validates every draft against the collection schema in
   `src/content.config.ts`. An item that fails is dropped, never repaired by
   guessing.
5. Discards, without drafting a file, anything it could not verify against a
   page it actually read, and anything that turns out on reading to be a
   funding or award announcement rather than news. Both discards are logged in
   the run but are not shown in the pull request.
6. Runs `npm run build` with the drafts in place. If the build fails, no pull
   request is opened and the run fails loudly.
7. Opens a pull request containing the drafted `.md` files and a review
   checklist.

It never commits to `main`. Merging the pull request is the human gate, and the
merge is what triggers the existing deploy workflow.

If nothing clears the bar, no pull request is opened and no email is sent. The
run still appears in the Actions tab with a summary of what was searched.

## Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/news-curation.yml` | The scheduled job. |
| `.github/workflows/build-check.yml` | Runs the build on every pull request, so edits made in the web editor are checked too. |
| `scripts/curate-news.mjs` | The curation and drafting logic, and the schema validation. No npm dependencies. |
| `docs/NEWS_AUTOMATION.md` | This file. |

## Setup, in order

### 1. Confirm you will be notified

The workflow sends no email of its own. It opens a pull request and lets
GitHub's own notifications do the work, so there is nothing custom to maintain.

Two things in the workflow make that reliable without depending on your
repository Watch setting:

- The pull request body opens with `@reijinarudo`. A mention notifies you under
  GitHub's default "Participating and @mentions" setting.
- The pull request is assigned to you. Being assigned also notifies you under
  the default setting.

So the only thing to confirm is that GitHub has a working email address for you
and that email is switched on at all:

1. Go to `github.com/settings/notifications`.
2. Confirm the default notification email address at the top of the page is one
   you read on your phone.
3. Confirm email is enabled for participating and @mentions. The wording and
   layout of this page changes; look for the row about updates in repositories
   you are watching or conversations you are participating in, and make sure
   **Email** is ticked there.

Optional, as a second path: on the repository page, click **Watch**, then
**Custom**, tick **Pull requests**, and Apply. This is belt and braces. The
mention and the assignment already cover you.

### 2. Allow Actions to open pull requests

At **Settings, Actions, General**, under "Workflow permissions":

- Select **Read and write permissions**.
- Tick **Allow GitHub Actions to create and approve pull requests**.

Without the second box, the run fails at the pull request step with a 403.

### 3. Add the API key

Create an API key at the Anthropic Console, then at **Settings, Secrets and
variables, Actions, New repository secret**:

- Name: `ANTHROPIC_API_KEY`
- Value: the key

Set a monthly spend limit on the key in the console as a backstop.

### 4. Add the files

Add the four files listed above to the repository. Nothing else in the repository
changes.

### 5. First run, as a rehearsal

Go to **Actions, Weekly news curation, Run workflow**. Set **dry_run** to
`true`. This searches, drafts, and validates, but opens no pull request.

When it finishes, open the run and read the **Summary** at the bottom. That is
exactly what the pull request body would have said. If it looks right, run it
again with `dry_run` left at `false` and review the real pull request.

## Reviewing a pull request

The pull request body is the review surface. For each item it gives you the
headline, the category, the date, the source link, and a checklist of the
specific factual claims the draft makes, each paired with the verbatim line from
the source that supports it.

Open the source link. Confirm the quoted lines are actually on that page. That is
the whole job, and it is the part that cannot be automated: the model can fetch a
page, but "the page was fetched" is not "the page says what this draft claims".

- Everything checks out: tap **Merge**. The deploy workflow runs and the item is
  live in a few minutes.
- Something is wrong in one item: edit the file on the branch with the pencil
  icon, or delete that file from the branch, then merge the rest.
- The whole batch is wrong: close the pull request. Nothing was published. The
  branch can be deleted.

Everything in a pull request was drafted from a page the run actually opened and
read. If the drafting pass could not retrieve the source, the item is discarded
and never becomes a file, so there is nothing in a pull request that you could
merge without a source behind it. `buildMarkdown` in the script throws rather
than writing an unverified item, so a later change cannot quietly reopen that
path.

The cost of this is real and worth naming: occasionally a genuine story will be
dropped because a site blocked the fetch. The run log records what was
discarded and why, so you can look there if a week seems unusually quiet and
write the item up by hand.

## What counts as news here

Research funding is out of scope. A grant, award, or contract to a Georgia
institution is not a news item for this site, however large the figure. Money
changing hands is not a finding and it is not education. A funded project
becomes reportable when there is a result to explain.

This exclusion does more work than it appears to. Georgia universities publish
grant announcements constantly, and they are well written, locally relevant, and
easy to verify, which makes them exactly the kind of item that would crowd out
scarcer education stories in every run.

Student scholarships are a different matter and remain in scope. The distinction
is who receives the money: students, yes; researchers and institutions, no.

The rule is enforced twice, once in the curation search and again after the
source page has been read, since a headline does not always reveal that a story
is an award announcement.

## Cost

Roughly $0.20 to $0.50 per run at current pricing, so on the order of $1 to $2
per month at a weekly cadence. Web search is billed per search, currently $10 per
thousand, and the run makes up to ten. The rest is token cost for the search
results and fetched pages. Confirm the actual figure on the Anthropic Console
after a few runs rather than trusting this estimate.

## Changing the settings

| What | Where |
| --- | --- |
| Cadence | The `cron` line in `news-curation.yml`. It is UTC. `0 11 * * 1` is Monday 07:00 in Georgia during daylight saving time and 06:00 during standard time. |
| Maximum items per run | `NEWS_MAX_ITEMS` in `news-curation.yml`, currently 3. |
| How far back to search | `NEWS_LOOKBACK_DAYS`, currently 45. |
| Model | `NEWS_MODEL`, currently `claude-sonnet-5`. |
| Search targets, scope rules, house style | The `SCOPE_RULES`, `STYLE_RULES`, and prompt text in `scripts/curate-news.mjs`. |

Scheduled runs on GitHub Actions can be delayed under load, sometimes by an hour
or more. Nothing here depends on exact timing.

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| Run fails at "Open the review pull request" with a 403 | Step 2 of setup was not completed. |
| Run fails at "Curate and draft" with a 401 | The `ANTHROPIC_API_KEY` secret is missing, misspelled, or revoked. |
| Run fails at "Verify the site still builds" | A draft violated the schema in a way validation did not catch. Read the build log, then tighten the validation in `scripts/curate-news.mjs`. No pull request is opened, so nothing reached review. |
| Run succeeds, no pull request | Nothing cleared the bar. Read the run Summary to see what was searched and dropped. This is normal on quiet weeks. |
| A story you know about never appears | It may have been discarded as unverifiable or as a funding announcement. Open the run in the Actions tab and read the log of the "Curate and draft" step, which lists every dropped item and the reason. |
| Pull request opens but no email arrives | Check the default notification email at `github.com/settings/notifications`. The pull request mentions and assigns you, so a missing email is an address or delivery problem, not a Watch setting. |
| The same story appears twice | The second appearance used a different URL and a different headline. Add the URL to the item on the site, or close the duplicate. |

## What this deliberately does not do

- It does not commit to `main` and it cannot publish. The pull request is the
  gate, and that is the point. If you find yourself wanting to remove the gate,
  the site's credibility rests on modelling the verification it teaches.
- It does not pad to fill a quota. Zero items is a valid and expected result.
- It does not assert that a draft is true. It asserts that a page was fetched and
  that these lines appeared on it. The reviewer supplies the judgment.
- It does not draft an item it could not read the source for. Earlier versions
  wrote such items with an UNVERIFIED banner. That was wrong: an item nobody can
  verify should not sit in a pull request one tap away from publication.
