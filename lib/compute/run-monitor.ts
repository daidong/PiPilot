/**
 * Shared run-output monitoring helpers for compute runners.
 *
 * The Local, Modal, and EC2 runners all tail a growing log file to surface
 * progress: read the last N bytes, measure total size, and estimate line
 * count. Those three functions were byte-for-byte identical across all three
 * runners; they live here now so a fix lands once.
 *
 * NOTE on stall semantics — deliberately NOT unified here. Local models a
 * stall as a non-terminal *status* (`status: 'stalled'`, which exists only in
 * its RunState union); Modal and EC2 model it as a boolean *flag*
 * (`stalled: true`) while status stays `'running'`. That difference is a
 * per-backend modeling choice, not drift, so each runner keeps its own stall
 * branch. `exceededStallThreshold` below shares only the time arithmetic.
 */

import fs from 'node:fs'

/** Read the last `maxBytes` bytes of a file as UTF-8. Returns '' on any error. */
export function readFileTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size === 0) return ''
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf-8')
  } catch {
    return ''
  }
}

/** Current size of a file in bytes. Returns 0 if it doesn't exist / can't stat. */
export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/**
 * Estimate total line count from total bytes and a sampled tail. When the
 * tail covers the whole file we count exactly; otherwise we extrapolate the
 * tail's line density across the full byte length.
 */
export function estimateLines(bytes: number, tail: string): number {
  if (bytes === 0 || tail.length === 0) return 0
  const tailLines = tail.split('\n').length
  if (tail.length >= bytes) return tailLines
  return Math.max(tailLines, Math.round((bytes / tail.length) * tailLines))
}

/**
 * True when more than `stallThresholdMs` has elapsed since the last output.
 * `lastOutputAt` is an ISO timestamp string (or undefined when no output has
 * been seen yet, in which case we report no stall).
 */
export function exceededStallThreshold(
  lastOutputAt: string | undefined,
  stallThresholdMs: number,
  now: number = Date.now(),
): boolean {
  if (!lastOutputAt) return false
  return now - new Date(lastOutputAt).getTime() > stallThresholdMs
}
