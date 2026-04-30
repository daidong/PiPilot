/**
 * Audit-reports store — write-once JSON files at
 *   .research-pilot/audit-reports/{auditId}.json
 *
 * Quarantined: only the Audit tab's IPC handlers and the auditor itself
 * touch this directory (RFC §3.6).
 *
 * Resolution state lives in a sibling file `{auditId}.state.json` so the
 * original audit report remains byte-for-byte immutable.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PATHS } from '../types.js'
import type { AuditReport, FindingResolution, FindingState } from './types.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface AuditPaths {
  root: string
}

export function auditPaths(projectPath: string): AuditPaths {
  return { root: join(projectPath, PATHS.auditReports) }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export function newAuditId(): string {
  return `aud_${randomUUID().replace(/-/g, '')}`
}

// ---------------------------------------------------------------------------
// Write-once report persistence
// ---------------------------------------------------------------------------

export async function writeAuditReport(projectPath: string, report: AuditReport): Promise<string> {
  const paths = auditPaths(projectPath)
  ensureDir(paths.root)
  const file = join(paths.root, `${report.id}.json`)
  if (existsSync(file)) {
    throw new Error(`audit report ${report.id} already exists — reports are write-once`)
  }
  await writeFile(file, JSON.stringify(report, null, 2), 'utf-8')
  return file
}

export async function readAuditReport(projectPath: string, auditId: string): Promise<AuditReport | null> {
  const file = join(auditPaths(projectPath).root, `${auditId}.json`)
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf-8')
  try {
    return JSON.parse(raw) as AuditReport
  } catch {
    return null
  }
}

export async function listAuditReports(projectPath: string): Promise<AuditReport[]> {
  const paths = auditPaths(projectPath)
  if (!existsSync(paths.root)) return []
  const out: AuditReport[] = []
  for (const name of readdirSync(paths.root)) {
    if (!name.endsWith('.json') || name.endsWith('.state.json')) continue
    const id = name.slice(0, -'.json'.length)
    const r = await readAuditReport(projectPath, id)
    if (r) out.push(r)
  }
  // Newest first.
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

// ---------------------------------------------------------------------------
// Per-finding state (mutable: resolved / dismissed)
// ---------------------------------------------------------------------------

interface AuditState {
  findings: FindingState[]
}

function stateFile(projectPath: string, auditId: string): string {
  return join(auditPaths(projectPath).root, `${auditId}.state.json`)
}

export async function readAuditState(projectPath: string, auditId: string): Promise<AuditState> {
  const file = stateFile(projectPath, auditId)
  if (!existsSync(file)) return { findings: [] }
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as AuditState
  } catch {
    return { findings: [] }
  }
}

export async function setFindingResolution(
  projectPath: string,
  auditId: string,
  findingId: string,
  resolution: FindingResolution,
  reason?: string
): Promise<void> {
  const state = await readAuditState(projectPath, auditId)
  const idx = state.findings.findIndex(f => f.findingId === findingId)
  const entry: FindingState = {
    findingId,
    resolution,
    resolvedAt: new Date().toISOString(),
    reason
  }
  if (idx >= 0) state.findings[idx] = entry
  else state.findings.push(entry)
  ensureDir(auditPaths(projectPath).root)
  await writeFile(stateFile(projectPath, auditId), JSON.stringify(state, null, 2), 'utf-8')
}
