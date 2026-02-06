/**
 * External skill loader for `.agentfoundry/skills/*.skill.md`.
 */

import * as fs from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'

import type { Skill } from '../types/skill.js'
import { parseExternalSkill } from './skill-file.js'

export interface ExternalSkillLoaderOptions {
  skillsDir: string
  watchForChanges?: boolean
  builtInSkillIds?: string[] | Set<string>
  onSkillLoaded?: (loaded: LoadedExternalSkill) => void
  onSkillRemoved?: (skillId: string) => void
  onError?: (error: Error, filePath: string) => void
}

export interface LoadedExternalSkill {
  skill: Skill
  filePath: string
  approvedByUser: boolean
}

function isSkillMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.skill.md')
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
  private readonly skillsDir: string
  private readonly watchForChanges: boolean
  private readonly builtInSkillIds: Set<string>
  private readonly onSkillLoaded?: (loaded: LoadedExternalSkill) => void
  private readonly onSkillRemoved?: (skillId: string) => void
  private readonly onError?: (error: Error, filePath: string) => void
  private readonly loadedByFile = new Map<string, LoadedExternalSkill>()
  private readonly fileBySkillId = new Map<string, string>()
  private watcher: FSWatcher | null = null
  private watchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: ExternalSkillLoaderOptions) {
    this.skillsDir = path.resolve(options.skillsDir)
    this.watchForChanges = options.watchForChanges ?? true
    this.builtInSkillIds = new Set(options.builtInSkillIds ?? [])
    this.onSkillLoaded = options.onSkillLoaded
    this.onSkillRemoved = options.onSkillRemoved
    this.onError = options.onError
  }

  /**
   * Load all external skills from directory.
   */
  async loadAll(): Promise<LoadedExternalSkill[]> {
    await fs.mkdir(this.skillsDir, { recursive: true })
    this.loadedByFile.clear()
    this.fileBySkillId.clear()

    const files = await this.collectSkillFiles(this.skillsDir)
    const loaded: LoadedExternalSkill[] = []

    for (const filePath of files) {
      const skill = await this.loadSkillFile(filePath, { emitCallback: false })
      if (skill) {
        loaded.push(skill)
      }
    }

    return loaded
  }

  /**
   * Load a single skill file.
   */
  async loadSkillFile(
    filePath: string,
    options: { emitCallback?: boolean } = {}
  ): Promise<LoadedExternalSkill | null> {
    const absolutePath = path.resolve(filePath)
    if (!isSkillMarkdownFile(absolutePath)) return null

    try {
      const content = await fs.readFile(absolutePath, 'utf-8')
      const parsed = parseExternalSkill(content)

      if (this.builtInSkillIds.has(parsed.skill.id)) {
        throw new Error(`Skill id collision with built-in: ${parsed.skill.id}`)
      }

      const existingPathForId = this.fileBySkillId.get(parsed.skill.id)
      if (existingPathForId && existingPathForId !== absolutePath) {
        throw new Error(`Skill id collision with external file: ${parsed.skill.id}`)
      }

      const previous = this.loadedByFile.get(absolutePath)
      if (previous && previous.skill.id !== parsed.skill.id) {
        this.fileBySkillId.delete(previous.skill.id)
        this.onSkillRemoved?.(previous.skill.id)
      }

      const loaded: LoadedExternalSkill = {
        skill: parsed.skill,
        filePath: absolutePath,
        approvedByUser: parsed.approvedByUser
      }

      this.loadedByFile.set(absolutePath, loaded)
      this.fileBySkillId.set(parsed.skill.id, absolutePath)
      if (options.emitCallback ?? true) {
        this.onSkillLoaded?.(loaded)
      }

      return loaded
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err, absolutePath)
      return null
    }
  }

  /**
   * Start watching for file changes.
   */
  startWatching(): void {
    if (!this.watchForChanges || this.watcher) return

    if (!this.skillsDir) return

    try {
      this.watcher = watch(this.skillsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        this.scheduleReload(path.resolve(this.skillsDir, filename.toString()))
      })
    } catch {
      try {
        this.watcher = watch(this.skillsDir, (_eventType, filename) => {
          if (!filename) return
          this.scheduleReload(path.resolve(this.skillsDir, filename.toString()))
        })
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        this.onError?.(err, this.skillsDir)
      }
    }
  }

  /**
   * Stop watching.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const timer of this.watchDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.watchDebounceTimers.clear()
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

  private scheduleReload(absolutePath: string): void {
    if (!isSkillMarkdownFile(absolutePath)) return
    const existingTimer = this.watchDebounceTimers.get(absolutePath)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      this.watchDebounceTimers.delete(absolutePath)
      this.reloadFile(absolutePath).catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        this.onError?.(err, absolutePath)
      })
    }, 200)
    this.watchDebounceTimers.set(absolutePath, timer)
  }

  private async reloadFile(absolutePath: string): Promise<void> {
    const exists = await pathExists(absolutePath)
    const previous = this.loadedByFile.get(absolutePath)

    if (!exists) {
      if (previous) {
        this.loadedByFile.delete(absolutePath)
        this.fileBySkillId.delete(previous.skill.id)
        this.onSkillRemoved?.(previous.skill.id)
      }
      return
    }

    await this.loadSkillFile(absolutePath)
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
      } else if (entry.isFile() && isSkillMarkdownFile(entry.name)) {
        results.push(fullPath)
      }
    }

    return results
  }
}
