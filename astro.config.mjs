import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://beyondparadise.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [],
});
