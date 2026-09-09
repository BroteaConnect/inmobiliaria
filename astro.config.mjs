import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';

// React integration lets Astro render feature components as islands
// (client:load), so a feature's React UI is shared with the `react` stack.
//
// Hybrid rendering: everything stays prerendered exactly as before (the
// catalogue, the legal pages, every /en/* route) and is served as static
// files by the node adapter; ONLY the property page opts out with
// `export const prerender = false`, because the CRM publishes listings every
// day and a route baked at build time would 404 each new one until somebody
// redeployed. `site` keeps hreflang, canonical and og:url absolute.
//
// No `security.checkOrigin` override: the lead form posts from the browser
// straight to PocketBase and to api.brotea.dev, so no Astro route ever
// handles a form POST and the built-in origin check has nothing to block.
export default defineConfig({
  site: 'https://inmobiliaria.brotea.dev',
  integrations: [react()],
  output: 'static',
  adapter: node({ mode: 'standalone' }),
});
