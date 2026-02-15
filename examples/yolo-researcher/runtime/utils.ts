import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex')
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw) as T
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8')
}

export async function readTextFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content, 'utf-8')
}

export function sortStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

export function formatTurnNumber(turnNumber: number): string {
  return turnNumber.toString().padStart(3, '0')
}

export function formatSeqNumber(seq: number): string {
  return seq.toString().padStart(3, '0')
}
