/**
 * Provenance store — append-only JSONL events + content-addressed blob CAS.
 *
 * Pure I/O layer. No graph queries (those live in graph.ts), no capture logic
 * (that lives in capture.ts). This module knows about file paths, hashing, and
 * append-only persistence. Nothing else.
 *
 * Storage layout (under {projectPath}/.research-pilot/provenance/):
 *   graph.jsonl            append-only event log
 *   params/{tcId}.json     raw tool-call params (referenced by ToolCallRecord.parametersRef)
 *   blobs/{sha256}         content-addressed snapshots (≤ 10 MB each)
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PATHS } from '../types.js'
import { SNAPSHOT_MAX_BYTES } from './types.js'
import type { GraphEvent, SnapshotRecord } from './types.js'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export interface ProvenancePaths {
  root: string         // {projectPath}/.research-pilot/provenance
  graph: string        // .../graph.jsonl
  params: string       // .../params/
  blobs: string        // .../blobs/
}

export function provenancePaths(projectPath: string): ProvenancePaths {
  return {
    root:   join(projectPath, PATHS.provenanceRoot),
    graph:  join(projectPath, PATHS.provenanceGraph),
    params: join(projectPath, PATHS.provenanceParams),
    blobs:  join(projectPath, PATHS.provenanceBlobs)
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** sha256 hex of a Buffer or UTF-8 string. */
export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Generate a graph-local node id. */
export function newNodeId(): string {
  return `pn_${randomUUID().replace(/-/g, '')}`
}

// ---------------------------------------------------------------------------
// JSONL event log
// ---------------------------------------------------------------------------

/**
 * Append a single event to graph.jsonl. Creates the file and parent dir if needed.
 * Each event is one line of JSON, terminated by \n.
 */
export async function appendEvent(projectPath: string, event: GraphEvent): Promise<void> {
  const paths = provenancePaths(projectPath)
  ensureDir(paths.root)
  const line = JSON.stringify(event) + '\n'
  await appendFile(paths.graph, line, 'utf-8')
}

/**
 * Read all events from graph.jsonl in order. Returns [] when the file does not
 * exist yet. Malformed lines are skipped silently — append-only logs occasionally
 * have a torn last line on crash, and tolerating that is better than refusing
 * to load the project.
 */
export async function readAllEvents(projectPath: string): Promise<GraphEvent[]> {
  const paths = provenancePaths(projectPath)
  if (!existsSync(paths.graph)) return []
  const raw = await readFile(paths.graph, 'utf-8')
  const out: GraphEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as GraphEvent)
    } catch {
      // Tolerate torn final line; log nothing — graph.ts will surface count if needed.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Params blobs (raw tool-call inputs)
// ---------------------------------------------------------------------------

/**
 * Persist canonicalized params JSON for a tool call. Returns:
 *   - parametersHash: sha256 of the canonical JSON string
 *   - parametersRef: relative POSIX path (so it survives moving the project dir)
 */
export async function writeParams(
  projectPath: string,
  toolCallId: string,
  params: unknown
): Promise<{ parametersHash: string; parametersRef: string }> {
  const paths = provenancePaths(projectPath)
  ensureDir(paths.params)
  const canonical = canonicalJson(params)
  const parametersHash = sha256(canonical)
  const file = join(paths.params, `${toolCallId}.json`)
  await writeFile(file, canonical, 'utf-8')
  return {
    parametersHash,
    // Relative to projectPath, POSIX-style; matches the rest of the codebase.
    parametersRef: `${PATHS.provenanceParams}/${toolCallId}.json`
  }
}

/**
 * Canonical JSON: object keys are sorted recursively so `parametersHash` is
 * stable regardless of property order. Arrays preserve order (semantically
 * meaningful).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key])
  return out
}

// ---------------------------------------------------------------------------
// Content-addressed blob store (CAS)
// ---------------------------------------------------------------------------

/**
 * Snapshot content into blobs/{sha256} if it fits the system-level cap.
 *
 * Per axiom A2 the cap is enforced here, not by adapters. Adapters request a
 * snapshot; the store decides whether it fits.
 *
 * Returns a SnapshotRecord describing what happened. The hash is always
 * computed (so drift detection works even when not snapshotted).
 */
export async function snapshotIfFits(
  projectPath: string,
  content: Buffer
): Promise<SnapshotRecord> {
  const paths = provenancePaths(projectPath)
  const contentHash = sha256(content)
  const sizeBytes = content.length

  if (sizeBytes > SNAPSHOT_MAX_BYTES) {
    return { contentHash, sizeBytes, snapshotted: false, oversizeSkipped: true }
  }

  ensureDir(paths.blobs)
  const blobPath = join(paths.blobs, contentHash)
  // Write-once: skip if blob already exists (free dedup).
  if (!existsSync(blobPath)) {
    await writeFile(blobPath, content)
  }
  return { contentHash, sizeBytes, snapshotted: true, oversizeSkipped: false }
}

/**
 * Hash-only path: compute the sha256 + size without writing a blob. Used for
 * inputs we never snapshot (large datasets) or when we only want drift detection.
 */
export function hashOnly(content: Buffer): SnapshotRecord {
  return {
    contentHash: sha256(content),
    sizeBytes: content.length,
    snapshotted: false,
    oversizeSkipped: false
  }
}

/**
 * Read a snapshotted blob. Returns null if the blob is missing (e.g. it was
 * never snapshotted, or the user cleaned the directory).
 */
export async function readBlob(
  projectPath: string,
  contentHash: string
): Promise<Buffer | null> {
  const paths = provenancePaths(projectPath)
  const blobPath = join(paths.blobs, contentHash)
  if (!existsSync(blobPath)) return null
  return readFile(blobPath)
}

/**
 * Stat a workspace file's hash + size without reading it into memory all at once
 * (well — readFile loads it; this is a v1 helper. If we ever need to hash
 * multi-GB inputs we'll switch to streaming. Not on the critical path today.)
 *
 * Returns null when the path does not exist (callers treat this as "missing live").
 */
export async function statWorkspaceFile(
  projectPath: string,
  relativePath: string
): Promise<{ contentHash: string; sizeBytes: number } | null> {
  const abs = relativePath.startsWith('/') ? relativePath : join(projectPath, relativePath)
  if (!existsSync(abs)) return null
  const buf = await readFile(abs)
  return { contentHash: sha256(buf), sizeBytes: buf.length }
}

/**
 * Convenience: resolve current size of a file, used for early "is this oversize"
 * checks before deciding whether to even read the content.
 */
export async function fileSize(absPath: string): Promise<number | null> {
  if (!existsSync(absPath)) return null
  const s = await stat(absPath)
  return s.size
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests only)
// ---------------------------------------------------------------------------

export const __internal = {
  canonicalize,
  ensureDir: (p: string) => ensureDir(dirname(p))
}
