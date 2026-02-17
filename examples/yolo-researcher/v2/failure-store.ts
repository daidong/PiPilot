import * as path from 'node:path'

import type { FailureEntry, FailureStatus } from './types.js'
import { fileExists, normalizeText, readTextOrEmpty, toIso, writeText } from './utils.js'

const HEADER = '# Failures / Blockers (Do not retry blindly)'

function normalizeCmd(value: string): string {
  return normalizeText(value)
}

function parseFailures(raw: string): FailureEntry[] {
  const entries: FailureEntry[] = []
  const lines = raw.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd()
    const head = /^- \[(WARN|BLOCKED)\]\[([^\]]+)\]\s+(.+)$/.exec(line.trim())
    if (!head) {
      index += 1
      continue
    }

    const status = head[1] as FailureStatus
    const runtime = head[2]?.trim() ?? 'host'
    const cmd = head[3]?.trim() ?? ''

    const entry: FailureEntry = {
      status,
      runtime,
      cmd,
      fingerprint: '',
      errorLine: '',
      evidencePath: '',
      attempts: status === 'BLOCKED' ? 3 : 2,
      alternatives: [],
      updatedAt: ''
    }

    index += 1
    while (index < lines.length) {
      const detail = lines[index] ?? ''
      if (!detail.startsWith('  ')) break
      const trimmed = detail.trim()

      if (trimmed.startsWith('error:')) {
        entry.errorLine = trimmed.slice('error:'.length).trim()
      } else if (trimmed.startsWith('evidence:')) {
        entry.evidencePath = trimmed.slice('evidence:'.length).trim()
      } else if (trimmed.startsWith('attempts:')) {
        const value = Number(trimmed.slice('attempts:'.length).trim())
        if (Number.isFinite(value) && value > 0) entry.attempts = Math.floor(value)
      } else if (trimmed.startsWith('fingerprint:')) {
        entry.fingerprint = trimmed.slice('fingerprint:'.length).trim()
      } else if (trimmed.startsWith('updated_at:')) {
        entry.updatedAt = trimmed.slice('updated_at:'.length).trim()
      } else if (trimmed === 'alternatives:') {
        index += 1
        while (index < lines.length) {
          const alt = lines[index] ?? ''
          if (!alt.startsWith('    - ')) break
          const value = alt.slice('    - '.length).trim()
          if (value) entry.alternatives.push(value)
          index += 1
        }
        continue
      }

      index += 1
    }

    if (!entry.fingerprint) {
      entry.fingerprint = `${normalizeCmd(entry.cmd)}|${normalizeText(entry.errorLine)}|${normalizeText(entry.runtime)}`
    }

    entries.push(entry)
  }

  return entries
}

function renderEntry(entry: FailureEntry): string[] {
  const lines: string[] = [
    `- [${entry.status}][${entry.runtime}] ${entry.cmd}`,
    `  error: ${entry.errorLine}`,
    `  evidence: ${entry.evidencePath}`,
    `  fingerprint: ${entry.fingerprint}`,
    `  attempts: ${entry.attempts}`,
    `  updated_at: ${entry.updatedAt}`,
    '  alternatives:'
  ]

  if (entry.alternatives.length === 0) {
    lines.push('    - switch runtime (host/docker/venv)')
    lines.push('    - perform minimal verification before re-running full command')
    lines.push('    - ask user for missing permissions or resources')
  } else {
    for (const alt of entry.alternatives) {
      lines.push(`    - ${alt}`)
    }
  }

  return lines
}

function renderFailures(entries: FailureEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const lines: string[] = [HEADER, '']

  if (sorted.length === 0) {
    lines.push('- None.')
    lines.push('')
    return `${lines.join('\n')}\n`
  }

  for (const entry of sorted) {
    lines.push(...renderEntry(entry))
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

export class FailureStore {
  readonly filePath: string

  constructor(private readonly yoloRoot: string, private readonly now: () => Date) {
    this.filePath = path.join(yoloRoot, 'FAILURES.md')
  }

  async init(): Promise<void> {
    if (!(await fileExists(this.filePath))) {
      await writeText(this.filePath, `${HEADER}\n\n- None.\n`)
    }
  }

  async load(): Promise<FailureEntry[]> {
    const raw = await readTextOrEmpty(this.filePath)
    return parseFailures(raw)
  }

  async save(entries: FailureEntry[]): Promise<void> {
    await writeText(this.filePath, renderFailures(entries))
  }

  async findBlocked(cmd: string, runtime: string): Promise<FailureEntry | null> {
    const entries = await this.load()
    const cmdNorm = normalizeCmd(cmd)
    const runtimeNorm = normalizeText(runtime)
    for (const entry of entries) {
      if (entry.status !== 'BLOCKED') continue
      if (normalizeCmd(entry.cmd) !== cmdNorm) continue
      if (normalizeText(entry.runtime) !== runtimeNorm) continue
      return entry
    }
    return null
  }

  async recordDeterministicFailure(input: {
    cmd: string
    runtime: string
    fingerprint: string
    errorLine: string
    evidencePath: string
    alternatives: string[]
  }): Promise<FailureEntry | null> {
    const entries = await this.load()
    const existingIndex = entries.findIndex((entry) => entry.fingerprint === input.fingerprint)
    const existing = existingIndex >= 0 ? entries[existingIndex] : null
    const attempts = (existing?.attempts ?? 0) + 1

    const status: FailureStatus = attempts >= 3 ? 'BLOCKED' : 'WARN'
    const next: FailureEntry = {
      status,
      runtime: input.runtime,
      cmd: input.cmd,
      fingerprint: input.fingerprint,
      errorLine: input.errorLine,
      evidencePath: input.evidencePath,
      attempts,
      alternatives: input.alternatives,
      updatedAt: toIso(this.now)
    }

    if (existingIndex >= 0) {
      entries[existingIndex] = next
    } else {
      entries.push(next)
    }

    await this.save(entries)
    return next
  }

  async clearBlockedAfterVerifiedSuccess(input: {
    cmd: string
    runtime: string
    evidencePath: string
  }): Promise<boolean> {
    const entries = await this.load()
    const cmdNorm = normalizeCmd(input.cmd)
    const runtimeNorm = normalizeText(input.runtime)

    let changed = false
    const nextEntries = entries.map((entry) => {
      if (entry.status !== 'BLOCKED') return entry
      if (normalizeCmd(entry.cmd) !== cmdNorm) return entry
      if (normalizeText(entry.runtime) !== runtimeNorm) return entry
      changed = true
      return {
        ...entry,
        status: 'WARN' as const,
        attempts: 1,
        errorLine: `Recovered after blocked override; verify once more before full retries. Previous: ${entry.errorLine}`,
        evidencePath: input.evidencePath,
        updatedAt: toIso(this.now)
      }
    })

    if (changed) {
      await this.save(nextEntries)
    }

    return changed
  }
}
