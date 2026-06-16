/**
 * File ledger — write-time provenance for raw filesystem files.
 *
 * Artifacts (papers / notes / data in the memory-v2 store) already carry a
 * creator via the artifact ledger. Plain working files a tool downloads or
 * produces on disk — a fetched arxiv `.tex`, a converted markdown, a generated
 * figure, a python analysis output — have no such record, so the audit graph
 * could previously only show who *read* them, never who *made* them.
 *
 * This ledger closes that gap by recording a row at the moment a tool writes a
 * file. Like the artifact ledger it auto-pulls the active tool-call id off the
 * OTel context (TOOL_CALL_KEY, published by createResearchTools for the whole
 * duration of each tool's execute()), so the producing tool is captured without
 * the call site threading anything by hand. The audit-graph projection then
 * joins these rows to the tool node by `toolCallId` and draws a `writes` edge —
 * a real, recorded source, not a heuristic re-derived from tool arguments.
 *
 * Records objective facts only (path, content hash, size, producing tool). It
 * is append-only and best-effort: a ledger failure must never block the agent.
 */

import { join, relative, isAbsolute } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { context, trace } from '@opentelemetry/api'
import { PATHS } from '../types.js'
import { appendJsonl } from '../telemetry/jsonl-writer.js'
import { TURN_ID_KEY, TOOL_CALL_KEY } from '../telemetry/context-keys.js'

export type FileOp = 'write' | 'read'

export interface FileLedgerRow {
  /** Path as surfaced to the agent (typically absolute), so it matches the
   *  string later passed to read/grep and resolves to the same graph node. */
  path: string
  op: FileOp
  /** `sha256:<hex>`; omitted for oversized or unreadable files (path still kept). */
  contentHash?: string
  byteSize?: number
  /** Producing tool name, when the call site knows it. */
  tool?: string
  traceId?: string
  spanId?: string
  turnId?: string
  toolCallId?: string
  timestamp: string
}

type FileLedgerRowInput = Omit<FileLedgerRow, 'timestamp' | 'traceId' | 'spanId' | 'toolCallId' | 'turnId'> & {
  timestamp?: string
  traceId?: string
  spanId?: string
  turnId?: string
  toolCallId?: string
}

/** Skip hashing files larger than this — the path/size row is still written. 25 MB. */
const MAX_HASH_BYTES = 25 * 1024 * 1024

/** Fill in trace + tool-call context (from OTel when not supplied), timestamp, and strip undefined. */
function buildRow(row: FileLedgerRowInput): FileLedgerRow {
  let traceId = row.traceId
  let spanId = row.spanId
  if (!traceId || !spanId) {
    const ctx = trace.getActiveSpan()?.spanContext()
    if (ctx) {
      traceId = traceId ?? ctx.traceId
      spanId = spanId ?? ctx.spanId
    }
  }
  let turnId = row.turnId
  if (!turnId) {
    const ctxTurn = context.active().getValue(TURN_ID_KEY)
    if (typeof ctxTurn === 'string') turnId = ctxTurn
  }
  let toolCallId = row.toolCallId
  if (!toolCallId) {
    const ctxCall = context.active().getValue(TOOL_CALL_KEY)
    if (typeof ctxCall === 'string') toolCallId = ctxCall
  }
  const full: FileLedgerRow = {
    path: row.path,
    op: row.op,
    contentHash: row.contentHash,
    byteSize: row.byteSize,
    tool: row.tool,
    traceId,
    spanId,
    turnId,
    toolCallId,
    timestamp: row.timestamp ?? new Date().toISOString(),
  }
  for (const k of Object.keys(full) as (keyof FileLedgerRow)[]) {
    if (full[k] === undefined) delete full[k]
  }
  return full
}

export interface FileLedgerWriter {
  append(row: FileLedgerRowInput): Promise<boolean>
  readonly filePath: string
}

export function createFileLedgerWriter(projectPath: string): FileLedgerWriter {
  const filePath = join(projectPath, PATHS.ledgerFile)
  return {
    filePath,
    append(row) {
      return appendJsonl(filePath, buildRow(row), { onError: () => {} })
    },
  }
}

/**
 * Record that a tool wrote a file. Hashes the on-disk bytes (capped) and appends
 * a `write` row stamped with the active tool-call id. Best-effort: any failure
 * (file gone, unreadable, ledger IO) is swallowed so it can never block the
 * agent. Call from a tool's execute() after the file lands; the OTel context
 * supplies the producing tool-call id automatically.
 *
 * @param absPath  absolute path of the file just written.
 */
export async function recordFileWrite(
  projectPath: string,
  absPath: string,
  opts: { tool?: string } = {},
): Promise<void> {
  try {
    let contentHash: string | undefined
    let byteSize: number | undefined
    try {
      const st = statSync(absPath)
      byteSize = st.size
      if (st.isFile() && st.size <= MAX_HASH_BYTES) {
        contentHash = 'sha256:' + createHash('sha256').update(readFileSync(absPath)).digest('hex')
      }
    } catch {
      // File may not exist / be unreadable; still record the path below.
    }
    await createFileLedgerWriter(projectPath).append({
      // Store the path the SAME way the agent refers to files: project-relative
      // for in-project files (what read/grep pass as args), absolute otherwise.
      // The audit-graph keys file nodes by this string, so a mismatch (absolute
      // here vs relative in tool args) would orphan the `writes` edge onto a
      // separate node — the exact bug this normalization prevents.
      path: toAgentPath(projectPath, absPath),
      op: 'write',
      contentHash,
      byteSize,
      tool: opts.tool,
    })
  } catch {
    // Never let provenance bookkeeping break a tool.
  }
}

/** Project-relative when the file sits inside the project, else the absolute path. */
export function toAgentPath(projectPath: string, absPath: string): string {
  if (!isAbsolute(absPath)) return absPath
  const rel = relative(projectPath, absPath)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absPath
}
