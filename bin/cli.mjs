#!/usr/bin/env node

/**
 * CLI entry point for Research Copilot.
 *
 * Usage:
 *   npx research-copilot            # Run directly
 *   npm i -g research-copilot       # Install globally
 *   research-copilot                # Then run anywhere
 */

import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

// Resolve the Electron binary from this package's node_modules
let electronPath
try {
  electronPath = require('electron')
} catch {
  console.error(
    'Error: Electron is not installed.\n' +
    'Run: npm install\n'
  )
  process.exit(1)
}

// The app entry is at ../app/ (has package.json with "main" pointing to built output)
const appDir = join(__dirname, '..', 'app')
const mainEntry = join(appDir, 'out', 'main', 'index.mjs')

if (!existsSync(mainEntry)) {
  console.error(
    'Error: App has not been built yet.\n' +
    'Run: npm run build\n'
  )
  process.exit(1)
}

// Launch Electron with the app directory
const child = spawn(String(electronPath), [appDir], {
  stdio: 'inherit',
  env: { ...process.env },
})

child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('Failed to start Electron:', err.message)
  process.exit(1)
})
