/**
 * Wiki Lock — single-writer concurrency control.
 *
 * Two mechanisms:
 * 1. In-process serial queue (withWikiLock) — prevents concurrent processSinglePass() within one app
 * 2. Cross-process lock file (wiki.lock + PID) — prevents concurrent writes from multiple app instances
 *    Uses O_CREAT|O_EXCL for atomic creation (no TOCTOU race).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync, unlinkSync, openSync, closeSync, constants } from 'fs'
import { join } from 'path'
import { getWikiRoot } from './types.js'

// ── In-process serial queue ────────────────────────────────────────────────
// Same pattern as withIndexLock in lib/memory/memory-utils.ts

let _wikiLock: Promise<void> = Promise.resolve()

export function withWikiLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = _wikiLock.then(fn, fn)
  _wikiLock = next.then(() => {}, () => {})
  return next
}

// ── Cross-process lock file ────────────────────────────────────────────────

function lockFilePath(): string {
  return join(getWikiRoot(), '.state', 'wiki.lock')
}

/**
 * Try to acquire the cross-process lock atomically.
 *
 * Uses O_CREAT|O_EXCL which fails atomically if the file already exists,
 * eliminating the check-then-write TOCTOU race.
 *
 * If the file already exists, checks whether the holding PID is alive.
 * If dead (stale lock), removes it and retries once.
 */
export function acquireProcessLock(): boolean {
  const lockPath = lockFilePath()
  const stateDir = join(getWikiRoot(), '.state')
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  // Attempt 1: atomic exclusive create
  if (tryExclusiveCreate(lockPath)) return true

  // File exists — check if stale
  try {
    const content = readFileSync(lockPath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    if (pid && isProcessAlive(pid)) {
      return false  // held by another living process
    }
    // Stale lock — remove and retry
    try { unlinkSync(lockPath) } catch { /* concurrent removal is fine */ }
  } catch {
    // Can't read — try removing
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }

  // Attempt 2: retry after stale removal
  return tryExclusiveCreate(lockPath)
}

/**
 * Atomically create lock file with O_CREAT|O_EXCL and write our PID.
 * Returns true if we created it, false if it already existed.
 */
function tryExclusiveCreate(lockPath: string): boolean {
  try {
    // O_CREAT|O_EXCL|O_WRONLY: fails with EEXIST if file already exists (atomic)
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
    const pidBuf = Buffer.from(String(process.pid))
    writeSync(fd, pidBuf)
    closeSync(fd)
    return true
  } catch (err: any) {
    if (err.code === 'EEXIST') return false
    // Other error (permissions etc.) — treat as lock failure
    return false
  }
}

export function releaseProcessLock(): void {
  const lockPath = lockFilePath()
  try {
    if (existsSync(lockPath)) {
      const content = readFileSync(lockPath, 'utf-8').trim()
      const pid = parseInt(content, 10)
      if (pid === process.pid) {
        unlinkSync(lockPath)
      }
    }
  } catch {
    // Best effort
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)  // signal 0 = existence check
    return true
  } catch {
    return false
  }
}
