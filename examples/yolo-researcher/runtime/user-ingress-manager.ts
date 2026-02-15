import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { ensureDir, fileExists, formatTurnNumber, nowIso, readJsonFile, writeJsonFile } from './utils.js'

export interface IngressAcceptedFile {
  sourcePath: string
  curatedPath: string
  hash: string
  sizeBytes: number
  mimeType: string
  deduplicatedFrom?: string
}

export interface IngressRejectedFile {
  sourcePath: string
  rejectedPath: string
  reason: string
  sizeBytes: number
}

export interface IngressReviewResult {
  turnNumber: number
  ingressDir: string
  manifestPath: string
  accepted: IngressAcceptedFile[]
  rejected: IngressRejectedFile[]
}

interface HashIndex {
  byHash: Record<string, string>
}

const HASH_INDEX_FILE = '.hash-index.json'
const MAX_FILE_BYTES = 25 * 1024 * 1024

export class UserIngressManager {
  readonly ingressDir: string
  readonly reviewedDir: string
  readonly curatedDir: string
  readonly rejectedDir: string
  private readonly hashIndexPath: string

  constructor(private readonly sessionDir: string) {
    this.ingressDir = path.join(sessionDir, 'ingress')
    this.reviewedDir = path.join(this.ingressDir, 'reviewed')
    this.curatedDir = path.join(sessionDir, 'inputs-curated')
    this.rejectedDir = path.join(sessionDir, 'inputs-rejected')
    this.hashIndexPath = path.join(this.curatedDir, HASH_INDEX_FILE)
  }

  async init(): Promise<void> {
    await ensureDir(this.ingressDir)
    await ensureDir(this.reviewedDir)
    await ensureDir(this.curatedDir)
    await ensureDir(this.rejectedDir)

    if (!(await fileExists(this.hashIndexPath))) {
      await writeJsonFile(this.hashIndexPath, { byHash: {} } satisfies HashIndex)
    }
  }

  async ensureTurnIngressDir(turnNumber: number): Promise<string> {
    await this.init()
    const dir = this.turnIngressDir(turnNumber)
    await ensureDir(dir)
    return dir
  }

  async reviewTurnIngress(turnNumber: number): Promise<IngressReviewResult | null> {
    await this.init()
    const ingressDir = this.turnIngressDir(turnNumber)
    if (!(await fileExists(ingressDir))) return null

    const files = await this.collectFiles(ingressDir)
    if (files.length === 0) {
      await fs.rm(ingressDir, { recursive: true, force: true })
      return null
    }

    const hashIndex = await this.readHashIndex()
    const accepted: IngressAcceptedFile[] = []
    const rejected: IngressRejectedFile[] = []

    for (const sourcePath of files) {
      const relativeSourcePath = path.relative(this.sessionDir, sourcePath)
      const stat = await fs.stat(sourcePath)
      if (!stat.isFile()) {
        const rejectedPath = await this.moveRejected(turnNumber, sourcePath, 'not_a_regular_file')
        rejected.push({
          sourcePath: relativeSourcePath,
          rejectedPath,
          reason: 'not_a_regular_file',
          sizeBytes: stat.size
        })
        continue
      }

      if (stat.size > MAX_FILE_BYTES) {
        const rejectedPath = await this.moveRejected(turnNumber, sourcePath, 'file_too_large')
        rejected.push({
          sourcePath: relativeSourcePath,
          rejectedPath,
          reason: 'file_too_large',
          sizeBytes: stat.size
        })
        continue
      }

      const content = await fs.readFile(sourcePath)
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      const mimeType = this.inferMimeType(sourcePath)

      const existingCurated = hashIndex.byHash[hash]
      if (existingCurated) {
        await fs.rm(sourcePath, { force: true })
        accepted.push({
          sourcePath: relativeSourcePath,
          curatedPath: existingCurated,
          hash,
          sizeBytes: stat.size,
          mimeType,
          deduplicatedFrom: existingCurated
        })
        continue
      }

      const curatedName = `${hash.slice(0, 12)}-${this.safeFileName(path.basename(sourcePath))}`
      const curatedPathAbs = path.join(this.curatedDir, curatedName)
      await fs.rename(sourcePath, curatedPathAbs)

      const curatedPathRel = path.relative(this.sessionDir, curatedPathAbs)
      hashIndex.byHash[hash] = curatedPathRel

      accepted.push({
        sourcePath: relativeSourcePath,
        curatedPath: curatedPathRel,
        hash,
        sizeBytes: stat.size,
        mimeType
      })
    }

    await this.writeHashIndex(hashIndex)

    const manifestBase = `turn-${formatTurnNumber(turnNumber)}-${nowIso().replace(/[:.]/g, '-')}`
    const manifestPathAbs = path.join(this.reviewedDir, `${manifestBase}.json`)
    await writeJsonFile(manifestPathAbs, {
      turnNumber,
      reviewedAt: nowIso(),
      accepted,
      rejected
    })

    await fs.rm(ingressDir, { recursive: true, force: true })

    return {
      turnNumber,
      ingressDir: path.relative(this.sessionDir, ingressDir),
      manifestPath: path.relative(this.sessionDir, manifestPathAbs),
      accepted,
      rejected
    }
  }

  turnIngressDir(turnNumber: number): string {
    return path.join(this.ingressDir, `user-turn-${formatTurnNumber(turnNumber)}-upload`)
  }

  private async readHashIndex(): Promise<HashIndex> {
    if (!(await fileExists(this.hashIndexPath))) return { byHash: {} }
    return readJsonFile<HashIndex>(this.hashIndexPath)
  }

  private async writeHashIndex(index: HashIndex): Promise<void> {
    await writeJsonFile(this.hashIndexPath, index)
  }

  private async moveRejected(turnNumber: number, sourcePath: string, reason: string): Promise<string> {
    const turnRejectedDir = path.join(this.rejectedDir, `turn-${formatTurnNumber(turnNumber)}`)
    await ensureDir(turnRejectedDir)

    const name = this.safeFileName(path.basename(sourcePath))
    const dest = path.join(turnRejectedDir, `${Date.now()}-${name}`)
    await fs.rename(sourcePath, dest)

    const metaPath = `${dest}.reject.json`
    await writeJsonFile(metaPath, {
      reason,
      sourcePath: path.relative(this.sessionDir, sourcePath),
      rejectedAt: nowIso()
    })

    return path.relative(this.sessionDir, dest)
  }

  private async collectFiles(rootDir: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dirPath: string) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await walk(entryPath)
          continue
        }
        out.push(entryPath)
      }
    }
    await walk(rootDir)
    out.sort((a, b) => a.localeCompare(b))
    return out
  }

  private safeFileName(input: string): string {
    return input.replace(/[^a-zA-Z0-9._-]/g, '_')
  }

  private inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case '.pdf': return 'application/pdf'
      case '.txt': return 'text/plain'
      case '.md': return 'text/markdown'
      case '.json': return 'application/json'
      case '.csv': return 'text/csv'
      case '.png': return 'image/png'
      case '.jpg':
      case '.jpeg': return 'image/jpeg'
      default: return 'application/octet-stream'
    }
  }
}
