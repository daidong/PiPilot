import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: [
        '@mariozechner/pi-agent-core',
        '@mariozechner/pi-ai',
        '@mariozechner/pi-coding-agent',
        '@sinclair/typebox'
      ]
    })],
    build: {
      rollupOptions: {
        plugins: [
          // Redirect bare package imports from lib/ to app/node_modules
          {
            name: 'resolve-from-app-node-modules',
            resolveId(source, importer) {
              // Only intercept imports from files outside app/
              if (!importer || importer.includes('/app/node_modules/')) return null
              if (source.startsWith('@mariozechner/') || source.startsWith('@sinclair/')) {
                // Let Node's module resolution handle it from app/node_modules
                return this.resolve(source, resolve(__dirname, '_virtual_importer.js'), { skipSelf: true })
              }
              return null
            }
          }
        ]
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
        '@': resolve(__dirname, 'src/renderer'),
        // Ensure bare imports from shared-ui resolve from app/node_modules
        'zustand': resolve(__dirname, 'node_modules/zustand'),
        'lucide-react': resolve(__dirname, 'node_modules/lucide-react'),
        'react': resolve(__dirname, 'node_modules/react')
      }
    }
  }
})
