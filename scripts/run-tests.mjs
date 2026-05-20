#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * Why this exists: `npm test` previously passed glob patterns like
 *   node --import tsx --test lib/telemetry/__tests__/*.test.ts ...
 *
 * On macOS/Linux the shell expands `*.test.ts` before invocation. On
 * Windows PowerShell (which GitHub Actions windows-latest uses) globs
 * are passed literally to Node, which then errors with
 *   "Could not find 'D:\...\__tests__\*.test.ts'"
 *
 * Node 22+ has native glob support in `--test` but CI runs Node 20
 * (.github/workflows/ci.yml) and tsx's loader doesn't change Node's
 * file-discovery rules — it only translates .ts at runtime.
 *
 * This wrapper walks the configured test directories, collects matching
 * files, and spawns the same `node --import tsx --test ...` command with
 * an explicit file list. Cross-platform, pure stdlib, no new deps.
 *
 * Behavior:
 *   node scripts/run-tests.mjs              → runs all configured suites
 *   node scripts/run-tests.mjs <suite>...   → runs a subset by suite key
 *
 * Suites are defined below. Each suite is a directory whose `*.test.ts`
 * descendants are collected (recursive). Adding a new test file under a
 * configured directory needs no changes here.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

/**
 * Map of suite key → directory (relative to repo root).
 * Each directory is walked recursively for `*.test.ts` files.
 */
const SUITES = {
  telemetry: 'lib/telemetry/__tests__',
  diagnostics: 'lib/telemetry/diagnostics/__tests__',
  forwarder: 'lib/telemetry/forwarder/__tests__',
  ledger: 'lib/ledger/__tests__',
  'memory-v2': 'lib/memory-v2/__tests__',
  memory: 'lib/memory/__tests__',
  agents: 'lib/agents/__tests__',
  'diagram-backends': 'lib/tools/diagram-backends/__tests__',
  importers: 'lib/importers/__tests__',
  reports: 'lib/reports/__tests__',
  compute: 'lib/compute',
  aws: 'lib/aws/__tests__',
  'aws-ec2': 'lib/aws-ec2-compute/__tests__',
  utils: 'lib/utils/__tests__',
  'shared-electron': 'shared-electron/__tests__',
  renderer: 'app/src/renderer/stores/__tests__'
}

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out // tolerant: missing directories are silently skipped
  }
  for (const name of entries) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full))
    } else if (st.isFile() && name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

const requested = process.argv.slice(2)
const suiteKeys = requested.length > 0 ? requested : Object.keys(SUITES)

const files = []
for (const key of suiteKeys) {
  const rel = SUITES[key]
  if (!rel) {
    console.error(`Unknown test suite: ${key}`)
    console.error(`Available: ${Object.keys(SUITES).join(', ')}`)
    process.exit(2)
  }
  const abs = join(repoRoot, rel)
  const found = walk(abs)
  if (found.length === 0) {
    console.error(`No *.test.ts files found in ${rel}`)
  }
  files.push(...found)
}

if (files.length === 0) {
  console.error('No test files to run.')
  process.exit(1)
}

// Use forward slashes — Node test runner accepts them on Windows.
const args = ['--import', 'tsx', '--test', ...files.map(f => f.split(sep).join('/'))]
const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repoRoot })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
