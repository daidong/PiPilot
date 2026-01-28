/**
 * Document Cache
 *
 * Caches converted markdown from binary documents (PDF, DOCX, etc.)
 * to avoid re-processing on subsequent @-mentions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename } from 'path'
import { PATHS } from '../types.js'

interface CacheEntry {
  /** Original file path */
  sourcePath: string
  /** Source file modification time (ms since epoch) */
  sourceMtime: number
  /** Converted markdown content */
  markdown: string
  /** When the cache was created */
  cachedAt: string
}

/**
 * Generate a cache key from file path and modification time.
 * This ensures cache invalidation when the source file changes.
 */
function getCacheKey(filePath: string, mtime: number): string {
  const hash = createHash('sha256')
    .update(`${filePath}:${mtime}`)
    .digest('hex')
    .slice(0, 16)
  const name = basename(filePath).replace(/[^a-zA-Z0-9.-]/g, '_')
  return `${name}-${hash}.json`
}

/**
 * Get the cache directory path, creating it if needed.
 */
function ensureCacheDir(projectPath: string): string {
  const cacheDir = join(projectPath, PATHS.documentCache)
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true })
  }
  return cacheDir
}

/**
 * Check if a cached markdown version exists for a document file.
 * Returns the cached markdown if valid, or null if not cached/stale.
 */
export function getCachedMarkdown(
  filePath: string,
  projectPath: string
): string | null {
  try {
    const stat = statSync(filePath)
    const mtime = stat.mtimeMs

    const cacheDir = join(projectPath, PATHS.documentCache)
    const cacheKey = getCacheKey(filePath, mtime)
    const cachePath = join(cacheDir, cacheKey)

    if (!existsSync(cachePath)) {
      return null
    }

    const entry: CacheEntry = JSON.parse(readFileSync(cachePath, 'utf-8'))

    // Validate cache entry
    if (entry.sourcePath !== filePath || entry.sourceMtime !== mtime) {
      // Cache key collision or stale entry
      return null
    }

    return entry.markdown
  } catch {
    return null
  }
}

/**
 * Save converted markdown to cache.
 */
export function setCachedMarkdown(
  filePath: string,
  markdown: string,
  projectPath: string
): void {
  try {
    const stat = statSync(filePath)
    const mtime = stat.mtimeMs

    const cacheDir = ensureCacheDir(projectPath)
    const cacheKey = getCacheKey(filePath, mtime)
    const cachePath = join(cacheDir, cacheKey)

    const entry: CacheEntry = {
      sourcePath: filePath,
      sourceMtime: mtime,
      markdown,
      cachedAt: new Date().toISOString()
    }

    writeFileSync(cachePath, JSON.stringify(entry, null, 2), 'utf-8')
  } catch (err) {
    // Cache write failure is non-fatal, just log
    console.warn('[document-cache] Failed to cache markdown:', err)
  }
}

/**
 * Extract file path from a file:// URI.
 */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) {
    return null
  }
  // Remove file:// prefix and decode URI components
  return decodeURIComponent(uri.slice(7))
}
