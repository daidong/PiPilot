/**
 * Cross-platform append-only JSONL writer.
 *
 * Used by:
 * - tracing-state.jsonl (§10.1)
 * - JsonlSpanExporter (§5.1, §6.9)
 * - tombstone sidecar (§5.1)
 * - ledgers (§8)
 * - trace-digest (§5.5)
 *
 * Design:
 * - Force `\n` EOL so files are byte-identical across darwin/linux/win32 (Layer 3 portability).
 * - `O_APPEND` so concurrent writers cannot interleave partial lines (POSIX guarantee for
 *   writes ≤ PIPE_BUF; Node uses one syscall per appendFile call).
 * - Never throws to caller — all I/O errors are surfaced via the optional onError hook.
 * - No fsync per write; callers may invoke `fsyncSync` at flush boundaries.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonlWriterOptions {
  /** Called on any I/O error. Defaults to a no-op so the agent path is never blocked. */
  onError?: (err: unknown) => void
}

/**
 * Append a single JSON-serializable row to a JSONL file.
 * Creates parent directories on demand. Forces `\n` EOL.
 *
 * Returns true on success, false if the write failed.
 * Never throws.
 */
export async function appendJsonl(
  filePath: string,
  row: unknown,
  opts: JsonlWriterOptions = {}
): Promise<boolean> {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const line = JSON.stringify(row) + '\n'
    await appendFile(filePath, line, { encoding: 'utf8' })
    return true
  } catch (err) {
    opts.onError?.(err)
    return false
  }
}

/**
 * Synchronous variant of {@link appendJsonl}. Use when the caller must guarantee
 * the row is durable before it returns — e.g. a side-effect of an otherwise
 * synchronous API, where a dangling async write would race the caller (notably
 * test teardown that deletes the dir, or a crash before the write lands).
 * Never throws.
 */
export function appendJsonlSync(
  filePath: string,
  row: unknown,
  opts: JsonlWriterOptions = {}
): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(row) + '\n', { encoding: 'utf8' })
    return true
  } catch (err) {
    opts.onError?.(err)
    return false
  }
}

/**
 * Append many rows in a single appendFile call. Atomic w.r.t. the underlying syscall —
 * either all rows land or none do. Useful for batched span flushes.
 */
export async function appendJsonlBatch(
  filePath: string,
  rows: readonly unknown[],
  opts: JsonlWriterOptions = {}
): Promise<boolean> {
  if (rows.length === 0) return true
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    await appendFile(filePath, payload, { encoding: 'utf8' })
    return true
  } catch (err) {
    opts.onError?.(err)
    return false
  }
}
