/**
 * OTLP forwarder — pushes locally-stored OTLP/JSON ResourceSpans envelopes
 * to an external OTLP HTTP receiver (Phoenix, Jaeger, Tempo, OpenTelemetry
 * Collector, etc.). Two modes:
 *
 *   - replayAll(opts): walk every spans.{date}.jsonl in the project once,
 *     POST every envelope, exit. Idempotent on the "where I left off" cursor.
 *
 *   - follow(opts): start a watcher that tails today's spans.{date}.jsonl,
 *     POSTing each new line as it appears. Cleanup on signal. The TraceStore
 *     flushes at 200ms idle so end-to-end latency is ~0.5s.
 *
 * Cursor: per-target hash of the endpoint URL → byte offset per spans file.
 * Stored under `.research-pilot/traces/.forward-cursor.json`. On crash or
 * restart, the forwarder resumes where it left off — no duplicate POSTs to
 * the receiver.
 *
 * Format note: our JSONL is already a stream of OTLP `ResourceSpans` envelopes,
 * one per line. The OTLP/HTTP `/v1/traces` endpoint accepts a JSON body of
 * shape `{ resourceSpans: [...] }`. We batch lines into that wrapper.
 *
 * What this is NOT: a generic OTLP exporter sitting inside the agent runtime.
 * Spec v0.8 deliberately removed in-process OTLP because it's optional for
 * the local-first model. This forwarder is read-side only — it scans the
 * already-written JSONL the same way any other tool would.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  watch,
  mkdirSync,
  readdirSync,
  renameSync,
  openSync,
  readSync as fsReadSync,
  closeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

export interface ForwardOptions {
  /** Project root (contains `.research-pilot/traces/`). */
  projectPath: string
  /** OTLP HTTP traces endpoint, e.g. `http://localhost:6006/v1/traces` (Phoenix)
   *  or `http://localhost:4318/v1/traces` (Collector / Jaeger / Tempo). */
  endpoint: string
  /** Custom headers (auth tokens for hosted services like Honeycomb). */
  headers?: Record<string, string>
  /** Default 100. POST envelopes in chunks to bound memory + request size. */
  batchSize?: number
  /** Default 5000. Per-batch HTTP timeout in ms. */
  timeoutMs?: number
  /** Default true. Persist cursor so re-runs don't double-post. Disable for
   *  ephemeral tests. */
  persistCursor?: boolean
  /** Verbosity. Default 'normal'. 'quiet' suppresses progress prints. */
  verbosity?: 'quiet' | 'normal' | 'verbose'
  /** Inject for testing — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Inject for testing — defaults to Date.now. */
  nowMs?: () => number
}

export interface ForwardResult {
  envelopesPosted: number
  bytesPosted: number
  filesProcessed: number
  errors: number
}

interface CursorState {
  // endpointHash → { date(YYYY-MM-DD): byteOffset, ... }
  [endpointHash: string]: Record<string, number>
}

const CURSOR_FILENAME = '.forward-cursor.json'
const TRACES_DIR_REL = '.research-pilot/traces'

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}

function tracesDir(projectPath: string): string {
  return join(projectPath, TRACES_DIR_REL)
}

function cursorPath(projectPath: string): string {
  return join(tracesDir(projectPath), CURSOR_FILENAME)
}

function readCursor(projectPath: string): CursorState {
  const p = cursorPath(projectPath)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CursorState
  } catch {
    return {}
  }
}

function writeCursor(projectPath: string, state: CursorState): void {
  const p = cursorPath(projectPath)
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    // Atomic rename keeps the cursor file consistent under crashes.
    renameSync(tmp, p)
  } catch {
    // Cursor persistence is best-effort; failures don't block forwarding.
  }
}

function listSpanFiles(projectPath: string): Array<{ filePath: string; date: string }> {
  const dir = tracesDir(projectPath)
  if (!existsSync(dir)) return []
  try {
    const out: Array<{ filePath: string; date: string }> = []
    for (const f of readdirSync(dir)) {
      const m = f.match(/^spans\.(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (!m) continue
      out.push({ filePath: join(dir, f), date: m[1]! })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

function todaysSpansPath(projectPath: string): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return join(tracesDir(projectPath), `spans.${y}-${m}-${dd}.jsonl`)
}

/**
 * Read the slice of `filePath` from `fromOffset` to EOF. Returns the new
 * offset (current file size) and an array of complete JSONL lines. A
 * trailing partial line (writer mid-append) is left for next round.
 */
function readNewLines(filePath: string, fromOffset: number): { lines: string[]; newOffset: number } {
  if (!existsSync(filePath)) return { lines: [], newOffset: fromOffset }
  const size = statSync(filePath).size
  if (size === fromOffset) return { lines: [], newOffset: fromOffset }
  if (size < fromOffset) {
    // File rotated / truncated — restart from 0.
    return readNewLines(filePath, 0)
  }
  // Read just the slice we haven't seen.
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(size - fromOffset)
    fsReadSync(fd, buf, 0, buf.length, fromOffset)
    const text = buf.toString('utf8')
    // If the last char isn't a newline, the writer is mid-append. Hold the
    // partial fragment for next round by reporting offset = end-of-last-newline.
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) {
      // No newline at all in this slice — wait for more data.
      return { lines: [], newOffset: fromOffset }
    }
    const complete = text.slice(0, lastNl)
    const lines = complete.split('\n').filter((l) => l.length > 0)
    return { lines, newOffset: fromOffset + Buffer.byteLength(complete + '\n', 'utf8') }
  } finally {
    closeSync(fd)
  }
}

/**
 * POST `lines` (each is a serialized OTLP ResourceSpans envelope) to the
 * OTLP HTTP receiver. Returns true on 2xx, false otherwise.
 */
async function postBatch(
  endpoint: string,
  lines: string[],
  opts: { headers?: Record<string, string>; timeoutMs: number; fetchImpl: typeof fetch }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (lines.length === 0) return { ok: true }
  const resourceSpans: unknown[] = []
  for (const l of lines) {
    try {
      const env = JSON.parse(l) as { resource?: unknown; scopeSpans?: unknown[] }
      // Each line in our JSONL IS a ResourceSpans envelope. Concatenate.
      resourceSpans.push(env)
    } catch {
      // Skip malformed line — writer crash is the only legitimate cause.
    }
  }
  if (resourceSpans.length === 0) return { ok: true }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs)
  try {
    const res = await opts.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify({ resourceSpans }),
      signal: ctl.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: text.slice(0, 200) }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  if (n <= 0) return [xs]
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

function logLine(opts: ForwardOptions, level: 'normal' | 'verbose', line: string): void {
  const v = opts.verbosity ?? 'normal'
  if (v === 'quiet') return
  if (level === 'verbose' && v !== 'verbose') return
  // eslint-disable-next-line no-console
  console.log(line)
}

/**
 * Replay every envelope in every spans.{date}.jsonl file once. Persists
 * cursor so re-runs only forward what's new since last invocation.
 */
export async function replayAll(opts: ForwardOptions): Promise<ForwardResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const batchSize = opts.batchSize ?? 100
  const timeoutMs = opts.timeoutMs ?? 5000
  const persistCursor = opts.persistCursor ?? true
  const hash = endpointHash(opts.endpoint)

  const cursor = persistCursor ? readCursor(opts.projectPath) : {}
  cursor[hash] = cursor[hash] ?? {}

  const result: ForwardResult = { envelopesPosted: 0, bytesPosted: 0, filesProcessed: 0, errors: 0 }
  const files = listSpanFiles(opts.projectPath)
  if (files.length === 0) {
    logLine(opts, 'normal', `No spans files found under ${tracesDir(opts.projectPath)}`)
    return result
  }
  logLine(opts, 'normal', `Forwarding ${files.length} file(s) to ${opts.endpoint}`)

  for (const f of files) {
    const startOffset = cursor[hash][f.date] ?? 0
    const { lines, newOffset } = readNewLines(f.filePath, startOffset)
    if (lines.length === 0) {
      logLine(opts, 'verbose', `  ${f.date}: no new lines (offset ${startOffset})`)
      continue
    }
    let posted = 0
    let errored = 0
    for (const batch of chunk(lines, batchSize)) {
      const res = await postBatch(opts.endpoint, batch, { headers: opts.headers, timeoutMs, fetchImpl })
      if (res.ok) {
        posted += batch.length
        result.bytesPosted += batch.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8'), 0)
      } else {
        errored += batch.length
        logLine(
          opts,
          'normal',
          `  ${f.date}: batch failed — HTTP ${res.status ?? '?'} ${res.error ?? ''}`
        )
      }
    }
    result.envelopesPosted += posted
    result.errors += errored
    result.filesProcessed++
    if (errored === 0) {
      cursor[hash][f.date] = newOffset
      if (persistCursor) writeCursor(opts.projectPath, cursor)
    }
    logLine(opts, 'normal', `  ${f.date}: posted ${posted}/${lines.length} envelope(s)`)
  }
  return result
}

/**
 * Tail today's spans file (and roll over at UTC midnight) and forward new
 * envelopes as they're appended. Returns a `stop()` function — call it on
 * SIGINT to clean up.
 */
export async function follow(
  opts: ForwardOptions
): Promise<{ stop: () => Promise<void>; result: ForwardResult }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const batchSize = opts.batchSize ?? 100
  const timeoutMs = opts.timeoutMs ?? 5000
  const persistCursor = opts.persistCursor ?? true
  const hash = endpointHash(opts.endpoint)

  const cursor = persistCursor ? readCursor(opts.projectPath) : {}
  cursor[hash] = cursor[hash] ?? {}

  const result: ForwardResult = { envelopesPosted: 0, bytesPosted: 0, filesProcessed: 0, errors: 0 }
  let stopped = false
  let watcher: ReturnType<typeof watch> | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let inFlight = false

  // Backfill from cursor first — covers files written while we weren't running.
  await replayAll({ ...opts, persistCursor }).then((r) => {
    result.envelopesPosted += r.envelopesPosted
    result.bytesPosted += r.bytesPosted
    result.filesProcessed += r.filesProcessed
    result.errors += r.errors
  })

  // Reload cursor — replayAll() may have updated it on disk.
  const liveCursor = persistCursor ? readCursor(opts.projectPath) : cursor
  liveCursor[hash] = liveCursor[hash] ?? {}

  async function tickOnce(): Promise<void> {
    if (inFlight || stopped) return
    inFlight = true
    try {
      const path = todaysSpansPath(opts.projectPath)
      const date = path.match(/spans\.(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1]
      if (!date) return
      const startOffset = liveCursor[hash][date] ?? 0
      const { lines, newOffset } = readNewLines(path, startOffset)
      if (lines.length === 0) return
      let errored = 0
      let posted = 0
      for (const batch of chunk(lines, batchSize)) {
        const res = await postBatch(opts.endpoint, batch, { headers: opts.headers, timeoutMs, fetchImpl })
        if (res.ok) {
          posted += batch.length
          result.bytesPosted += batch.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8'), 0)
        } else {
          errored += batch.length
          logLine(
            opts,
            'normal',
            `  ${date}: batch failed — HTTP ${res.status ?? '?'} ${res.error ?? ''}`
          )
        }
      }
      result.envelopesPosted += posted
      result.errors += errored
      if (errored === 0) {
        liveCursor[hash][date] = newOffset
        if (persistCursor) writeCursor(opts.projectPath, liveCursor)
      }
      logLine(opts, 'normal', `  ${date}: forwarded ${posted}/${lines.length} envelope(s)`)
    } finally {
      inFlight = false
    }
  }

  // Set up the watcher. We listen on the traces directory so newly-created
  // files (UTC day-roll mid-process) are picked up. Fallback poll handles
  // platforms where fs.watch is unreliable (some Linux containers).
  const dir = tracesDir(opts.projectPath)
  if (existsSync(dir)) {
    try {
      watcher = watch(dir, { persistent: true }, () => {
        void tickOnce()
      })
    } catch {
      // Watcher unavailable; rely on polling.
      watcher = null
    }
  }
  pollTimer = setInterval(() => {
    void tickOnce()
  }, 1000)
  if (typeof pollTimer === 'object' && pollTimer && 'unref' in pollTimer) {
    ;(pollTimer as { unref: () => void }).unref()
  }
  // Initial sweep.
  await tickOnce()

  return {
    result,
    async stop() {
      if (stopped) return
      stopped = true
      if (watcher) {
        try { watcher.close() } catch { /* ignore */ }
        watcher = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  }
}
