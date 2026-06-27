import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://beyondparadise.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [],
  vite: {
    resolve: {
      alias: {
        '@data': path.resolve(__dirname, '../data'),
      },
    },
  },
});
