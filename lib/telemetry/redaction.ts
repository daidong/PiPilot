/**
 * Secret scrubbing & size capping pipeline (§7).
 *
 * PiPilot is local-first; data lives in the user's workspace and is not transmitted.
 * This pipeline is therefore not a "privacy" system — it's a defense against secrets
 * being embedded in trace events that the user might later choose to share (e.g., bug
 * reports, future external export), plus a size cap so individual span events stay
 * queryable.
 *
 * Single shared pipeline applied to args, results, span events, and ledger rows.
 *
 * Stages (in order):
 *   1. Field-level deny list (always on).
 *   2. Pattern-based scrubber (regex catalog).
 *   3. Path scrubbing (`$HOME` / `/Users/<name>` → `~`).
 *   4. Size cap per-field (default 4 KB).
 *   5. Artifact reference shortcut.
 *   6. Image / SVG / binary → blob ref only.
 *
 * Bumping the scrubber catalog (e.g., adding a new key pattern) is observable via
 * `SCRUBBER_VERSION` written into `pipilot.redaction.scrubber_version` on every span.
 */

import { createHash } from 'node:crypto'

/** Bump when the catalog of patterns / deny keys changes. */
export const SCRUBBER_VERSION = 'pipilot-scrub-v1' as const

/** Default per-field size cap; over-cap content goes to blob store. */
export const DEFAULT_SIZE_CAP_BYTES = 4 * 1024 // 4 KB

/** Sentinel for redacted scalar values. */
const REDACTED = (kind: string) => `<redacted:${kind}>`

/**
 * Field names that always get scrubbed regardless of value.
 * Compared case-insensitively. Substring match: `apiKeyForFoo` is also scrubbed.
 */
const FIELD_DENY_LIST = [
  'apikey',
  'api_key',
  'password',
  'passwd',
  'authorization',
  'auth_token',
  'cookie',
  'secret',
  'token',
  // Build-signing creds (§7)
  'csc_link',
  'csc_key_password',
  'apple_id',
  'apple_app_specific_password',
  'apple_team_id'
]

/**
 * Pattern-based scrubber catalog.
 *
 * Keys are descriptive labels emitted as `<redacted:label>`. Order matters only for
 * test readability — patterns are tested in array order.
 */
const PATTERN_CATALOG: Array<{ label: string; rx: RegExp }> = [
  // Anthropic API keys: sk-ant-...  (>= 20 chars after prefix)
  { label: 'anthropic-key', rx: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  // OpenAI keys: sk-... (legacy 48 char) or sk-proj-... (project keys)
  { label: 'openai-key', rx: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
  { label: 'github-token', rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // AWS access key id
  { label: 'aws-access-key', rx: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Generic Bearer header
  { label: 'bearer-token', rx: /\bBearer\s+[A-Za-z0-9_\-.=]{16,}\b/gi },
  // JWT: header.payload.signature (each base64url > 6 chars)
  { label: 'jwt', rx: /\b[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g }
]

export interface RedactionStats {
  fieldsRedactedCount: number
  scrubberVersion: typeof SCRUBBER_VERSION
}

/**
 * Content-addressed sink with sync return. When supplied, redact() hashes
 * oversized strings/buffers synchronously and the implementation enqueues
 * the disk write asynchronously — `writeIfMissing` returns immediately so
 * `redact()` itself stays sync.
 *
 * The hash returned in `{ contentHash }` is correct as soon as the call
 * returns; the bytes are typically on disk within a setImmediate tick. To
 * guarantee on-disk presence (e.g. tests, shutdown), call `flush()` on the
 * underlying store. Without a sink, redact() still emits the ref but the
 * bytes are never persisted (telemetry-disabled / offline / test paths).
 *
 * `onError` (if supplied) is invoked synchronously iff the implementation
 * dropped the write under backpressure. Async I/O failures during the
 * background drain do NOT route through `onError` — the originating span
 * has typically ended by then; those failures surface via the existing
 * TraceStore degraded-mode log instead.
 */
export interface BlobSink {
  /**
   * Write `content` if not already present. `onError` (if supplied) is invoked
   * with the underlying error when the write fails — callers should route this
   * to span attributes / tracingState so dangling content-hash refs are
   * observable rather than silent.
   */
  writeIfMissing(
    content: string | Buffer | Uint8Array,
    onError?: (err: unknown) => void
  ): { hash: string; size: number; isNew: boolean }
}

export interface RedactOptions {
  sizeCapBytes?: number
  /** Optional content-addressed blob store. Receives over-cap content + binary blobs. */
  blobStore?: BlobSink
  /**
   * Invoked when a blob-store write fails. Caller should record the failure
   * on the active span (e.g. `pipilot.blob.write_failed_count`) so trace
   * consumers know the contentHash ref points at bytes that were never
   * persisted.
   */
  onBlobError?: (err: unknown) => void
  /**
   * Returns true if the value looks like an "artifact reference" — anything with an
   * `artifactId` field. Used by stage 5 to short-circuit recursion.
   */
  isArtifactRef?: (value: unknown) => boolean
}

/**
 * Scrub a string: applies pattern catalog + path normalization.
 * Stage 2 + Stage 3.
 */
export function scrubString(input: string): { scrubbed: string; hits: number } {
  let s = input
  let hits = 0

  for (const { label, rx } of PATTERN_CATALOG) {
    const before = s
    s = s.replace(rx, () => {
      hits++
      return REDACTED(label)
    })
    void before
  }

  // Stage 3: path normalization (comfort, not security).
  // Replace $HOME / typical macOS+linux user dir prefixes with ~.
  // Note: we DO NOT touch workspace-relative paths.
  const home = typeof process !== 'undefined' ? process.env.HOME ?? process.env.USERPROFILE : null
  if (home && home.length > 0) {
    s = s.split(home).join('~')
  }
  // POSIX user-home pattern (covers other users' homes too if quoted in errors)
  s = s.replace(/\/Users\/[^/\s"']+/g, '~')
  // Linux pattern (less common but harmless)
  s = s.replace(/\/home\/[^/\s"']+/g, '~')

  return { scrubbed: s, hits }
}

/**
 * Field-name match (Stage 1).
 */
function isDenyField(name: string): boolean {
  const lower = name.toLowerCase()
  return FIELD_DENY_LIST.some((deny) => lower.includes(deny))
}

/**
 * Sha256 hex of a UTF-8 string. Used for over-cap blob references when no
 * blobStore is provided (callers can swap in real CAS later).
 */
export function sha256Hex(content: string | Buffer): string {
  const h = createHash('sha256')
  h.update(content)
  return h.digest('hex')
}

/**
 * Over-cap branch: emit `{ truncated, contentHash, size }`. When a `blobStore`
 * is provided, the bytes are written to the sink first so the hash can be
 * resolved back to the original later (`.research-pilot/blobs/{aa}/{full}`).
 */
function emitOverCap(
  value: string | Buffer,
  blobStore?: BlobSink,
  onBlobError?: (err: unknown) => void
): {
  truncated: true
  contentHash: string
  size: number
  redactionLevel: 'size-cap'
} {
  if (blobStore) {
    const { hash, size } = blobStore.writeIfMissing(value, onBlobError)
    return {
      truncated: true,
      contentHash: 'sha256:' + hash,
      size,
      redactionLevel: 'size-cap'
    }
  }
  // No sink: still emit a ref so trace shape is consistent, but bytes are lost.
  return {
    truncated: true,
    contentHash: 'sha256:' + sha256Hex(value),
    size: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length,
    redactionLevel: 'size-cap'
  }
}

/** Binary-content branch (Buffer / data: URL / large SVG). Same blob-store semantics. */
function emitBinaryRef(
  value: string | Buffer,
  mimeType: string,
  blobStore?: BlobSink,
  onBlobError?: (err: unknown) => void
): { contentHash: string; mimeType: string; size: number } {
  if (blobStore) {
    const { hash, size } = blobStore.writeIfMissing(value, onBlobError)
    return { contentHash: 'sha256:' + hash, mimeType, size }
  }
  return {
    contentHash: 'sha256:' + sha256Hex(value),
    mimeType,
    size: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length
  }
}

/**
 * Recursively redact a value tree. Returns the redacted clone plus stats.
 *
 * Never mutates the input.
 */
export function redact(
  value: unknown,
  opts: RedactOptions = {}
): { value: unknown; stats: RedactionStats } {
  const sizeCap = opts.sizeCapBytes ?? DEFAULT_SIZE_CAP_BYTES
  let totalHits = 0

  const visit = (v: unknown, fieldName: string | null): unknown => {
    // Stage 5: artifact-ref shortcut.
    if (opts.isArtifactRef?.(v)) {
      const obj = v as Record<string, unknown>
      return { artifactRef: obj.artifactId ?? obj.id }
    }

    // Stage 1: field-level deny list (only applies when we know the field name).
    if (fieldName && isDenyField(fieldName)) {
      totalHits++
      return REDACTED('field')
    }

    if (v === null || v === undefined) return v

    // Stage 6: binary / image
    if (Buffer.isBuffer(v)) {
      return emitBinaryRef(v, 'application/octet-stream', opts.blobStore, opts.onBlobError)
    }
    if (typeof v === 'string' && v.startsWith('data:image/')) {
      const mime = v.slice(5, v.indexOf(';') > 0 ? v.indexOf(';') : 5 + 9)
      return emitBinaryRef(v, mime, opts.blobStore, opts.onBlobError)
    }
    if (typeof v === 'string' && v.startsWith('<svg') && v.length > 1024) {
      return emitBinaryRef(v, 'image/svg+xml', opts.blobStore, opts.onBlobError)
    }

    if (typeof v === 'string') {
      // Stage 2 + 3
      const { scrubbed, hits } = scrubString(v)
      totalHits += hits
      // Stage 4: size cap
      if (Buffer.byteLength(scrubbed, 'utf8') > sizeCap) {
        return emitOverCap(scrubbed, opts.blobStore, opts.onBlobError)
      }
      return scrubbed
    }

    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      return v
    }

    if (Array.isArray(v)) {
      return v.map((item) => visit(item, null))
    }

    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = visit(vv, k)
      }
      // Stage 4 (object level): if the *serialized* object is over cap, blob it.
      // BigInts can't be JSON-encoded; replacer coerces them to a string so we can
      // measure size. The blob (if produced) will have the same coercion applied.
      const replacer = (_key: string, val: unknown) =>
        typeof val === 'bigint' ? val.toString() + 'n' : val
      let serialized: string
      try {
        serialized = JSON.stringify(out, replacer)
      } catch {
        // Defensive: if JSON.stringify still fails (cycles, exotic values),
        // skip the cap check rather than crashing the trace path.
        return out
      }
      if (Buffer.byteLength(serialized, 'utf8') > sizeCap) {
        return emitOverCap(serialized, opts.blobStore, opts.onBlobError)
      }
      return out
    }

    return v
  }

  const result = visit(value, null)
  return {
    value: result,
    stats: {
      fieldsRedactedCount: totalHits,
      scrubberVersion: SCRUBBER_VERSION
    }
  }
}
