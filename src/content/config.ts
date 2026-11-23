import { defineCollection, z } from 'astro:content';

// News collection. The schema validates every news item's frontmatter at
// build time, so a malformed or miscategorized entry fails the build rather
// than shipping. This matches the news-item template exactly.
const news = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    // Controlled vocabulary. Anything outside this set fails the build.
    category: z.enum(['scholarship', 'discovery', 'policy', 'event', 'resource', 'watch']),
    source: z.string().url(),
    sourceName: z.string(),
    location: z.string().optional(),
    summary: z.string(),
    // Optional topic illustration for link previews (Facebook, LinkedIn).
    // A site path starting with /news-images/, e.g.
    // /news-images/2026-11-19-georgias-measles-cases-reach-28-for.jpg
    // Items without it fall back to the site logo.
    image: z.string().startsWith('/news-images/').optional(),
  }),
});

// Resources collection. Optional, for curated resource link entries.
const resources = defineCollection({
  type: 'content',
  schema: z.object({
    name: z.string(),
    description: z.string(),
    audience: z.string(),       // who it is for
    rationale: z.string(),      // why it is included
    url: z.string().url(),
    section: z.enum([
      'national',
      'georgia',
      'educators',
      'students',
      'critical-thinking',
    ]),
  }),
});

export const collections = { news, resources };
