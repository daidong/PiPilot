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

export interface RedactOptions {
  sizeCapBytes?: number
  /** Optional content-addressed blob store callback. Returns sha256 for over-cap fields. */
  blobStore?: (contents: string | Buffer, mimeType?: string) => Promise<string> | string
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
 * Default over-cap behavior: emit a blob ref with content hash. The actual blob
 * write is the caller's responsibility (TraceStore / ledger writer).
 */
function defaultOverCap(value: string, sizeCap: number): {
  truncated: true
  contentHash: string
  size: number
  redactionLevel: 'size-cap'
} {
  void sizeCap
  return {
    truncated: true,
    contentHash: 'sha256:' + sha256Hex(value),
    size: Buffer.byteLength(value, 'utf8'),
    redactionLevel: 'size-cap'
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
      return {
        contentHash: 'sha256:' + sha256Hex(v),
        mimeType: 'application/octet-stream',
        size: v.length
      }
    }
    if (typeof v === 'string' && v.startsWith('data:image/')) {
      // base64-encoded image inlined as data: URL — never inline in trace.
      const size = Buffer.byteLength(v, 'utf8')
      return {
        contentHash: 'sha256:' + sha256Hex(v),
        mimeType: v.slice(5, v.indexOf(';') > 0 ? v.indexOf(';') : 5 + 9),
        size
      }
    }
    if (typeof v === 'string' && v.startsWith('<svg') && v.length > 1024) {
      return {
        contentHash: 'sha256:' + sha256Hex(v),
        mimeType: 'image/svg+xml',
        size: Buffer.byteLength(v, 'utf8')
      }
    }

    if (typeof v === 'string') {
      // Stage 2 + 3
      const { scrubbed, hits } = scrubString(v)
      totalHits += hits
      // Stage 4: size cap
      if (Buffer.byteLength(scrubbed, 'utf8') > sizeCap) {
        return defaultOverCap(scrubbed, sizeCap)
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
        return defaultOverCap(serialized, sizeCap)
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
