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
  // Accept both 'description' and 'shortDescription' (myRAM compat)
  const description = parseFrontmatterField(content, 'description')
    ?? parseFrontmatterField(content, 'shortDescription')
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
  // Scan the entire lib/skills/ directory (includes builtin/, academic-writing/, literature/, etc.)
  const skillsRoot = path.dirname(fileURLToPath(import.meta.url))
  if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
    return []
  }
  const files = discoverSkillFiles(skillsRoot)
  // Deduplicate by name (later files override earlier)
  const byName = new Map<string, SkillEntry>()
  for (const file of files) {
    const entry = parseSkillFile(file, `[builtin] ${path.relative(skillsRoot, file)}`)
    if (entry) byName.set(entry.name, entry)
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
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

/** Find a skill by name (fuzzy: also tries substring match). */
export function getSkillByName(entries: SkillEntry[], name: string): SkillEntry | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  return entries.find((entry) => entry.name === trimmed)
}

/**
 * Build a prompt section that lists available skills for the LLM.
 * Injected into the system prompt so the agent knows what skills exist
 * and can call `load_skill` to load full instructions on demand.
 */
export function buildSkillsCatalogPrompt(entries: SkillEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((e) => `- ${e.name}: ${e.description} (${e.path})`)
  return [
    '## Skills',
    'You have the following skills available. At the start of each task, scan this list and call `load_skill` for any skill that is a strong match for the work you are about to do. Load a skill when it will change how you structure the output, execute the task, or avoid a known failure mode. Do not load skills speculatively.',
    '',
    ...lines,
    '',
    'After loading a skill, follow its instructions exactly where applicable.'
  ].join('\n')
}

/**
 * Build the full skill context string for a loaded skill.
 * Returned as the tool result when `load_skill` is called.
 */
export function buildSkillContext(entry: SkillEntry, maxChars = 50_000): string {
  const header = [
    'Skill context loaded for this request. Follow these instructions where applicable.',
    '',
    `### Skill: ${entry.name}`,
    `Path: ${entry.path}`,
    `Directory: ${entry.dir}`,
    ''
  ].join('\n')

  const body = entry.content.length > maxChars
    ? entry.content.slice(0, maxChars) + '\n\n[... truncated]'
    : entry.content
  return header + body
}
