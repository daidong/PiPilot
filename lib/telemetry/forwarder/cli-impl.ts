/**
 * Trace forwarder CLI implementation (run via bin/trace-forward.mjs → tsx).
 *
 * Usage examples (also documented in the wrapper):
 *   trace-forward <projectPath> <endpoint>
 *   trace-forward <projectPath> <endpoint> --follow
 *   trace-forward <projectPath> <endpoint> --header "Authorization=Bearer x"
 *
 * Endpoint examples:
 *   http://localhost:6006/v1/traces            # Phoenix
 *   http://localhost:4318/v1/traces            # OTel Collector / Jaeger / Tempo
 */

import { existsSync } from 'node:fs'
import { replayAll, follow } from './forwarder.js'

interface CliArgs {
  projectPath: string
  endpoint: string
  follow: boolean
  headers: Record<string, string>
  batchSize?: number
  timeoutMs?: number
  noCursor: boolean
  verbosity: 'quiet' | 'normal' | 'verbose'
  encoding: 'proto' | 'json'
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  if (argv.length === 0) {
    return {
      error:
        'Usage: trace-forward <projectPath> <endpoint> [--follow] [--json] [--header "K=V" ...] [--batch N] [--timeout MS] [--no-cursor] [--quiet|--verbose]'
    }
  }
  const positional: string[] = []
  let followMode = false
  let noCursor = false
  let verbosity: CliArgs['verbosity'] = 'normal'
  let encoding: 'proto' | 'json' = 'proto'
  const headers: Record<string, string> = {}
  let batchSize: number | undefined
  let timeoutMs: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--follow' || arg === '-f') followMode = true
    else if (arg === '--no-cursor') noCursor = true
    else if (arg === '--quiet' || arg === '-q') verbosity = 'quiet'
    else if (arg === '--verbose' || arg === '-v') verbosity = 'verbose'
    else if (arg === '--json') encoding = 'json'
    else if (arg === '--proto') encoding = 'proto'
    else if (arg === '--header' || arg === '-H') {
      const next = argv[++i]
      if (!next) return { error: '--header requires "K=V"' }
      const eq = next.indexOf('=')
      if (eq < 0) return { error: `--header value must be K=V, got: ${next}` }
      headers[next.slice(0, eq).trim()] = next.slice(eq + 1).trim()
    } else if (arg === '--batch') {
      const n = Number.parseInt(argv[++i] ?? '', 10)
      if (!Number.isFinite(n) || n < 1) return { error: '--batch must be a positive integer' }
      batchSize = n
    } else if (arg === '--timeout') {
      const n = Number.parseInt(argv[++i] ?? '', 10)
      if (!Number.isFinite(n) || n < 100) return { error: '--timeout must be ≥ 100 ms' }
      timeoutMs = n
    } else if (arg.startsWith('--')) {
      return { error: `Unknown flag: ${arg}` }
    } else {
      positional.push(arg)
    }
  }
  if (positional.length < 2) return { error: 'projectPath and endpoint are required' }
  if (positional.length > 2) return { error: 'too many positional arguments' }
  const [projectPath, endpoint] = positional as [string, string]
  if (!existsSync(projectPath)) return { error: `projectPath does not exist: ${projectPath}` }
  if (!/^https?:\/\//.test(endpoint)) return { error: `endpoint must start with http:// or https://: ${endpoint}` }
  return { projectPath, endpoint, follow: followMode, headers, batchSize, timeoutMs, noCursor, verbosity, encoding }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(parsed.error)
    return 64
  }
  const opts = {
    projectPath: parsed.projectPath,
    endpoint: parsed.endpoint,
    headers: parsed.headers,
    batchSize: parsed.batchSize,
    timeoutMs: parsed.timeoutMs,
    persistCursor: !parsed.noCursor,
    verbosity: parsed.verbosity,
    encoding: parsed.encoding
  }
  if (!parsed.follow) {
    const r = await replayAll(opts)
    if (parsed.verbosity !== 'quiet') {
      console.log(
        `\nDone. Posted ${r.envelopesPosted} envelope(s), ${r.bytesPosted} bytes, ${r.filesProcessed} file(s), ${r.errors} error(s).`
      )
    }
    return r.errors > 0 ? 1 : 0
  }
  if (parsed.verbosity !== 'quiet') {
    console.log(`Tailing ${parsed.projectPath} → ${parsed.endpoint} (Ctrl+C to stop)`)
  }
  // Default keepAlive: true keeps fs.watch + poll timer ref'd so the CLI
  // process stays alive until SIGINT.
  const handle = await follow(opts)
  return new Promise<number>((resolve) => {
    const onSig = () => {
      void handle.stop().then(() => {
        if (parsed.verbosity !== 'quiet') {
          console.log(
            `\nStopped. Posted ${handle.result.envelopesPosted} envelope(s), ${handle.result.errors} error(s).`
          )
        }
        resolve(handle.result.errors > 0 ? 1 : 0)
      })
    }
    process.once('SIGINT', onSig)
    process.once('SIGTERM', onSig)
  })
}

void main().then((code) => process.exit(code))
