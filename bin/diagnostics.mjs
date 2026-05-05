#!/usr/bin/env node

/**
 * Telemetry diagnostics CLI (P3.8).
 *
 * Reads `.research-pilot/traces/spans.{date}.jsonl` for a project and runs the
 * built-in rule set (lib/telemetry/diagnostics/rules.ts). Two modes:
 *
 *   node bin/diagnostics.mjs <projectPath>
 *     → Scan the last 1 day of traces, build a baseline, run rules per trace,
 *       summarize findings by rule. Defaults to human output.
 *
 *   node bin/diagnostics.mjs <projectPath> <traceId>
 *     → Detailed per-finding output for a single trace. Useful when the
 *       summary mode flagged something and you want to drill in.
 *
 *   --json     emit JSON instead of human text
 *   --days N   include the last N days of traces (default: 1 for scan, 7 for single-trace lookup)
 *
 * The CLI is dependency-free TypeScript-via-tsx (loaded by the wrapper) so it
 * works wherever Node 20+ does. No Electron, no IPC.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// Rather than reimplementing the rule loop in JS, defer to the TS module via
// a child node process running tsx. Keeps the CLI thin and aligned with the
// implementation tree (which is canonical TypeScript).
const tsEntry = join(repoRoot, 'lib/telemetry/diagnostics/cli-impl.ts')
const tsxBin = join(repoRoot, 'node_modules/.bin/tsx')

const result = spawnSync(tsxBin, [tsEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: repoRoot
})
process.exit(result.status ?? 0)
