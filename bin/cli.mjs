#!/usr/bin/env node

/**
 * CLI entry point for Research Copilot.
 *
 * Usage:
 *   npm i -g research-copilot       # Install globally
 *   research-copilot                # Then run anywhere
 */

import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, chmodSync, readdirSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

// Resolve the Electron binary
let electronPath
try {
  electronPath = String(require('electron'))
} catch {
  console.error('Error: Electron is not installed. Run: npm install')
  process.exit(1)
}

if (!existsSync(electronPath)) {
  console.error(`Error: Electron binary not found at ${electronPath}`)
  process.exit(1)
}

// The app entry is at ../app/ (has package.json with "main" pointing to built output)
const appDir = join(__dirname, '..', 'app')
const mainEntry = join(appDir, 'out', 'main', 'index.mjs')

if (!existsSync(mainEntry)) {
  console.error(`Error: App not built. Expected: ${mainEntry}`)
  process.exit(1)
}

// Fix node-pty spawn-helper permissions (npm strips executable bit during pack/install)
const ptyPrebuilds = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(ptyPrebuilds)) {
  try {
    for (const platform of readdirSync(ptyPrebuilds)) {
      const helper = join(ptyPrebuilds, platform, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  } catch { /* best-effort */ }
}

console.log('Starting Research Copilot...')

// Ensure Electron's main process can resolve npm dependencies (e.g. node-pty)
// that live in the package root's node_modules, not inside app/.
const pkgNodeModules = join(__dirname, '..', 'node_modules')
const nodePath = process.env.NODE_PATH
  ? `${pkgNodeModules}:${process.env.NODE_PATH}`
  : pkgNodeModules

// Launch Electron with the app directory
const child = spawn(electronPath, [appDir], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, NODE_PATH: nodePath },
})

child.on('close', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('Failed to start Electron:', err.message)
  process.exit(1)
})

// Forward signals to Electron
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
