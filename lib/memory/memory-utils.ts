/**
 * Auto-Memory — file operations, index management, migration.
 *
 * Memory files live in `.research-pilot/memory/` as standalone Markdown with YAML frontmatter.
 * agent.md's "## Agent Memory" section serves as a compact index of links to these files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { PATHS, AGENT_MD_ID, AGENT_MD_MAX_CHARS, type NoteArtifact } from '../types.js'
import { findArtifactById, updateArtifact } from '../memory-v2/store.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
}

export interface MemoryEntry {
  frontmatter: MemoryFrontmatter
  content: string
  filename: string
}

// ─── Filename helpers ───────────────────────────────────────────────────────

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  // If the slug is empty or very short (non-Latin input), use a stable hash suffix
  if (slug.length < 3) {
    const hash = createHash('sha256').update(text.toLowerCase().trim()).digest('hex').slice(0, 12)
    return slug ? `${slug}-${hash}` : hash
  }
  return slug
}

export function memoryFilename(type: MemoryType, name: string): string {
  return `${type}_${slugify(name)}.md`
}

// ─── Directory helpers ──────────────────────────────────────────────────────

export function memoryDir(projectPath: string): string {
  return join(projectPath, PATHS.memory)
}

export function ensureMemoryDir(projectPath: string): void {
  const dir = memoryDir(projectPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── File I/O ───────────────────────────────────────────────────────────────

/** YAML-safe value: wrap in quotes if the string contains special characters */
function yamlSafe(value: string): string {
  if (!value) return '""'
  // Needs quoting if contains: colon, hash, bracket, brace, quote, newline, leading/trailing space
  if (/[:\#{}\[\]"'`\n\r|>]/.test(value) || value !== value.trim()) {
    // Escape backslashes and double-quotes, then wrap in double quotes
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    return `"${escaped}"`
  }
  return value
}

function formatFrontmatter(fm: MemoryFrontmatter): string {
  return [
    '---',
    `name: ${yamlSafe(fm.name)}`,
    `description: ${yamlSafe(fm.description)}`,
    `type: ${fm.type}`,
    '---'
  ].join('\n')
}

/** Unescape a YAML value that may be double-quoted */
function yamlUnescape(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function parseFrontmatter(text: string): { frontmatter: MemoryFrontmatter; body: string } | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  const fm: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) fm[kv[1]] = yamlUnescape(kv[2])
  }
  if (!fm.name || !fm.type) return null
  const validTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference']
  if (!validTypes.includes(fm.type as MemoryType)) return null
  return {
    frontmatter: { name: fm.name, description: fm.description || '', type: fm.type as MemoryType },
    body: match[2].trim()
  }
}

export function writeMemoryFile(projectPath: string, entry: MemoryEntry): string {
  ensureMemoryDir(projectPath)
  const filePath = join(memoryDir(projectPath), entry.filename)
  const content = `${formatFrontmatter(entry.frontmatter)}\n\n${entry.content}\n`
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function readMemoryFile(projectPath: string, filename: string): MemoryEntry | null {
  const filePath = join(memoryDir(projectPath), filename)
  if (!existsSync(filePath)) return null
  try {
    const text = readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(text)
    if (!parsed) return null
    return { frontmatter: parsed.frontmatter, content: parsed.body, filename }
  } catch {
    return null
  }
}

export function deleteMemoryFile(projectPath: string, filename: string): boolean {
  const filePath = join(memoryDir(projectPath), filename)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

export function listMemoryFiles(projectPath: string): MemoryEntry[] {
  const dir = memoryDir(projectPath)
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    const entries: MemoryEntry[] = []
    for (const filename of files) {
      const entry = readMemoryFile(projectPath, filename)
      if (entry) entries.push(entry)
    }
    return entries
  } catch {
    return []
  }
}

export function findMemoryByName(projectPath: string, name: string, type?: MemoryType): MemoryEntry | null {
  const lower = name.toLowerCase()
  const entries = listMemoryFiles(projectPath)
  return entries.find(e =>
    e.frontmatter.name.toLowerCase() === lower &&
    (!type || e.frontmatter.type === type)
  ) ?? null
}

/** Find all memories with the given name (there may be multiple if different types share a name) */
export function findAllMemoriesByName(projectPath: string, name: string): MemoryEntry[] {
  const lower = name.toLowerCase()
  return listMemoryFiles(projectPath).filter(e => e.frontmatter.name.toLowerCase() === lower)
}

// ─── Agent.md index write lock (in-process mutex) ─────────────────────────

let _indexWriteLock: Promise<void> = Promise.resolve()

/**
 * Serialize agent.md index writes to prevent concurrent read-modify-write races
 * between save-memory tool calls and background extractor.
 */
export function withIndexLock<T>(fn: () => T): Promise<T> {
  const next = _indexWriteLock.then(fn, fn)
  // Chain regardless of success/failure so the queue doesn't break
  _indexWriteLock = next.then(() => {}, () => {})
  return next
}

// ─── Agent.md index management ──────────────────────────────────────────────

export function buildMemoryIndex(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  return entries
    .map(e => {
      const desc = e.frontmatter.description.slice(0, 100).replace(/\n/g, ' ')
      return `- [${e.frontmatter.name}](memory/${e.filename}) — ${desc}`
    })
    .join('\n')
}

/**
 * Rebuild the Agent Memory section of agent.md from the current memory files.
 * Preserves the User Instructions section untouched.
 */
export function updateAgentMdIndex(
  projectPath: string,
  entries: MemoryEntry[]
): { success: boolean; charCount: number } {
  const record = findArtifactById(projectPath, AGENT_MD_ID)
  const currentContent = record?.artifact?.type === 'note'
    ? (record.artifact as NoteArtifact).content || ''
    : ''

  // Extract User Instructions (everything before ## Agent Memory)
  const marker = '## Agent Memory'
  const markerIdx = currentContent.indexOf(marker)
  const userInstructions = markerIdx >= 0
    ? currentContent.slice(0, markerIdx).trimEnd()
    : currentContent.trimEnd()

  // Build new content
  const indexContent = buildMemoryIndex(entries)
  const newContent = indexContent
    ? `${userInstructions}\n\n${marker}\n\n${indexContent}\n`
    : `${userInstructions}\n\n${marker}\n`

  if (newContent.length > AGENT_MD_MAX_CHARS) {
    return { success: false, charCount: newContent.length }
  }

  updateArtifact(projectPath, AGENT_MD_ID, { content: newContent })
  return { success: true, charCount: newContent.length }
}

// ─── Migration ──────────────────────────────────────────────────────────────

/**
 * One-time migration: if agent.md has old-style free-text in ## Agent Memory,
 * save it as a memory file and replace with an index.
 */
export function migrateAgentMemoryToFile(projectPath: string): boolean {
  const record = findArtifactById(projectPath, AGENT_MD_ID)
  if (!record) return false

  const content = record.artifact?.type === 'note'
    ? (record.artifact as NoteArtifact).content || ''
    : ''

  const marker = '## Agent Memory'
  const markerIdx = content.indexOf(marker)
  if (markerIdx < 0) return false

  const agentMemory = content.slice(markerIdx + marker.length).trim()

  // Skip if empty or already looks like an index (contains markdown links to memory/)
  if (!agentMemory || /\[.*\]\(memory\/.*\)/.test(agentMemory)) return false

  // Skip if already migrated (legacy-notes file exists)
  const legacyFilename = memoryFilename('project', 'legacy-notes')
  const legacyPath = join(memoryDir(projectPath), legacyFilename)
  if (existsSync(legacyPath)) return false

  // Save old content as a memory file
  ensureMemoryDir(projectPath)
  const entry: MemoryEntry = {
    frontmatter: {
      name: 'Legacy notes',
      description: 'Migrated from agent.md Agent Memory section',
      type: 'project'
    },
    content: agentMemory,
    filename: memoryFilename('project', 'legacy-notes')
  }
  writeMemoryFile(projectPath, entry)

  // Rebuild index
  const allEntries = listMemoryFiles(projectPath)
  updateAgentMdIndex(projectPath, allEntries)

  return true
}
