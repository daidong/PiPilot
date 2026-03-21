import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Output ESM so external pi-mono packages (pure ESM) are import()'d, not require()'d
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: '[name].mjs'
        }
      }
    },
    resolve: {
      alias: {
        '@shared-electron': resolve(__dirname, '../shared-electron'),
        '@research-pilot': resolve(__dirname, '../lib')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, '../shared-ui'),
        '@': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
