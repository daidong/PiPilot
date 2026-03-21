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

/**
 * Override for the builtin skills root directory.
 * Must be set by the host (e.g. Electron main process) before loading skills,
 * because `import.meta.url` resolves incorrectly after Vite bundling.
 */
let _builtinSkillsRoot: string | null = null

export function setBuiltinSkillsRoot(dir: string): void {
  _builtinSkillsRoot = dir
}

export interface SkillEntry {
  name: string
  description: string
  category: string
  depends: string[]
  tags: string[]
  triggers: string[]  // Keywords/phrases that should trigger this skill
  path: string
  dir: string       // Absolute path to skill directory (for running scripts)
  source: 'builtin' | 'user' | 'workspace'
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

/**
 * Parse a YAML inline array field like `tags: [a, b, c]` or `depends: [x, y]`.
 */
function parseFrontmatterArrayField(content: string, field: string): string[] {
  const raw = parseFrontmatterField(content, field)
  if (!raw) return []
  // Handle inline YAML array: [item1, item2, item3]
  const arrayMatch = raw.match(/^\[(.*)\]$/)
  if (arrayMatch) {
    return arrayMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  // Single value
  return raw ? [raw] : []
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
function parseSkillFile(skillFile: string, displayPath: string, source: SkillEntry['source']): SkillEntry | null {
  const content = safeReadText(skillFile)
  if (!content) return null
  const name = parseFrontmatterField(content, 'name')
  // Accept both 'description' and 'shortDescription' (myRAM compat)
  const description = parseFrontmatterField(content, 'description')
    ?? parseFrontmatterField(content, 'shortDescription')
  if (!name || !description) return null
  const category = parseFrontmatterField(content, 'category') ?? inferCategory(name, description)
  const depends = parseFrontmatterArrayField(content, 'depends')
  const tags = parseFrontmatterArrayField(content, 'tags')
  const triggers = parseFrontmatterArrayField(content, 'triggers')
  return {
    name,
    description,
    category,
    depends,
    tags,
    triggers,
    path: displayPath,
    dir: path.dirname(skillFile),
    source,
    content
  }
}

/** Infer a category from skill name/description when not explicitly set. */
function inferCategory(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase()
  if (/writ|manuscript|draft|prose|humaniz/.test(text)) return 'Writing & Review'
  if (/visual|plot|chart|matplotlib|seaborn|figure/.test(text)) return 'Visualization'
  if (/data|analy|statistic|ml|model/.test(text)) return 'Data & Analysis'
  if (/literature|paper|search|review|academic|citation/.test(text)) return 'Literature & Search'
  if (/grant|proposal|funding/.test(text)) return 'Grants & Proposals'
  if (/evaluat|scholar|critique|assess/.test(text)) return 'Evaluation'
  return 'General'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load built-in skills that ship with the software. */
export function loadBuiltinSkills(): SkillEntry[] {
  // Use override if set (required in bundled Electron builds), else fallback to import.meta.url
  const skillsRoot = _builtinSkillsRoot ?? path.dirname(fileURLToPath(import.meta.url))
  if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
    return []
  }
  const files = discoverSkillFiles(skillsRoot)
  // Deduplicate by name (later files override earlier)
  const byName = new Map<string, SkillEntry>()
  for (const file of files) {
    const entry = parseSkillFile(file, `[builtin] ${path.relative(skillsRoot, file)}`, 'builtin')
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
    .map((file) => parseSkillFile(file, path.relative(workspacePath, file), 'workspace'))
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
    .map((file) => parseSkillFile(file, `[user] ~/.research-pilot/skills/${path.relative(userRoot, file)}`, 'user'))
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

// ---------------------------------------------------------------------------
// Enabled skills config (persisted per-workspace)
// ---------------------------------------------------------------------------

export interface SkillManifest {
  name: string
  description: string
  category: string
  depends: string[]
  tags: string[]
  source: 'builtin' | 'user' | 'workspace'
  enabled: boolean
  enabledReason: 'direct' | 'dependency' | null
  dependencyOf: string[]   // Which directly-selected skills pulled this in
}

// ---------------------------------------------------------------------------
// Dependency resolution (BFS transitive)
// ---------------------------------------------------------------------------

interface ResolvedSkill {
  reason: 'direct' | 'dependency'
  dependencyOf: string[]
}

/**
 * Resolve skill dependencies using BFS.
 * Returns a map of skill name -> resolution info.
 */
export function resolveSkillDependencies(
  allSkills: SkillEntry[],
  directSelection: string[]
): Map<string, ResolvedSkill> {
  const byName = new Map(allSkills.map((s) => [s.name, s]))
  const result = new Map<string, ResolvedSkill>()
  const queue: string[] = []

  // Seed with directly selected skills
  for (const name of directSelection) {
    if (!byName.has(name)) continue
    result.set(name, { reason: 'direct', dependencyOf: [] })
    queue.push(name)
  }

  // BFS: resolve transitive dependencies
  while (queue.length > 0) {
    const current = queue.shift()!
    const skill = byName.get(current)
    if (!skill) continue

    for (const depName of skill.depends) {
      if (!byName.has(depName)) continue // skip unknown deps

      const existing = result.get(depName)
      if (existing) {
        // Already resolved — just track who else depends on it
        if (!existing.dependencyOf.includes(current)) {
          existing.dependencyOf.push(current)
        }
      } else {
        result.set(depName, { reason: 'dependency', dependencyOf: [current] })
        queue.push(depName)
      }
    }
  }

  return result
}

/** Read enabled skills list from workspace config. Returns null if not set (= all enabled). */
export function readEnabledSkills(workspacePath: string): string[] | null {
  const configPath = path.resolve(workspacePath, '.research-pilot', 'skills-config.json')
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw)
    if (Array.isArray(config.enabledSkills)) return config.enabledSkills
  } catch {
    // no config yet
  }
  return null
}

/** Write enabled skills list to workspace config. */
export function writeEnabledSkills(workspacePath: string, enabledSkills: string[]): void {
  const configDir = path.resolve(workspacePath, '.research-pilot')
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
  const configPath = path.join(configDir, 'skills-config.json')
  fs.writeFileSync(configPath, JSON.stringify({ enabledSkills }, null, 2), 'utf8')
}

/** Build manifests for the UI: all skills with their enabled state and dependency info. */
export function buildSkillManifests(workspacePath: string): SkillManifest[] {
  const allSkills = loadAllSkills(workspacePath)
  const enabledList = readEnabledSkills(workspacePath)

  // If no config, all are directly enabled
  const directSelection = enabledList ?? allSkills.map((s) => s.name)
  const resolved = resolveSkillDependencies(allSkills, directSelection)

  return allSkills.map((s) => {
    const r = resolved.get(s.name)
    return {
      name: s.name,
      description: s.description,
      category: s.category,
      depends: s.depends,
      tags: s.tags,
      source: s.source,
      enabled: !!r,
      enabledReason: r?.reason ?? null,
      dependencyOf: r?.dependencyOf ?? []
    }
  })
}

/** Install a skill from a directory into workspace skills. */
export function installSkillToWorkspace(
  workspacePath: string,
  skillName: string,
  skillDir: string
): void {
  const destDir = path.resolve(workspacePath, '.research-pilot', 'skills', skillName)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
  // Copy all files from skillDir to destDir
  copyDirSync(skillDir, destDir)
}

function copyDirSync(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true })
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
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
  const lines = entries.map((e) => `- **${e.name}** [${e.category}]: ${e.description}`)
  return [
    '## Skills',
    'You have the following skills available. Call `load_skill(name)` to load full procedures for any skill before relying on it.',
    '',
    ...lines,
    '',
    'Some skills may be pre-loaded as summaries below based on this request. Call `load_skill` for full procedures when needed.'
  ].join('\n')
}

/**
 * Build a compact skill summary (~500 tokens) for system prompt injection.
 * Extracts frontmatter + Overview section from SKILL.md.
 * Used by LLM skill matching to give the agent a richer hint than the one-line
 * catalog description, without loading the full skill content.
 */
export function buildSkillSummary(entry: SkillEntry, maxChars = 2000): string {
  // Strip frontmatter
  const bodyMatch = entry.content.match(/^---\n[\s\S]*?\n---\n*([\s\S]*)$/)
  const body = bodyMatch?.[1] ?? entry.content

  // Extract Overview + When to Use sections (typically the first ~500 tokens)
  const sections = body.split(/\n## /)
  const overview = sections[0]?.trim() ?? ''  // text before first ## or the # heading section
  const whenToUse = sections.find(s => /^When to Use/i.test(s))
  const summaryParts = [overview]
  if (whenToUse) summaryParts.push(`## ${whenToUse}`)

  let summary = summaryParts.join('\n\n').trim()
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars) + '\n\n[... call load_skill for full procedures]'
  }
  return summary
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
