import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared-electron': resolve(__dirname, '../shared-electron'),
        '@personal-assistant': resolve(__dirname, 'src/agent'),
        '@framework': resolve(__dirname, '../../src')
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
