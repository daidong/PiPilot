import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { AssetRecord } from './types.js'
import {
  ensureDir,
  fileExists,
  formatSeqNumber,
  formatTurnNumber,
  readJsonFile,
  sortStrings,
  writeJsonFile
} from './utils.js'

export interface StageAssetsInput {
  turnNumber: number
  attempt: number
  assets: Array<{
    type: string
    payload: Record<string, unknown>
    supersedes?: string
  }>
}

export interface StagedAssets {
  records: AssetRecord[]
  stagedPaths: string[]
}

export class FileAssetStore {
  readonly assetsDir: string
  readonly stagingDir: string

  constructor(private readonly sessionDir: string) {
    this.assetsDir = path.join(sessionDir, 'assets')
    this.stagingDir = path.join(this.assetsDir, '.staging')
  }

  async init(): Promise<void> {
    await ensureDir(this.assetsDir)
    await ensureDir(this.stagingDir)
  }

  buildAssetId(type: string, turnNumber: number, attempt: number, seq: number): string {
    const normalizedType = type.replace(/[^A-Za-z0-9_-]/g, '')
    return `${normalizedType}-t${formatTurnNumber(turnNumber)}-a${attempt}-${formatSeqNumber(seq)}`
  }

  async stageAssets(input: StageAssetsInput): Promise<StagedAssets> {
    const records: AssetRecord[] = []
    const stagedPaths: string[] = []

    for (let i = 0; i < input.assets.length; i += 1) {
      const seq = i + 1
      const source = input.assets[i]
      const id = this.buildAssetId(source.type, input.turnNumber, input.attempt, seq)

      const record: AssetRecord = {
        id,
        type: source.type,
        payload: source.payload,
        supersedes: source.supersedes,
        createdAt: new Date().toISOString(),
        createdByTurn: input.turnNumber,
        createdByAttempt: input.attempt
      }

      const stagedPath = path.join(this.stagingDir, `${id}.json`)
      await writeJsonFile(stagedPath, record)
      records.push(record)
      stagedPaths.push(stagedPath)
    }

    return { records, stagedPaths }
  }

  async appendOutOfTurnAsset(input: {
    turnNumber: number
    attempt: number
    type: string
    payload: Record<string, unknown>
    supersedes?: string
  }): Promise<AssetRecord> {
    await this.init()

    let seq = 1
    let id = this.buildAssetId(input.type, input.turnNumber, input.attempt, seq)
    while (
      await fileExists(path.join(this.assetsDir, `${id}.json`))
      || await fileExists(path.join(this.stagingDir, `${id}.json`))
    ) {
      seq += 1
      id = this.buildAssetId(input.type, input.turnNumber, input.attempt, seq)
      if (seq > 9999) {
        throw new Error(`unable to allocate out-of-turn asset id for ${input.type}`)
      }
    }

    const record: AssetRecord = {
      id,
      type: input.type,
      payload: input.payload,
      supersedes: input.supersedes,
      createdAt: new Date().toISOString(),
      createdByTurn: input.turnNumber,
      createdByAttempt: input.attempt
    }

    const stagedPath = path.join(this.stagingDir, `${id}.json`)
    const finalPath = path.join(this.assetsDir, `${id}.json`)
    await writeJsonFile(stagedPath, record)
    await fs.rename(stagedPath, finalPath)
    return record
  }

  async commitStagedAssets(records: AssetRecord[]): Promise<void> {
    for (const record of records) {
      const stagedPath = path.join(this.stagingDir, `${record.id}.json`)
      const finalPath = path.join(this.assetsDir, `${record.id}.json`)
      if (!(await fileExists(stagedPath))) {
        throw new Error(`staged asset missing before commit: ${record.id}`)
      }
      await fs.rename(stagedPath, finalPath)
    }
  }

  async cleanupStaging(): Promise<string[]> {
    await ensureDir(this.stagingDir)
    const names = await fs.readdir(this.stagingDir)
    const removed: string[] = []
    for (const name of names) {
      const fullPath = path.join(this.stagingDir, name)
      await fs.rm(fullPath, { force: true, recursive: true })
      removed.push(path.join('assets', '.staging', name))
    }
    return removed
  }

  async list(type?: string): Promise<AssetRecord[]> {
    await ensureDir(this.assetsDir)
    const names = await fs.readdir(this.assetsDir)
    const jsonNames = names.filter((name) => name.endsWith('.json'))
    const loaded = await Promise.all(jsonNames.map(async (name) => {
      const record = await readJsonFile<AssetRecord>(path.join(this.assetsDir, name))
      return record
    }))

    const filtered = type ? loaded.filter((item) => item.type === type) : loaded
    return filtered.sort((a, b) => a.id.localeCompare(b.id))
  }

  async get(id: string): Promise<AssetRecord | undefined> {
    const filePath = path.join(this.assetsDir, `${id}.json`)
    if (!(await fileExists(filePath))) return undefined
    return readJsonFile<AssetRecord>(filePath)
  }

  async updatePayload(id: string, fields: Record<string, unknown>): Promise<AssetRecord | undefined> {
    const filePath = path.join(this.assetsDir, `${id}.json`)
    if (!(await fileExists(filePath))) return undefined
    const record = await readJsonFile<AssetRecord>(filePath)
    record.payload = { ...record.payload, ...fields }
    await writeJsonFile(filePath, record)
    return record
  }

  async removeAssetsForTurns(turnNumbers: number[]): Promise<string[]> {
    const targets = new Set(turnNumbers.map((value) => `-t${formatTurnNumber(value)}-`))
    const names = await fs.readdir(this.assetsDir)
    const removed: string[] = []

    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const matched = Array.from(targets).some((marker) => name.includes(marker))
      if (!matched) continue
      await fs.rm(path.join(this.assetsDir, name), { force: true })
      removed.push(path.join('assets', name))
    }

    return sortStrings(removed)
  }
}
