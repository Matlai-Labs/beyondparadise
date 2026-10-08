import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
// @astrojs/sitemap is pinned to exactly 3.2.1 in package.json (no ^) —
// versions 3.6+ throw "Cannot read properties of undefined (reading 'reduce')"
// at build time against this project's Astro 4.16.19. Don't `npm update` this
// package without retesting a full build.
import sitemap from '@astrojs/sitemap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- sitemap <lastmod>: frontmatter last_updated for content pages, git commit date for the rest ----
const SITE = 'https://beyondparadiseadventures.com';
function gitDate(rel) {
  try {
    const d = execSync('git log -1 --format=%cs -- ' + rel, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return d || undefined;
  } catch { return undefined; }
}
const lastmodByUrl = new Map();
const contentDir = path.join(__dirname, 'src', 'content');
for (const col of fs.readdirSync(contentDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
  for (const f of fs.readdirSync(path.join(contentDir, col.name)).filter(n => n.endsWith('.md'))) {
    const fm = fs.readFileSync(path.join(contentDir, col.name, f), 'utf8').split('---')[1] ?? '';
    const permalink = fm.match(/^permalink:\s*"([^"]+)"/m)?.[1];
    const updated = fm.match(/^last_updated:\s*"?([0-9-]{10})"?/m)?.[1];
    if (permalink && updated) lastmodByUrl.set(SITE + permalink, updated);
  }
}
const factsDate = gitDate('../data/facts/facts.json');
const staticPages = {
  '/': 'src/pages/index.astro',
  '/about/': 'src/pages/about/index.astro',
  '/about/tim-score/': 'src/pages/about/tim-score/index.astro',
  '/about/editorial-policy/': 'src/pages/about/editorial-policy/index.astro',
  '/reviews/': 'src/pages/reviews/index.astro',
  '/excursions/': 'src/pages/excursions/index.astro',
  '/intelligence/migration-calendar/': 'src/pages/intelligence/migration-calendar/index.astro',
  '/intelligence/east-africa-tourism-stats/': 'src/pages/intelligence/east-africa-tourism-stats/index.astro',
};
for (const [url, file] of Object.entries(staticPages)) {
  const dates = [gitDate(file)];
  if (url.startsWith('/intelligence/')) dates.push(factsDate);
  const d = dates.filter(Boolean).sort().pop();
  if (d) lastmodByUrl.set(SITE + url, d);
}

export default defineConfig({
  site: 'https://beyondparadiseadventures.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [sitemap({
    serialize(item) {
      const d = lastmodByUrl.get(item.url);
      if (d) item.lastmod = new Date(d + 'T00:00:00Z').toISOString();
      return item;
    },
  })],
  vite: {
    resolve: {
      alias: {
        '@data': path.resolve(__dirname, '../data'),
      },
    },
  },
});
