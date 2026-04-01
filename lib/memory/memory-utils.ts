/**
 * Auto-Memory — file operations, index management, migration.
 *
 * Memory files live in `.research-pilot/memory/` as standalone Markdown with YAML frontmatter.
 * agent.md's "## Agent Memory" section serves as a compact index of links to these files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
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
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
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

function formatFrontmatter(fm: MemoryFrontmatter): string {
  return [
    '---',
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `type: ${fm.type}`,
    '---'
  ].join('\n')
}

function parseFrontmatter(text: string): { frontmatter: MemoryFrontmatter; body: string } | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  const fm: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
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

export function findMemoryByName(projectPath: string, name: string): MemoryEntry | null {
  const lower = name.toLowerCase()
  return listMemoryFiles(projectPath).find(e => e.frontmatter.name.toLowerCase() === lower) ?? null
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
