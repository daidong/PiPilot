/**
 * MemoryIndex - SQLite FTS5 search indexer for markdown memory files
 *
 * Indexes markdown files into a SQLite FTS5 database for BM25-based search.
 * Supports file watching for automatic re-indexing on changes.
 */

import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readFileSync, readdirSync, statSync, existsSync, watch } from 'fs'
import { join, resolve } from 'path'
import type { FSWatcher } from 'fs'

export interface SearchResult {
  path: string
  startLine: number
  endLine: number
  snippet: string
  score: number
}

// Approximate tokens per character ratio for chunking (~4 chars per token)
const CHARS_PER_TOKEN = 4
const CHUNK_TOKENS = 300
const OVERLAP_TOKENS = 50
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN

export class MemoryIndex {
  private db!: Database.Database
  private watchers: FSWatcher[] = []
  private syncTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private dbPath: string,
    private watchDirs: string[],
    private extraFiles: string[] = []
  ) {}

  /**
   * Open DB, create tables, run initial sync
   */
  async init(): Promise<void> {
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime_ms INTEGER);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT NOT NULL
      );
    `)

    // Create FTS5 virtual table if it doesn't exist
    // Use a try/catch since "IF NOT EXISTS" isn't supported for virtual tables in all versions
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          content,
          content='chunks',
          content_rowid='id',
          tokenize='porter unicode61'
        );
      `)
    } catch {
      // Table already exists
    }

    // Create triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `)

    await this.sync()
  }

  /**
   * Scan directories and extra files, re-chunk changed/new files, remove deleted ones
   */
  async sync(): Promise<void> {
    const allFiles = this.collectMarkdownFiles()
    const existingFiles = new Map<string, { hash: string; mtime_ms: number }>()

    const rows = this.db.prepare('SELECT path, hash, mtime_ms FROM files').all() as Array<{ path: string; hash: string; mtime_ms: number }>
    for (const row of rows) {
      existingFiles.set(row.path, { hash: row.hash, mtime_ms: row.mtime_ms })
    }

    const currentPaths = new Set<string>()

    const insertFile = this.db.prepare('INSERT OR REPLACE INTO files (path, hash, mtime_ms) VALUES (?, ?, ?)')
    const deleteFileChunks = this.db.prepare('DELETE FROM chunks WHERE file_path = ?')
    const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?')
    const insertChunk = this.db.prepare('INSERT INTO chunks (file_path, start_line, end_line, content) VALUES (?, ?, ?, ?)')

    const syncTransaction = this.db.transaction(() => {
      for (const filePath of allFiles) {
        currentPaths.add(filePath)

        let mtime: number
        try {
          mtime = statSync(filePath).mtimeMs
        } catch {
          continue
        }

        const existing = existingFiles.get(filePath)
        // Quick check: if mtime hasn't changed, skip
        if (existing && Math.abs(existing.mtime_ms - mtime) < 1) {
          continue
        }

        let content: string
        try {
          content = readFileSync(filePath, 'utf-8')
        } catch {
          continue
        }

        const hash = computeHash(content)
        if (existing && existing.hash === hash) {
          // Content unchanged, just update mtime
          insertFile.run(filePath, hash, mtime)
          continue
        }

        // Re-index: delete old chunks, insert new ones
        deleteFileChunks.run(filePath)
        insertFile.run(filePath, hash, mtime)

        const chunks = chunkContent(content)
        for (const chunk of chunks) {
          insertChunk.run(filePath, chunk.startLine, chunk.endLine, chunk.content)
        }
      }

      // Remove files that no longer exist
      for (const [path] of existingFiles) {
        if (!currentPaths.has(path)) {
          deleteFileChunks.run(path)
          deleteFile.run(path)
        }
      }
    })

    syncTransaction()
  }

  /**
   * Search indexed content via FTS5 BM25
   */
  search(query: string, limit = 10): SearchResult[] {
    if (!query.trim()) return []

    // Escape special FTS5 characters and build query
    const sanitized = query.replace(/['"*(){}[\]^~\\:]/g, ' ').trim()
    if (!sanitized) return []

    const stmt = this.db.prepare(`
      SELECT
        c.file_path as path,
        c.start_line as startLine,
        c.end_line as endLine,
        snippet(chunks_fts, 0, '>>>', '<<<', '...', 64) as snippet,
        bm25(chunks_fts) as score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY bm25(chunks_fts)
      LIMIT ?
    `)

    try {
      return stmt.all(sanitized, limit) as SearchResult[]
    } catch {
      return []
    }
  }

  /**
   * Get raw file content, optionally sliced by line range
   */
  get(path: string, startLine?: number, endLine?: number): string | null {
    const absPath = resolve(path)
    if (!existsSync(absPath)) return null

    const content = readFileSync(absPath, 'utf-8')
    if (startLine == null && endLine == null) return content

    const lines = content.split('\n')
    const start = Math.max(0, (startLine ?? 1) - 1)
    const end = endLine != null ? Math.min(lines.length, endLine) : lines.length
    return lines.slice(start, end).join('\n')
  }

  /**
   * Start file watchers on all indexed directories
   */
  startWatcher(): void {
    for (const dir of this.watchDirs) {
      if (!existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith('.md')) return
          this.debouncedSync()
        })
        this.watchers.push(watcher)
      } catch {
        // watch may not be supported on all platforms for recursive
      }
    }
  }

  /**
   * Stop watchers and close database
   */
  close(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    for (const w of this.watchers) {
      w.close()
    }
    this.watchers = []
    if (this.db) {
      this.db.close()
    }
  }

  private debouncedSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.sync().catch(() => {})
    }, 500)
  }

  private collectMarkdownFiles(): string[] {
    const files: string[] = []

    for (const dir of this.watchDirs) {
      if (!existsSync(dir)) continue
      try {
        const entries = readdirSync(dir, { recursive: true }) as string[]
        for (const entry of entries) {
          if (typeof entry === 'string' && entry.endsWith('.md')) {
            files.push(resolve(join(dir, entry)))
          }
        }
      } catch {
        // Directory may not exist or not be readable
      }
    }

    for (const file of this.extraFiles) {
      const abs = resolve(file)
      if (existsSync(abs) && abs.endsWith('.md')) {
        if (!files.includes(abs)) {
          files.push(abs)
        }
      }
    }

    return files
  }
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

interface Chunk {
  startLine: number
  endLine: number
  content: string
}

function chunkContent(content: string): Chunk[] {
  const lines = content.split('\n')
  if (lines.length === 0) return []

  const chunks: Chunk[] = []
  let i = 0

  while (i < lines.length) {
    // Accumulate lines until we hit ~CHUNK_CHARS
    let charCount = 0
    const startLine = i + 1 // 1-based
    let j = i

    while (j < lines.length && charCount < CHUNK_CHARS) {
      charCount += (lines[j]?.length ?? 0) + 1 // +1 for newline
      j++
    }

    const endLine = j // 1-based inclusive
    const chunkText = lines.slice(i, j).join('\n')
    if (chunkText.trim()) {
      chunks.push({ startLine, endLine, content: chunkText })
    }

    // Advance with overlap
    const overlapLines = Math.max(1, Math.floor(OVERLAP_CHARS / (charCount / Math.max(1, j - i))))
    i = Math.max(i + 1, j - overlapLines)
  }

  return chunks
}
