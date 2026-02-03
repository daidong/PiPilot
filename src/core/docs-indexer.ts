/**
 * DocsIndexer - Document indexing and search
 *
 * Features:
 * - Scans directories for documents
 * - Extracts metadata, titles, outlines from markdown
 * - Chunks documents by token count
 * - Builds inverted keyword index
 * - Supports incremental updates
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type {
  DocsIndex,
  DocsIndexConfig,
  DocsIndexStats,
  DocumentEntry,
  DocChunk,
  DocOutlineEntry,
  DocsIndexer,
  DocsIndexerOptions,
  DocsSearchResult
} from '../types/docs.js'
import { generateDocId, generateChunkId, detectDocType } from '../types/docs.js'

// ============ Tokenization ============

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how'
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2 && word.length <= 30)
    .filter(word => !STOP_WORDS.has(word))
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4)
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16)
}

// ============ Markdown Parsing ============

interface ParsedMarkdown {
  title: string
  outline: DocOutlineEntry[]
  frontmatter: Record<string, unknown>
}

function parseMarkdown(content: string, filename: string): ParsedMarkdown {
  const lines = content.split('\n')
  const outline: DocOutlineEntry[] = []
  let title = path.basename(filename, path.extname(filename))
  let frontmatter: Record<string, unknown> = {}

  // Parse YAML frontmatter
  if (lines[0]?.trim() === '---') {
    let endIndex = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        endIndex = i
        break
      }
    }
    if (endIndex > 0) {
      const yamlContent = lines.slice(1, endIndex).join('\n')
      try {
        // Simple YAML parsing (key: value pairs)
        for (const line of yamlContent.split('\n')) {
          const match = line.match(/^(\w+):\s*(.*)$/)
          if (match) {
            const [, key, value] = match
            frontmatter[key!] = value?.trim()
          }
        }
        if (frontmatter.title) {
          title = String(frontmatter.title)
        }
      } catch {
        // Ignore frontmatter parsing errors
      }
    }
  }

  // Parse headings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1]!.length
      const headingTitle = match[2]!.trim()
      outline.push({
        level,
        title: headingTitle,
        line: i + 1
      })

      // Use first H1 as title if not set
      if (level === 1 && title === path.basename(filename, path.extname(filename))) {
        title = headingTitle
      }
    }
  }

  return { title, outline, frontmatter }
}

// ============ Chunking ============

interface ChunkResult {
  chunks: DocChunk[]
  totalTokens: number
}

function chunkDocument(
  content: string,
  docId: string,
  chunkSize: number,
  chunkOverlap: number
): ChunkResult {
  const lines = content.split('\n')
  const chunks: DocChunk[] = []
  let currentChunk: string[] = []
  let currentTokens = 0
  let startLine = 1
  let chunkIndex = 0
  let totalTokens = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineTokens = estimateTokens(line)
    totalTokens += lineTokens

    currentChunk.push(line)
    currentTokens += lineTokens

    // Check if chunk is full
    if (currentTokens >= chunkSize) {
      const chunkContent = currentChunk.join('\n')
      const keywords = [...new Set(tokenize(chunkContent))].slice(0, 20)

      chunks.push({
        id: generateChunkId(docId, chunkIndex),
        startLine,
        endLine: i + 1,
        tokens: currentTokens,
        keywords
      })

      chunkIndex++

      // Handle overlap
      const overlapLines = Math.ceil(chunkOverlap / (chunkSize / currentChunk.length))
      const keepLines = Math.min(overlapLines, currentChunk.length)
      currentChunk = currentChunk.slice(-keepLines)
      currentTokens = currentChunk.reduce((sum, l) => sum + estimateTokens(l), 0)
      startLine = i + 2 - keepLines
    }
  }

  // Handle remaining content
  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join('\n')
    const keywords = [...new Set(tokenize(chunkContent))].slice(0, 20)

    chunks.push({
      id: generateChunkId(docId, chunkIndex),
      startLine,
      endLine: lines.length,
      tokens: currentTokens,
      keywords
    })
  }

  return { chunks, totalTokens }
}

// ============ FileDocsIndexer ============

export class FileDocsIndexer implements DocsIndexer {
  private projectPath: string
  private indexPath: string
  private index: DocsIndex | null = null

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.indexPath = path.join(projectPath, '.agent-foundry', 'docs_index.json')
  }

  async build(options: DocsIndexerOptions): Promise<DocsIndex> {
    const {
      paths,
      extensions = ['.md', '.txt'],
      exclude = [],
      chunkSize = 500,
      chunkOverlap = 50,
      outputDir = '.agent-foundry',
      incremental = false,
      verbose = false
    } = options

    // Load existing index if incremental
    let existingDocs: Map<string, DocumentEntry> = new Map()
    if (incremental) {
      const existing = await this.load()
      if (existing) {
        for (const doc of existing.documents) {
          existingDocs.set(doc.path, doc)
        }
      }
    }

    const config: DocsIndexConfig = {
      rootPaths: paths,
      extensions,
      excludePatterns: exclude,
      chunkSize,
      chunkOverlap
    }

    const documents: DocumentEntry[] = []
    const keywordIndex: Record<string, string[]> = {}
    const stats: DocsIndexStats = {
      totalDocuments: 0,
      totalChunks: 0,
      totalTokens: 0,
      byType: {}
    }

    // Scan each path
    for (const rootPath of paths) {
      const absPath = path.isAbsolute(rootPath)
        ? rootPath
        : path.join(this.projectPath, rootPath)

      if (verbose) {
        console.log(`Scanning: ${absPath}`)
      }

      const files = await this.scanDirectory(absPath, extensions, exclude)

      for (const filePath of files) {
        const relativePath = path.relative(this.projectPath, filePath)

        if (verbose) {
          console.log(`  Processing: ${relativePath}`)
        }

        try {
          // Read file
          const content = await fs.readFile(filePath, 'utf-8')
          const fileStat = await fs.stat(filePath)
          const hash = computeHash(content)

          // Check if unchanged in incremental mode
          const existing = existingDocs.get(relativePath)
          if (incremental && existing && existing.hash === hash) {
            documents.push(existing)
            this.addToKeywordIndex(keywordIndex, existing)
            stats.totalDocuments++
            stats.totalChunks += existing.chunks.length
            stats.totalTokens += existing.chunks.reduce((sum, c) => sum + c.tokens, 0)
            stats.byType[existing.type] = (stats.byType[existing.type] ?? 0) + 1
            continue
          }

          // Detect type and parse
          const docType = detectDocType(filePath)
          const docId = generateDocId()

          let title = path.basename(filePath, path.extname(filePath))
          let outline: DocOutlineEntry[] = []
          let metadata: Record<string, unknown> = {}

          if (docType === 'markdown') {
            const parsed = parseMarkdown(content, filePath)
            title = parsed.title
            outline = parsed.outline
            metadata = parsed.frontmatter
          }

          // Chunk document
          const { chunks, totalTokens } = chunkDocument(content, docId, chunkSize, chunkOverlap)

          // Extract all keywords
          const allKeywords = [...new Set(chunks.flatMap(c => c.keywords))]

          const doc: DocumentEntry = {
            id: docId,
            path: relativePath,
            title,
            type: docType,
            size: fileStat.size,
            hash,
            modifiedAt: fileStat.mtime.toISOString(),
            metadata,
            chunks,
            outline,
            keywords: allKeywords
          }

          documents.push(doc)
          this.addToKeywordIndex(keywordIndex, doc)

          stats.totalDocuments++
          stats.totalChunks += chunks.length
          stats.totalTokens += totalTokens
          stats.byType[docType] = (stats.byType[docType] ?? 0) + 1
        } catch (error) {
          if (verbose) {
            console.error(`  Error processing ${relativePath}: ${error}`)
          }
        }
      }
    }

    const now = new Date().toISOString()
    const index: DocsIndex = {
      version: '1.0.0',
      createdAt: incremental && this.index ? this.index.createdAt : now,
      updatedAt: now,
      config,
      stats,
      documents,
      keywords: keywordIndex
    }

    // Save index
    const outputPath = path.join(this.projectPath, outputDir)
    await fs.mkdir(outputPath, { recursive: true })
    await fs.writeFile(
      path.join(outputPath, 'docs_index.json'),
      JSON.stringify(index, null, 2),
      'utf-8'
    )

    this.index = index

    if (verbose) {
      console.log(`\nIndex built:`)
      console.log(`  Documents: ${stats.totalDocuments}`)
      console.log(`  Chunks: ${stats.totalChunks}`)
      console.log(`  Tokens: ${stats.totalTokens}`)
    }

    return index
  }

  private async scanDirectory(
    dirPath: string,
    extensions: string[],
    exclude: string[]
  ): Promise<string[]> {
    const results: string[] = []

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(this.projectPath, fullPath)

        // Check exclude patterns
        if (exclude.some(pattern => this.matchGlob(relativePath, pattern))) {
          continue
        }

        if (entry.isDirectory()) {
          // Skip hidden directories and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue
          }
          const subFiles = await this.scanDirectory(fullPath, extensions, exclude)
          results.push(...subFiles)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (extensions.includes(ext)) {
            results.push(fullPath)
          }
        }
      }
    } catch {
      // Ignore directory access errors
    }

    return results
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // Simple glob matching (supports * and **)
    const regex = pattern
      .replace(/\*\*/g, '{{DOUBLESTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{DOUBLESTAR}}/g, '.*')
      .replace(/\?/g, '.')

    return new RegExp(`^${regex}$`).test(filePath)
  }

  private addToKeywordIndex(index: Record<string, string[]>, doc: DocumentEntry): void {
    for (const keyword of doc.keywords) {
      if (!index[keyword]) {
        index[keyword] = []
      }
      if (!index[keyword].includes(doc.id)) {
        index[keyword].push(doc.id)
      }
    }
  }

  async load(): Promise<DocsIndex | null> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8')
      this.index = JSON.parse(content)
      return this.index
    } catch {
      return null
    }
  }

  async getStats(): Promise<DocsIndexStats | null> {
    const index = this.index ?? await this.load()
    return index?.stats ?? null
  }

  async search(query: string, limit = 20): Promise<DocsSearchResult[]> {
    const index = this.index ?? await this.load()
    if (!index) return []

    const queryKeywords = tokenize(query)
    if (queryKeywords.length === 0) return []

    // Score documents by keyword matches
    const docScores: Map<string, { score: number; keywords: string[] }> = new Map()

    for (const keyword of queryKeywords) {
      const rawDocIds = index.keywords[keyword]
      const matchingDocIds = Array.isArray(rawDocIds) ? rawDocIds : []
      for (const docId of matchingDocIds) {
        const existing = docScores.get(docId) ?? { score: 0, keywords: [] }
        existing.score += 1
        existing.keywords.push(keyword)
        docScores.set(docId, existing)
      }
    }

    // Build document ID to entry map
    const docMap = new Map(index.documents.map(d => [d.id, d]))

    // Build results
    const results: DocsSearchResult[] = []
    for (const [docId, { score, keywords }] of docScores) {
      const doc = docMap.get(docId)
      if (!doc) continue

      // Find matching chunks
      const matchingChunks = doc.chunks
        .filter(c => c.keywords.some(k => queryKeywords.includes(k)))
        .map(c => c.id)

      results.push({
        document: doc,
        score: score / queryKeywords.length,
        matchedKeywords: [...new Set(keywords)],
        matchingChunks
      })
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  async getDocument(docPath: string): Promise<DocumentEntry | null> {
    const index = this.index ?? await this.load()
    if (!index) return null

    return index.documents.find(d => d.path === docPath) ?? null
  }

  async readContent(
    docPath: string,
    startLine = 1,
    lineLimit = 150
  ): Promise<string | null> {
    const fullPath = path.join(this.projectPath, docPath)

    try {
      const content = await fs.readFile(fullPath, 'utf-8')
      const lines = content.split('\n')

      const start = Math.max(0, startLine - 1)
      const end = Math.min(lines.length, start + lineLimit)

      return lines.slice(start, end).join('\n')
    } catch {
      return null
    }
  }
}
