import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../../types.js'

// Content sanitation + distillation for the audit. Three jobs:
//   1. strip blob/hash plumbing so its hex digits never get parsed as data
//      (the `sha256:…` contentHash false-mismatch);
//   2. drop verbose free-text fields from structured tool results (blacklist,
//      not whitelist — never silently drop unknown/identifying fields);
//   3. detect gibberish (binary / mojibake, e.g. a PDF read as text) and skip
//      it entirely — never fed to the LLM, never a finding.

// `sha256:…` digests and `"contentHash": "…"` envelopes. Stripped before any
// numeric/path parsing so a hash's hex digits can't masquerade as a result value.
const BLOB_TOKEN_RX = /"?contentHash"?\s*:\s*"?sha256:[0-9a-fA-F]+"?|sha256:[0-9a-fA-F]{8,}/g

export function stripBlobTokens(text: string): string {
  return text.replace(BLOB_TOKEN_RX, ' ')
}

// Verbose / binary payload fields to DROP when distilling a structured tool
// result for the LLM extractor. Blacklist (case-insensitive): everything not
// listed — including unknown and identifying fields (url, title, query, count,
// path, doi, error, …) — is KEPT. See the scan in the audit spec discussion.
const DISTILL_DROP = new Set([
  'snippet', 'abstract', 'summary',
  'content', 'text', 'body', 'markdown', 'fulltext', 'pagecontent', 'chunks',
  'html', 'raw',
  'base64', 'dataurl', 'image', 'thumbnail',
  'stdout', 'stderr',
])

const MAX_CHARS = 8000
const MAX_ARRAY = 25
const MAX_STR = 400

// True when the text looks like binary / mojibake rather than language: a high
// share of replacement chars (U+FFFD), NULs, or C0 control bytes. Such content
// (a PDF/image read as text) carries no auditable claim and must be skipped.
export function isGibberish(text: string): boolean {
  if (text.length < 16) return false
  let bad = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0xfffd || c === 0 || (c < 0x09) || (c > 0x0d && c < 0x20)) bad++
  }
  return bad / text.length > 0.1
}

function distillValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STR ? value.slice(0, MAX_STR) + '…' : value
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map(v => distillValue(v, depth + 1))
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} more)`)
    return out
  }
  if (value && typeof value === 'object' && depth < 6) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DISTILL_DROP.has(k.toLowerCase())) continue // blacklisted verbose field
      out[k] = distillValue(v, depth + 1)
    }
    return out
  }
  return value
}

// Blocks of an assistant message (response_text): the narrative lives in `text`
// and `thinking`; `tool_use`/`reasoning`-signature blocks carry none.
function looksLikeBlocks(arr: unknown[]): boolean {
  return arr.some(b => !!b && typeof b === 'object' && (
    typeof (b as { text?: unknown }).text === 'string' ||
    typeof (b as { thinking?: unknown }).thinking === 'string' ||
    typeof (b as { type?: unknown }).type === 'string'
  ))
}
function blocksToText(arr: unknown[]): string {
  return arr.map(b => {
    if (!b || typeof b !== 'object') return ''
    const o = b as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (typeof o.thinking === 'string') return o.thinking
    return ''
  }).filter(Boolean).join('\n\n')
}

export function blobFilePath(projectPath: string, hash: string): string {
  const h = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  return join(projectPath, PATHS.blobs, h.slice(0, 2), h)
}

/** Read a spilled blob's bytes as UTF-8 text; '' when missing/unreadable. */
export async function readBlobText(projectPath: string, hash: string): Promise<string> {
  try {
    return await fs.readFile(blobFilePath(projectPath, hash), 'utf8')
  } catch {
    return ''
  }
}

// Replace blob references in a raw event body with the blob's real bytes. The
// >4KB redaction spills the value to a content-addressed blob and leaves a
// `{contentHash}` envelope; here we read it back so the real content is audited.
async function inlineBlobs(raw: string, projectPath: string | undefined): Promise<string> {
  if (!projectPath) return raw
  const hashes = [...raw.matchAll(/sha256:[0-9a-fA-F]{16,}/g)].map(m => m[0])
  if (hashes.length === 0) return raw
  const texts = (await Promise.all([...new Set(hashes)].map(h => readBlobText(projectPath, h)))).filter(Boolean)
  // When the raw body is essentially just the envelope, the blob IS the content;
  // otherwise append the resolved bytes so nothing inline is lost.
  const joined = texts.join('\n')
  return raw.replace(BLOB_TOKEN_RX, ' ').trim().length < 80 ? (joined || raw) : `${raw}\n${joined}`
}

/**
 * Turn a raw event body into clean text for the claim extractor:
 *  - resolve spilled blobs to their real bytes,
 *  - if it's an assistant content array → keep text+thinking prose,
 *  - if it's a structured tool result → distill (drop blacklisted verbose
 *    fields, keep identifiers/unknowns),
 *  - strip hash plumbing, drop gibberish, cap length.
 * Returns '' when there is nothing auditable (gibberish or empty).
 */
export async function distillForExtraction(raw: string, projectPath?: string): Promise<string> {
  if (!raw || !raw.trim()) return ''
  const inlined = await inlineBlobs(raw, projectPath)

  let text: string
  let parsed: unknown
  try { parsed = JSON.parse(inlined) } catch { parsed = undefined }

  if (Array.isArray(parsed) && looksLikeBlocks(parsed)) {
    text = blocksToText(parsed)
  } else if (parsed && typeof parsed === 'object') {
    text = JSON.stringify(distillValue(parsed))
  } else if (typeof parsed === 'string') {
    text = parsed
  } else {
    text = inlined
  }

  text = stripBlobTokens(text)
  if (isGibberish(text)) return ''
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…(truncated)' : text
}
