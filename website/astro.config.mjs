// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://dir-lab.github.io',
  base: '/Research-Pilot/',
  vite: {
    plugins: [tailwindcss()]
  }
});
