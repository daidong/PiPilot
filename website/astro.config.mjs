// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Site URL + base path are read from env so the same source can be built
// against multiple Pages targets during the dual-repo transition. Defaults
// are the canonical DIR-LAB/Research-Pilot deployment.
const site = process.env.SITE_URL || 'https://dir-lab.github.io';
const base = process.env.SITE_BASE || '/Research-Pilot/';

// https://astro.build/config
export default defineConfig({
  site,
  base,
  vite: {
    plugins: [tailwindcss()]
  }
});
