/**
 * Content-addressed blob store (telemetry-trace v0.10 §5.3).
 *
 * Stores oversized strings/buffers under `.research-pilot/blobs/{aa}/{full-sha256}`,
 * where `aa` is a 2-char prefix shard so a single directory never holds 100k+
 * files. Files are referenced from spans/ledgers as `{ contentHash, size }`.
 *
 * Design notes:
 * - Content-addressed → automatic dedup. Same prompt template across 1000
 *   spans = 1 file on disk.
 * - Sync I/O on the fast path (writeIfMissing). The redaction pipeline runs
 *   inside the agent loop and we want predictable latency; statSync+writeFileSync
 *   on small files (~10-200KB) is microseconds. Async I/O would force every
 *   `redact()` call to be async, which is invasive.
 * - Best-effort: if write fails (disk full, perms), we log to tracingState
 *   and emit the reference anyway so the trace stays consistent.
 * - Retention: forever (per spec §5.3). Project deletion = only purge.
 *
 * Wire format on disk: raw bytes, no envelope. Decoder is "open the file."
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PATHS } from '../types.js'

export interface BlobWriteResult {
  /** sha256 hex (no `sha256:` prefix). */
  hash: string
  /** Byte length on disk. */
  size: number
  /** True if a new file was written; false if it already existed. */
  isNew: boolean
}

export class BlobStore {
  private readonly root: string

  constructor(projectPath: string) {
    this.root = join(projectPath, PATHS.blobs)
  }

  /** Resolve the on-disk path for a hash. Public so debuggers / `cat` can find it. */
  pathFor(hash: string): string {
    if (hash.startsWith('sha256:')) hash = hash.slice('sha256:'.length)
    return join(this.root, hash.slice(0, 2), hash)
  }

  /**
   * Write `content` if its hash isn't already on disk. Returns the hash
   * regardless. Never throws — failures are silent (logged via the optional
   * onError) so the trace path keeps moving.
   *
   * `content` may be a string or a Buffer. Strings are utf-8 encoded.
   */
  writeIfMissing(content: string | Buffer | Uint8Array, onError?: (err: unknown) => void): BlobWriteResult {
    const buf =
      typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : content instanceof Buffer
          ? content
          : Buffer.from(content)
    const hash = createHash('sha256').update(buf).digest('hex')
    const path = this.pathFor(hash)
    const result: BlobWriteResult = { hash, size: buf.length, isNew: false }
    try {
      if (existsSync(path)) return result
      mkdirSync(join(this.root, hash.slice(0, 2)), { recursive: true })
      writeFileSync(path, buf)
      result.isNew = true
    } catch (err) {
      onError?.(err)
    }
    return result
  }
}
