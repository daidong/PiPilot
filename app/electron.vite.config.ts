import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })],
    // Cast needed: electron-vite 5 declares BuildEnvironmentOptions from vite 7,
    // but vite resolves to 5.x here, so MainBuildOptions appears to lack
    // rollupOptions in the type graph. Runtime config is valid.
    build: {
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: '[name].mjs'
        }
      }
    } as any,
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
