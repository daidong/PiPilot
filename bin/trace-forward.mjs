#!/usr/bin/env node

/**
 * Trace forwarder — reads `.research-pilot/traces/spans.{date}.jsonl` and
 * POSTs OTLP/JSON ResourceSpans envelopes to an external receiver.
 *
 * Usage:
 *   trace-forward <projectPath> <endpoint>             # one-shot replay
 *   trace-forward <projectPath> <endpoint> --follow    # tail today's file
 *
 * Endpoints:
 *   http://localhost:6006/v1/traces  → Arize Phoenix (recommended for LLM traces)
 *   http://localhost:4318/v1/traces  → OpenTelemetry Collector / Jaeger / Tempo
 *
 * Flags:
 *   --follow / -f          tail mode (cleanly stops on Ctrl+C)
 *   --header "K=V" / -H    extra HTTP header (auth tokens, etc.)
 *   --batch N              envelopes per request (default 100)
 *   --timeout MS           per-batch timeout (default 5000)
 *   --no-cursor            don't persist .forward-cursor.json (re-posts everything)
 *   --quiet / -q           suppress progress output
 *   --verbose / -v         per-file diagnostics
 *
 * Cursor: stored at `.research-pilot/traces/.forward-cursor.json`. Re-runs
 * resume where they left off — no duplicate POSTs.
 *
 * Run via npm:
 *   npm run trace-forward -- <projectPath> http://localhost:6006/v1/traces --follow
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const tsEntry = join(repoRoot, 'lib/telemetry/forwarder/cli-impl.ts')
const tsxBin = join(repoRoot, 'node_modules/.bin/tsx')

const result = spawnSync(tsxBin, [tsEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: repoRoot
})
process.exit(result.status ?? 0)
