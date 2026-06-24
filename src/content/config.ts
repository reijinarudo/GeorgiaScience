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
    category: z.enum(['scholarship', 'discovery', 'policy', 'event', 'resource']),
    source: z.string().url(),
    sourceName: z.string(),
    location: z.string().optional(),
    summary: z.string(),
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
