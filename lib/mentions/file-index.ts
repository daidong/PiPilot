/**
 * File Index
 *
 * Cached file listing for mention autocomplete.
 * Uses `git ls-files` (fast, respects .gitignore) with a sync walkFiles fallback
 * for non-git directories. Results are cached with a 5-second throttle.
 */

import { execFile } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const REFRESH_THROTTLE_MS = 5_000
const MAX_FILES = 5_000
const MAX_DEPTH = 8

const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.research-pilot', '.agentfoundry',
  'dist', 'out', '.next', '.venv', 'venv'
])

interface FileCache {
  files: string[]
  lastRefreshAt: number
  refreshPromise: Promise<string[]> | null
}

const caches = new Map<string, FileCache>()

function getOrCreateCache(projectPath: string): FileCache {
  let c = caches.get(projectPath)
  if (!c) {
    c = { files: [], lastRefreshAt: 0, refreshPromise: null }
    caches.set(projectPath, c)
  }
  return c
}

/**
 * Get a cached list of workspace files.
 * First call runs git ls-files (or walkFiles fallback). Subsequent calls
 * return the cache until REFRESH_THROTTLE_MS elapses.
 * Each project path gets its own independent cache.
 */
export async function getFileList(projectPath: string): Promise<string[]> {
  const c = getOrCreateCache(projectPath)

  const now = Date.now()
  if (c.files.length > 0 && now - c.lastRefreshAt < REFRESH_THROTTLE_MS) {
    return c.files
  }

  // Prevent concurrent refreshes
  if (c.refreshPromise) return c.refreshPromise

  c.refreshPromise = refreshFileList(projectPath, c).finally(() => {
    c.refreshPromise = null
  })
  return c.refreshPromise
}

/** Force the next getFileList call to rebuild. */
export function invalidateFileIndex(projectPath?: string): void {
  if (projectPath) {
    const c = caches.get(projectPath)
    if (c) c.lastRefreshAt = 0
  } else {
    for (const c of caches.values()) c.lastRefreshAt = 0
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function refreshFileList(projectPath: string, c: FileCache): Promise<string[]> {
  try {
    const files = await gitLsFiles(projectPath)
    c.files = files.slice(0, MAX_FILES)
  } catch {
    // Not a git repo or git not available — fall back to sync walk
    c.files = walkFilesSync(projectPath)
  }
  c.lastRefreshAt = Date.now()
  return c.files
}

function gitLsFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '-c', '-o', '--exclude-standard'],
      { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 5_000 },
      (err, stdout) => {
        if (err) return reject(err)
        const files = stdout.split('\n').filter(Boolean)
        if (files.length === 0) return reject(new Error('empty'))
        resolve(files)
      }
    )
  })
}

/**
 * Synchronous recursive walk used as a fallback when git is unavailable.
 * Preserves the same limits and skip-rules as the old walkFiles.
 */
function walkFilesSync(root: string): string[] {
  const out: string[] = []
  walk(root, '', 0, out)
  return out
}

function walk(root: string, rel: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  const dir = rel ? join(root, rel) : root
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }

  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (out.length >= MAX_FILES) return
    const childRel = rel ? `${rel}/${name}` : name
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walk(root, childRel, depth + 1, out)
    } else {
      out.push(childRel)
    }
  }
}
