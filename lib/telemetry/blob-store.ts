/**
 * Content-addressed blob store (telemetry-trace v0.10 §5.3).
 *
 * Stores oversized strings/buffers under `.research-pilot/blobs/{aa}/{full-sha256}`,
 * where `aa` is a 2-char prefix shard so a single directory never holds 100k+
 * files. Files are referenced from spans/ledgers as `{ contentHash, size }`.
 *
 * Design (async-queue, since v0.11):
 * - Hash sync (required to return contentHash immediately for the trace event),
 *   enqueue write async. The redaction pipeline runs inside the agent loop and
 *   used to do statSync+writeFileSync inline — for a 5 MB tool result that's
 *   ~50–100 ms blocking the LLM call. The hash itself is only ~3–10 ms, so we
 *   keep that on the critical path and defer disk I/O to a background drain.
 *
 * - In-memory dedup via two Sets:
 *     knownHashes   → already on disk this session (or stat-confirmed mid-drain).
 *     pendingHashes → enqueued, drain hasn't completed.
 *   Concurrent calls for identical content (the same system prompt referenced
 *   by 100 spans) share a single queued write — second caller sees the hash
 *   in `pendingHashes` and skips enqueue.
 *
 * - Backpressure: bounded by `MAX_QUEUE_BYTES` (64 MB). Over-cap writes are
 *   dropped synchronously and surface via `onError`. The existing per-span
 *   `pipilot.blob.write_failed_count` attribute (lib/telemetry/llm-trace.ts +
 *   lib/agents/telemetry-adapter.ts) catches the saturation case.
 *
 * - Async drain failures (disk full, EROFS, perms revoked mid-session) land
 *   on already-ended spans and can't be attributed per-blob via setAttribute.
 *   They surface through `JsonlSpanExporter.onError` → `TraceStore.enterDegraded`
 *   → tracing-state.jsonl `trace-store-degraded-enter` row. Operators see one
 *   row per session-degradation event, not one per affected blob — accepted
 *   trade-off for moving I/O off the LLM critical path.
 *
 * - Best-effort: failures DO NOT throw. The trace stays internally consistent
 *   (the hash ref is emitted regardless). At worst a consumer dereferences a
 *   hash that isn't on disk, which is detectable by stat-ing the path.
 *
 * - Process exit: callers should `await blobStore.flush()` before shutting
 *   down. `PipilotTracer.shutdown` does this. SIGKILL leaves enqueued blobs
 *   unwritten — same hazard window as the old sync code between
 *   `writeFileSync` start and OS fsync, just larger and more visible.
 *
 * - Retention: forever (per spec §5.3). Project deletion = only purge.
 *
 * Wire format on disk: raw bytes, no envelope. Decoder is "open the file."
 */

import { stat, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { PATHS } from '../types.js'

export interface BlobWriteResult {
  /** sha256 hex (no `sha256:` prefix). */
  hash: string
  /** Byte length on disk. */
  size: number
  /**
   * True iff this call enqueued a fresh write — i.e. the caller is the first
   * (this session) to reference this content. False when the hash was already
   * known on disk OR already pending in the queue OR the write was dropped
   * due to queue saturation. Used for stats only — does NOT guarantee bytes
   * are on disk yet. Use `flush()` for that guarantee.
   */
  isNew: boolean
}

interface QueueItem {
  hash: string
  path: string
  buf: Buffer
  onError?: (err: unknown) => void
}

/** Hard cap on bytes pending in the in-memory write queue. */
const MAX_QUEUE_BYTES = 64 * 1024 * 1024

export class BlobStore {
  private readonly root: string
  private readonly knownHashes = new Set<string>()
  private readonly pendingHashes = new Set<string>()
  private readonly writeQueue: QueueItem[] = []
  private currentQueueBytes = 0
  private droppedWrites = 0
  /** A drain is in flight. Guards re-entrant scheduleDrain. */
  private draining = false
  /** The most recent drain promise — awaited by `flush()`. */
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(projectPath: string) {
    this.root = join(projectPath, PATHS.blobs)
  }

  /** Resolve the on-disk path for a hash. Public so debuggers / `cat` can find it. */
  pathFor(hash: string): string {
    if (hash.startsWith('sha256:')) hash = hash.slice('sha256:'.length)
    return join(this.root, hash.slice(0, 2), hash)
  }

  /**
   * Hash `content` synchronously, enqueue the write, and return the resulting
   * `{ hash, size, isNew }` immediately. The actual disk write happens on a
   * background drain (`setImmediate`-scheduled).
   *
   * `onError` is invoked synchronously iff the queue is saturated and this
   * write is dropped. Async drain failures are NOT routed to `onError` (the
   * span has typically ended by then; see class doc) — they surface via
   * tracing-state.jsonl through the existing TraceStore degraded-mode signal.
   *
   * `content` may be a string or a Buffer. Strings are utf-8 encoded.
   */
  writeIfMissing(
    content: string | Buffer | Uint8Array,
    onError?: (err: unknown) => void
  ): BlobWriteResult {
    const buf =
      typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : content instanceof Buffer
          ? content
          : Buffer.from(content)
    const hash = createHash('sha256').update(buf).digest('hex')
    const path = this.pathFor(hash)

    // Already confirmed on disk this session, or already in the queue —
    // skip enqueue. Concurrent calls for identical content collapse into a
    // single queued write.
    if (this.knownHashes.has(hash) || this.pendingHashes.has(hash)) {
      return { hash, size: buf.length, isNew: false }
    }

    // Backpressure. Don't queue unbounded work — under disk pressure the
    // queue would otherwise grow proportionally to the agent loop rate.
    if (this.currentQueueBytes + buf.length > MAX_QUEUE_BYTES) {
      this.droppedWrites++
      onError?.(
        new Error(
          `blob queue saturated (${this.currentQueueBytes} bytes pending, ${buf.length} requested); dropping write`
        )
      )
      return { hash, size: buf.length, isNew: false }
    }

    this.writeQueue.push({ hash, path, buf, onError })
    this.pendingHashes.add(hash)
    this.currentQueueBytes += buf.length
    this.scheduleDrain()
    return { hash, size: buf.length, isNew: true }
  }

  /**
   * Wait for currently-queued writes to complete. Quiescence semantics: if
   * new work arrives mid-flush we drain that too, then return when the queue
   * is empty AND no drain is in flight. Idempotent; safe to call concurrently.
   *
   * Tracer.shutdown() awaits this before provider.shutdown() so spans don't
   * land on disk referencing blobs that never made it.
   */
  async flush(): Promise<void> {
    while (this.writeQueue.length > 0 || this.draining) {
      await this.drainPromise
    }
  }

  /** Diagnostic: number of writes dropped due to queue saturation. */
  get droppedWriteCount(): number {
    return this.droppedWrites
  }

  /** Diagnostic: bytes currently sitting in the write queue. */
  get pendingBytes(): number {
    return this.currentQueueBytes
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    this.drainPromise = (async () => {
      try {
        await this.drainOnce()
      } finally {
        this.draining = false
      }
    })()
  }

  private async drainOnce(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const item = this.writeQueue.shift()!
      // Hold onto the byte count until I/O actually completes — otherwise
      // backpressure would be defeated: a 40 MB write would "free" its bytes
      // the moment drain pulled it from the queue (before any await), so the
      // next writeIfMissing in the same tick would see `currentQueueBytes=0`
      // and squeeze through saturation. Decrement in `finally` instead.
      try {
        try {
          await stat(item.path)
          // Already on disk from a previous session — promote to known.
          this.pendingHashes.delete(item.hash)
          this.knownHashes.add(item.hash)
          continue
        } catch {
          // ENOENT (expected case) — fall through to write.
        }
        await mkdir(dirname(item.path), { recursive: true })
        await writeFile(item.path, item.buf)
        this.pendingHashes.delete(item.hash)
        this.knownHashes.add(item.hash)
      } catch (err) {
        // Async I/O failure. The originating span has typically ended already
        // and can't accept new attributes, so per-blob attribution is lost.
        // Drop from pendingHashes so a future writeIfMissing for the same
        // content can re-attempt rather than being silently deduped against
        // a never-written entry.
        this.pendingHashes.delete(item.hash)
        item.onError?.(err)
      } finally {
        this.currentQueueBytes -= item.buf.length
      }
    }
  }
}
