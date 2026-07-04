import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
import path from 'path';
// @astrojs/sitemap is pinned to exactly 3.2.1 in package.json (no ^) —
// versions 3.6+ throw "Cannot read properties of undefined (reading 'reduce')"
// at build time against this project's Astro 4.16.19. Don't `npm update` this
// package without retesting a full build.
import sitemap from '@astrojs/sitemap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://beyondparadiseadventures.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [sitemap()],
  vite: {
    resolve: {
      alias: {
        '@data': path.resolve(__dirname, '../data'),
      },
    },
  },
});
