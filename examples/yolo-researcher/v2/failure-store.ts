import * as path from 'node:path'

import type { FailureEntry, FailureStatus } from './types.js'
import {
  fileExists,
  formatTurnId,
  listTurnNumbers,
  normalizeText,
  readTextOrEmpty,
  toIso,
  writeText
} from './utils.js'

const HEADER = '# Failures / Blockers (Do not retry blindly)'
const FAILURE_WINDOW_TURNS = 10

function normalizeCmd(value: string): string {
  return normalizeText(value)
}

function parseFailures(raw: string): FailureEntry[] {
  const entries: FailureEntry[] = []
  const lines = raw.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd()
    const head = /^- \[(WARN|BLOCKED|UNBLOCKED)\]\[([^\]]+)\]\s+(.+)$/.exec(line.trim())
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
      was: '',
      resolved: '',
      evidencePath: '',
      attempts: status === 'BLOCKED' ? 3 : status === 'WARN' ? 2 : 0,
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
      } else if (trimmed.startsWith('was:')) {
        entry.was = trimmed.slice('was:'.length).trim()
      } else if (trimmed.startsWith('resolved:')) {
        entry.resolved = trimmed.slice('resolved:'.length).trim()
      } else if (trimmed.startsWith('evidence:')) {
        entry.evidencePath = trimmed.slice('evidence:'.length).trim()
      } else if (trimmed.startsWith('attempts:')) {
        const value = Number(trimmed.slice('attempts:'.length).trim())
        if (Number.isFinite(value) && value >= 0) entry.attempts = Math.floor(value)
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
    if (!entry.updatedAt) {
      entry.updatedAt = toIso(new Date(0))
    }

    entries.push(entry)
  }

  return entries
}

function renderEntry(entry: FailureEntry): string[] {
  if (entry.status === 'UNBLOCKED') {
    return [
      `- [UNBLOCKED][${entry.runtime}] ${entry.cmd}`,
      `  was: ${entry.was || `BLOCKED (${entry.errorLine || 'unknown'})`}`,
      `  resolved: ${entry.resolved || 'minimal verification passed'}`,
      `  evidence: ${entry.evidencePath}`,
      `  fingerprint: ${entry.fingerprint}`,
      `  updated_at: ${entry.updatedAt}`
    ]
  }

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

function latestByUpdatedAt(entries: FailureEntry[]): FailureEntry | null {
  if (entries.length === 0) return null
  return entries.reduce((latest, current) => (
    current.updatedAt.localeCompare(latest.updatedAt) > 0 ? current : latest
  ))
}

export class FailureStore {
  readonly filePath: string
  private readonly runsDir: string

  constructor(private readonly yoloRoot: string, private readonly now: () => Date) {
    this.filePath = path.join(yoloRoot, 'FAILURES.md')
    this.runsDir = path.join(yoloRoot, 'runs')
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
    const matching = entries.filter((entry) => (
      normalizeCmd(entry.cmd) === cmdNorm
      && normalizeText(entry.runtime) === runtimeNorm
    ))
    const latest = latestByUpdatedAt(matching)
    if (!latest) return null
    if (latest.status !== 'BLOCKED') return null

    const attempts = await this.countRecentFailuresByFingerprint(latest.fingerprint)
    return attempts >= 3 ? latest : null
  }

  private async countRecentFailuresByFingerprint(fingerprint: string): Promise<number> {
    const fingerprintNorm = normalizeText(fingerprint)
    if (!fingerprintNorm) return 0
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers.slice(-FAILURE_WINDOW_TURNS)

    let count = 0
    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const value = normalizeText(parsed.failure_fingerprint)
        if (value && value === fingerprintNorm) {
          count += 1
        }
      } catch {
        // Ignore malformed historical JSON.
      }
    }

    return count
  }

  async recordDeterministicFailure(input: {
    cmd: string
    runtime: string
    fingerprint: string
    errorLine: string
    evidencePath: string
    alternatives: string[]
  }): Promise<FailureEntry | null> {
    const attempts = await this.countRecentFailuresByFingerprint(input.fingerprint)
    if (attempts < 2) {
      return null
    }

    const entries = await this.load()

    const status: FailureStatus = attempts >= 3 ? 'BLOCKED' : 'WARN'
    const next: FailureEntry = {
      status,
      runtime: input.runtime,
      cmd: input.cmd,
      fingerprint: input.fingerprint,
      errorLine: input.errorLine,
      was: '',
      resolved: '',
      evidencePath: input.evidencePath,
      attempts,
      alternatives: input.alternatives,
      updatedAt: toIso(this.now)
    }

    entries.push(next)

    await this.save(entries)
    return next
  }

  async clearBlockedAfterVerifiedSuccess(input: {
    cmd: string
    runtime: string
    resolved: string
    evidencePath: string
  }): Promise<boolean> {
    const entries = await this.load()
    const cmdNorm = normalizeCmd(input.cmd)
    const runtimeNorm = normalizeText(input.runtime)
    const matching = entries.filter((entry) => (
      normalizeCmd(entry.cmd) === cmdNorm
      && normalizeText(entry.runtime) === runtimeNorm
    ))
    const latest = latestByUpdatedAt(matching)
    if (!latest || latest.status !== 'BLOCKED') {
      return false
    }

    const unblocked: FailureEntry = {
      status: 'UNBLOCKED',
      runtime: input.runtime,
      cmd: input.cmd,
      fingerprint: latest.fingerprint,
      errorLine: latest.errorLine,
      was: `BLOCKED (${latest.errorLine || 'unknown'})`,
      resolved: input.resolved.trim() || 'minimal verification passed',
      evidencePath: input.evidencePath,
      attempts: 0,
      alternatives: [],
      updatedAt: toIso(this.now)
    }

    entries.push(unblocked)
    await this.save(entries)
    return true
  }
}
