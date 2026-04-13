/**
 * Recent Projects — persists the list of recently-opened project folders so
 * the FolderGate welcome screen can show them as the primary affordance.
 *
 * Storage: `<userData>/recent-projects.json` (e.g. on macOS this resolves to
 * `~/Library/Application Support/<app-name>/recent-projects.json`).
 *
 * The file is a single JSON object:
 *   { entries: [{ path, openedAt, pinned? }, …] }
 *
 * Policies:
 * - Keep at most `MAX_ENTRIES` entries, newest first.
 * - Adding an existing path moves it to the front (LRU semantics).
 * - Pinned entries are sorted to the top and not evicted by LRU.
 * - Stale entries (path no longer exists on disk) are dropped on read.
 *
 * This module is intentionally synchronous and self-contained — called only
 * from the main process.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

export interface RecentProjectEntry {
  path: string
  openedAt: string   // ISO timestamp
  pinned?: boolean
}

interface StoreShape {
  entries: RecentProjectEntry[]
}

const MAX_ENTRIES = 10

// ── File helpers ───────────────────────────────────────────────────────────

function storeFilePath(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

function readStore(): StoreShape {
  const path = storeFilePath()
  if (!existsSync(path)) return { entries: [] }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] }
    // Basic shape validation — drop any entry missing a path string.
    const cleaned = parsed.entries.filter(
      (e): e is RecentProjectEntry =>
        !!e && typeof e.path === 'string' && typeof e.openedAt === 'string',
    )
    return { entries: cleaned }
  } catch {
    return { entries: [] }
  }
}

function writeStore(store: StoreShape): void {
  const path = storeFilePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Atomic write: tmp + rename so a crash mid-write doesn't corrupt the file.
  const tmp = path + '.tmp.' + randomUUID().slice(0, 8)
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, path)
}

// ── Sorting / invariants ───────────────────────────────────────────────────

function sortEntries(entries: RecentProjectEntry[]): RecentProjectEntry[] {
  // Pinned first, then most-recent first within each group.
  return [...entries].sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    if (pinDiff !== 0) return pinDiff
    return b.openedAt.localeCompare(a.openedAt)
  })
}

function enforceCap(entries: RecentProjectEntry[]): RecentProjectEntry[] {
  const pinned = entries.filter(e => e.pinned)
  const unpinned = entries.filter(e => !e.pinned)
  const keepUnpinned = unpinned.slice(0, Math.max(0, MAX_ENTRIES - pinned.length))
  return [...pinned, ...keepUnpinned]
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Return recent project entries, sorted (pinned → recent). Stale entries
 * whose paths no longer exist on disk are removed from the returned list
 * AND persisted out, so callers always see a clean state.
 */
export function listRecentProjects(): RecentProjectEntry[] {
  const store = readStore()
  const alive = store.entries.filter(e => existsSync(e.path))
  if (alive.length !== store.entries.length) {
    writeStore({ entries: alive })
  }
  return sortEntries(alive)
}

/**
 * Record a project folder as just-opened. Moves an existing entry to the
 * front (preserving its `pinned` flag), or adds a new one. Enforces the
 * entry cap.
 */
export function addRecentProject(projectPath: string): void {
  if (!projectPath) return
  const store = readStore()
  const existing = store.entries.find(e => e.path === projectPath)
  const pinned = existing?.pinned
  const next = store.entries.filter(e => e.path !== projectPath)
  next.unshift({ path: projectPath, openedAt: new Date().toISOString(), pinned })
  writeStore({ entries: enforceCap(sortEntries(next)) })
}

/** Remove a single entry. Returns the number of entries removed (0 or 1). */
export function removeRecentProject(projectPath: string): number {
  const store = readStore()
  const next = store.entries.filter(e => e.path !== projectPath)
  if (next.length === store.entries.length) return 0
  writeStore({ entries: next })
  return 1
}

/** Flip the pinned flag on an existing entry. No-op if the entry is unknown. */
export function setRecentProjectPinned(projectPath: string, pinned: boolean): void {
  const store = readStore()
  const idx = store.entries.findIndex(e => e.path === projectPath)
  if (idx < 0) return
  store.entries[idx] = { ...store.entries[idx], pinned }
  writeStore({ entries: enforceCap(sortEntries(store.entries)) })
}
