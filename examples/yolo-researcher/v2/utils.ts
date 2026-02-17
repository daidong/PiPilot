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

export async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content, 'utf-8')
}

export function toIso(now: Date | (() => Date)): string {
  return (typeof now === 'function' ? now() : now).toISOString()
}

export function formatTurnId(turnNumber: number): string {
  return `turn-${turnNumber.toString().padStart(4, '0')}`
}

export function parseTurnNumber(turnDirName: string): number | null {
  const match = /^turn-(\d{4})$/.exec(turnDirName)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

export async function listTurnNumbers(runsDir: string): Promise<number[]> {
  if (!(await fileExists(runsDir))) return []
  const entries = await fs.readdir(runsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseTurnNumber(entry.name))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function escapeMarkdownInline(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim()
}

export function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function firstNonEmptyLine(...values: string[]): string {
  for (const value of values) {
    const line = value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean)
    if (line) return line
  }
  return ''
}
