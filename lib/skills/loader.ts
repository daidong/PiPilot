/**
 * Skills loader for Research Copilot.
 *
 * Discovers and parses SKILL.md files from three locations:
 * 1. Built-in skills: lib/skills/builtin/ (shipped with app)
 * 2. Workspace skills: .research-pilot/skills/ (per-project)
 * 3. User skills: ~/.research-pilot/skills/ (user-global)
 *
 * Adapted from myRAM's skills.ts with simplified settings.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_FILE_NAME = 'SKILL.md'
const MAX_SCAN_DEPTH = 3

export interface SkillEntry {
  name: string
  description: string
  path: string
  dir: string       // Absolute path to skill directory (for running scripts)
  content: string
}

export interface SkillCatalogItem {
  name: string
  description: string
  path: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse a top-level field from YAML frontmatter.
 * Only matches lines that are NOT indented (top-level keys).
 */
function parseFrontmatterField(content: string, field: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return undefined
  const body = match[1]
  const line = body
    .split('\n')
    .find((l) => l.match(new RegExp(`^${field}:\\s`)))
  if (!line) return undefined
  const value = line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '')
  return value || undefined
}

function discoverSkillFiles(rootDir: string): string[] {
  const files: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(current.dir, entry.name)
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        files.push(abs)
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (current.depth >= MAX_SCAN_DEPTH) continue
      stack.push({ dir: abs, depth: current.depth + 1 })
    }
  }

  return files
}

/**
 * Parse a SKILL.md file into a SkillEntry.
 * Requires frontmatter with `name:` and `description:`.
 * Returns null if either is missing.
 */
function parseSkillFile(skillFile: string, displayPath: string): SkillEntry | null {
  const content = safeReadText(skillFile)
  if (!content) return null
  const name = parseFrontmatterField(content, 'name')
  const description = parseFrontmatterField(content, 'description')
  if (!name || !description) return null
  return {
    name,
    description,
    path: displayPath,
    dir: path.dirname(skillFile),
    content
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load built-in skills that ship with the software. */
export function loadBuiltinSkills(): SkillEntry[] {
  // Resolve relative to this file: lib/skills/loader.ts -> lib/skills/builtin/
  const thisDir = path.dirname(fileURLToPath(import.meta.url))
  const builtinRoot = path.resolve(thisDir, 'builtin')
  if (!fs.existsSync(builtinRoot) || !fs.statSync(builtinRoot).isDirectory()) {
    return []
  }
  const files = discoverSkillFiles(builtinRoot)
  const entries = files
    .map((file) => parseSkillFile(file, `[builtin] ${path.relative(builtinRoot, file)}`))
    .filter((entry): entry is SkillEntry => entry !== null)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load workspace-level skills from .research-pilot/skills/. */
export function loadWorkspaceSkills(workspacePath: string): SkillEntry[] {
  const skillRoot = path.resolve(workspacePath, '.research-pilot', 'skills')
  if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory()) {
    return []
  }
  const files = discoverSkillFiles(skillRoot)
  const entries = files
    .map((file) => parseSkillFile(file, path.relative(workspacePath, file)))
    .filter((entry): entry is SkillEntry => entry !== null)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load user-global skills from ~/.research-pilot/skills/. */
function loadUserSkills(): SkillEntry[] {
  const userRoot = path.resolve(os.homedir(), '.research-pilot', 'skills')
  if (!fs.existsSync(userRoot) || !fs.statSync(userRoot).isDirectory()) {
    return []
  }
  const files = discoverSkillFiles(userRoot)
  const entries = files
    .map((file) => parseSkillFile(file, `[user] ~/.research-pilot/skills/${path.relative(userRoot, file)}`))
    .filter((entry): entry is SkillEntry => entry !== null)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Load all skills: built-in + user-global + workspace.
 * Override order (highest wins): workspace > user-global > built-in.
 */
export function loadAllSkills(workspacePath: string): SkillEntry[] {
  const builtin = loadBuiltinSkills()
  const user = loadUserSkills()
  const workspace = loadWorkspaceSkills(workspacePath)

  const userNames = new Set(user.map((s) => s.name))
  const workspaceNames = new Set(workspace.map((s) => s.name))
  const merged = [
    ...builtin.filter((s) => !userNames.has(s.name) && !workspaceNames.has(s.name)),
    ...user.filter((s) => !workspaceNames.has(s.name)),
    ...workspace
  ]
  return merged.sort((a, b) => a.name.localeCompare(b.name))
}

/** Build a catalog (summary without content) for UI display. */
export function buildSkillsCatalog(entries: SkillEntry[]): SkillCatalogItem[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    path: entry.path
  }))
}

/** Find a skill by name. */
export function getSkillByName(entries: SkillEntry[], name: string): SkillEntry | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  return entries.find((entry) => entry.name === trimmed)
}
