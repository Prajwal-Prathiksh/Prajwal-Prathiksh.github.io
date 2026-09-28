// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://prajwal-prathiksh.github.io',
  integrations: [sitemap()],
  // Old URLs from the previous Jekyll site.
  redirects: {
    '/publications': '/#publications',
    '/resume': '/documents/prajwal-resume.pdf',
  },
});
