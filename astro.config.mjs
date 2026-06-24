// @ts-check
import { defineConfig } from 'astro/config';

// Served at the apex domain georgiascience.org, at the root.
// No `base` path is needed because this is a custom-domain deploy,
// not a project-subpath (username.github.io/repo) deploy.
export default defineConfig({
  site: 'https://georgiascience.org',
});
