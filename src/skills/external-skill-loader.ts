/**
 * External skill loader for directory-based SKILL.md files.
 *
 * Supported layouts:
 * - <source-dir>/<skill-id>/SKILL.md
 * - <source-dir>/*.skill.md and nested legacy files
 */

import * as fs from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'

import type { Skill } from '../types/skill.js'
import { parseExternalSkill } from './skill-file.js'

export type ExternalSkillSourceType = 'project-local' | 'community-builtin'
export type SkillScriptRunner = 'bash' | 'node' | 'python' | 'executable'

export interface ExternalSkillSourceConfig {
  dir: string
  sourceType: ExternalSkillSourceType
  watchForChanges?: boolean
  approvedByDefault?: boolean
}

interface ResolvedSkillSourceConfig {
  dir: string
  sourceType: ExternalSkillSourceType
  watchForChanges: boolean
  approvedByDefault: boolean
}

export interface ExternalSkillLoaderOptions {
  /**
   * Legacy single-source option.
   * Equivalent to:
   * [{ dir: skillsDir, sourceType: 'project-local' }]
   */
  skillsDir?: string
  skillSources?: ExternalSkillSourceConfig[]
  watchForChanges?: boolean
  builtInSkillIds?: string[] | Set<string>
  onSkillLoaded?: (loaded: LoadedExternalSkill) => void
  onSkillRemoved?: (skillId: string) => void
  onError?: (error: Error, filePath: string) => void
}

export interface LoadedSkillScript {
  name: string
  fileName: string
  filePath: string
  relativePath: string
  runner: SkillScriptRunner
}

export interface LoadedExternalSkill {
  skill: Skill
  filePath: string
  skillDir: string
  approvedByUser: boolean
  sourceType: ExternalSkillSourceType
  scripts: LoadedSkillScript[]
}

function isSkillMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('/skill.md') || lower.endsWith('\\skill.md') || lower.endsWith('.skill.md')
}

function normalizePathForCompare(targetPath: string): string {
  return targetPath.replace(/\\/g, '/')
}

function inferScriptRunner(fileName: string): SkillScriptRunner {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'bash'
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return 'node'
  if (ext === '.py') return 'python'
  return 'executable'
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export class ExternalSkillLoader {
  private readonly sources: ResolvedSkillSourceConfig[]
  private readonly watchForChanges: boolean
  private readonly builtInSkillIds: Set<string>
  private readonly onSkillLoaded?: (loaded: LoadedExternalSkill) => void
  private readonly onSkillRemoved?: (skillId: string) => void
  private readonly onError?: (error: Error, filePath: string) => void
  private readonly loadedByFile = new Map<string, LoadedExternalSkill>()
  private readonly signatureByFile = new Map<string, string>()
  private readonly fileBySkillId = new Map<string, string>()
  private readonly watchers = new Map<string, FSWatcher>()
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ExternalSkillLoaderOptions) {
    this.watchForChanges = options.watchForChanges ?? true
    this.builtInSkillIds = new Set(options.builtInSkillIds ?? [])
    this.onSkillLoaded = options.onSkillLoaded
    this.onSkillRemoved = options.onSkillRemoved
    this.onError = options.onError

    const configuredSources: ExternalSkillSourceConfig[] =
      options.skillSources && options.skillSources.length > 0
        ? options.skillSources
        : options.skillsDir
          ? [{ dir: options.skillsDir, sourceType: 'project-local' }]
          : []

    this.sources = configuredSources.map(source => ({
      dir: path.resolve(source.dir),
      sourceType: source.sourceType,
      watchForChanges: source.watchForChanges ?? this.watchForChanges,
      approvedByDefault: source.approvedByDefault ?? true
    }))
  }

  /**
   * Load all external skills from configured sources.
   */
  async loadAll(): Promise<LoadedExternalSkill[]> {
    for (const source of this.sources) {
      if (source.sourceType === 'project-local') {
        await fs.mkdir(source.dir, { recursive: true })
      }
    }

    const loaded = await this.scanSources()
    this.replaceSnapshot(loaded)
    return loaded
  }

  /**
   * Load/reload a single skill file.
   */
  async loadSkillFile(
    filePath: string,
    options: { emitCallback?: boolean } = {}
  ): Promise<LoadedExternalSkill | null> {
    const absolutePath = path.resolve(filePath)
    if (!isSkillMarkdownFile(absolutePath)) return null

    const source = this.findSourceForPath(absolutePath) ?? {
      dir: path.dirname(absolutePath),
      sourceType: 'project-local' as const,
      watchForChanges: this.watchForChanges,
      approvedByDefault: true
    }

    const parsed = await this.loadSkillFileFromSource(absolutePath, source, new Map(this.fileBySkillId))
    if (!parsed) {
      return null
    }

    const previous = this.loadedByFile.get(absolutePath)
    const previousSignature = this.signatureByFile.get(absolutePath)
    const nextSignature = this.signatureFor(parsed)

    if (previous && previous.skill.id !== parsed.skill.id) {
      this.fileBySkillId.delete(previous.skill.id)
      this.onSkillRemoved?.(previous.skill.id)
    }

    this.loadedByFile.set(absolutePath, parsed)
    this.signatureByFile.set(absolutePath, nextSignature)
    this.fileBySkillId.set(parsed.skill.id, absolutePath)

    if ((options.emitCallback ?? true) && (!previous || previousSignature !== nextSignature)) {
      this.onSkillLoaded?.(parsed)
    }

    return parsed
  }

  /**
   * Start watching for source changes.
   */
  startWatching(): void {
    if (!this.watchForChanges || this.watchers.size > 0) return

    for (const source of this.sources) {
      if (!source.watchForChanges) continue

      try {
        const watcher = watch(source.dir, { recursive: true }, () => {
          this.scheduleRescan()
        })
        this.watchers.set(source.dir, watcher)
      } catch {
        try {
          const watcher = watch(source.dir, () => {
            this.scheduleRescan()
          })
          this.watchers.set(source.dir, watcher)
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          this.onError?.(err, source.dir)
        }
      }
    }
  }

  /**
   * Stop watching.
   */
  stopWatching(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()

    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer)
      this.watchDebounceTimer = null
    }
  }

  /**
   * Get currently loaded skills.
   */
  getLoadedSkills(): Skill[] {
    return Array.from(this.loadedByFile.values()).map(item => item.skill)
  }

  /**
   * Get currently loaded skill records.
   */
  getLoadedSkillRecords(): LoadedExternalSkill[] {
    return Array.from(this.loadedByFile.values())
  }

  private scheduleRescan(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer)
    }
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null
      this.rescan().catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        this.onError?.(err, '[external-skill-loader]')
      })
    }, 200)
  }

  private async rescan(): Promise<void> {
    const loaded = await this.scanSources()
    this.replaceSnapshot(loaded, { emitCallbacks: true })
  }

  private replaceSnapshot(
    loaded: LoadedExternalSkill[],
    options: { emitCallbacks?: boolean } = {}
  ): void {
    const emitCallbacks = options.emitCallbacks ?? false
    const nextByFile = new Map<string, LoadedExternalSkill>()
    const nextSignatureByFile = new Map<string, string>()
    const nextFileBySkillId = new Map<string, string>()

    for (const item of loaded) {
      nextByFile.set(item.filePath, item)
      nextSignatureByFile.set(item.filePath, this.signatureFor(item))
      nextFileBySkillId.set(item.skill.id, item.filePath)
    }

    if (emitCallbacks) {
      for (const [filePath, previous] of this.loadedByFile.entries()) {
        const next = nextByFile.get(filePath)
        if (!next) {
          this.onSkillRemoved?.(previous.skill.id)
          continue
        }
        if (next.skill.id !== previous.skill.id) {
          this.onSkillRemoved?.(previous.skill.id)
        }
      }

      for (const [filePath, next] of nextByFile.entries()) {
        const previous = this.loadedByFile.get(filePath)
        const previousSignature = this.signatureByFile.get(filePath)
        const nextSignature = nextSignatureByFile.get(filePath)
        if (!previous || previousSignature !== nextSignature || previous.skill.id !== next.skill.id) {
          this.onSkillLoaded?.(next)
        }
      }
    }

    this.loadedByFile.clear()
    this.signatureByFile.clear()
    this.fileBySkillId.clear()
    for (const [filePath, item] of nextByFile.entries()) {
      this.loadedByFile.set(filePath, item)
    }
    for (const [filePath, signature] of nextSignatureByFile.entries()) {
      this.signatureByFile.set(filePath, signature)
    }
    for (const [skillId, filePath] of nextFileBySkillId.entries()) {
      this.fileBySkillId.set(skillId, filePath)
    }
  }

  private signatureFor(loaded: LoadedExternalSkill): string {
    return JSON.stringify({
      skill: loaded.skill,
      sourceType: loaded.sourceType,
      scripts: loaded.scripts.map(script => ({
        name: script.name,
        fileName: script.fileName,
        relativePath: script.relativePath,
        runner: script.runner
      }))
    })
  }

  private findSourceForPath(filePath: string): ResolvedSkillSourceConfig | null {
    const normalizedFile = normalizePathForCompare(path.resolve(filePath))
    const matching = this.sources
      .filter(source => {
        const normalizedSource = normalizePathForCompare(source.dir)
        return normalizedFile === normalizedSource || normalizedFile.startsWith(`${normalizedSource}/`)
      })
      .sort((a, b) => b.dir.length - a.dir.length)
    return matching[0] ?? null
  }

  private async scanSources(): Promise<LoadedExternalSkill[]> {
    const records: LoadedExternalSkill[] = []
    const seenSkillIds = new Map<string, string>()

    for (const source of this.sources) {
      const files = await this.collectSkillFiles(source.dir)
      files.sort()

      for (const filePath of files) {
        const loaded = await this.loadSkillFileFromSource(filePath, source, seenSkillIds)
        if (loaded) {
          records.push(loaded)
        }
      }
    }

    return records
  }

  private async loadSkillFileFromSource(
    filePath: string,
    source: ResolvedSkillSourceConfig,
    seenSkillIds: Map<string, string>
  ): Promise<LoadedExternalSkill | null> {
    const absolutePath = path.resolve(filePath)
    if (!isSkillMarkdownFile(absolutePath)) return null

    try {
      const content = await fs.readFile(absolutePath, 'utf-8')
      const skillDir = path.dirname(absolutePath)
      const scripts = await this.collectSkillScripts(skillDir)

      const parsed = parseExternalSkill(content, {
        filePath: absolutePath,
        defaultLoadingStrategy: 'lazy',
        defaultMeta: {
          sourceType: source.sourceType,
          filePath: absolutePath,
          skillDir,
          scripts: scripts.map(script => ({
            name: script.name,
            fileName: script.fileName,
            relativePath: script.relativePath,
            filePath: script.filePath,
            runner: script.runner
          }))
        },
        defaultApprovedByUser: source.approvedByDefault
      })

      if (this.builtInSkillIds.has(parsed.skill.id)) {
        throw new Error(`Skill id collision with built-in: ${parsed.skill.id}`)
      }

      const existingPathForId = seenSkillIds.get(parsed.skill.id)
      if (existingPathForId && existingPathForId !== absolutePath) {
        throw new Error(`Skill id collision with external file: ${parsed.skill.id}`)
      }
      seenSkillIds.set(parsed.skill.id, absolutePath)

      const loaded: LoadedExternalSkill = {
        skill: parsed.skill,
        filePath: absolutePath,
        skillDir,
        approvedByUser: parsed.approvedByUser,
        sourceType: source.sourceType,
        scripts
      }
      return loaded
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err, absolutePath)
      return null
    }
  }

  private async collectSkillScripts(skillDir: string): Promise<LoadedSkillScript[]> {
    const scriptsDir = path.join(skillDir, 'scripts')
    if (!await pathExists(scriptsDir)) {
      return []
    }

    const files = await this.collectFilesRecursive(scriptsDir)
    const scripts: LoadedSkillScript[] = []

    for (const filePath of files) {
      const fileName = path.basename(filePath)
      const ext = path.extname(fileName)
      const withoutExt = fileName.slice(0, fileName.length - ext.length)
      scripts.push({
        name: withoutExt || fileName,
        fileName,
        filePath,
        relativePath: normalizePathForCompare(path.relative(skillDir, filePath)),
        runner: inferScriptRunner(fileName)
      })
    }

    return scripts.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  private async collectFilesRecursive(dirPath: string): Promise<string[]> {
    const results: string[] = []
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const nested = await this.collectFilesRecursive(fullPath)
        results.push(...nested)
      } else if (entry.isFile()) {
        results.push(fullPath)
      }
    }

    return results
  }

  private async collectSkillFiles(dirPath: string): Promise<string[]> {
    if (!await pathExists(dirPath)) return []

    const results: string[] = []
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const nested = await this.collectSkillFiles(fullPath)
        results.push(...nested)
      } else if (entry.isFile() && isSkillMarkdownFile(fullPath)) {
        results.push(fullPath)
      }
    }

    return results
  }
}
