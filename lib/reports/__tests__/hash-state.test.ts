/**
 * Tests for the report-input hash and state persistence (RFC-007 PR-B).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeReportInputHash } from '../hash.js'
import {
  readReportState,
  writeReportState,
  resetReportState,
  REPORT_STATE_SCHEMA_VERSION,
} from '../state.js'
import type { ReportInput, ReportPaperEntry } from '../types.js'
import type { PaperArtifact } from '../../types.js'
import type { WikiPaperMemoryMeta } from '../../wiki/memory-schema.js'

function paper(citeKey: string, enrichedAt?: string): PaperArtifact {
  return {
    id: `art-${citeKey}`,
    type: 'paper',
    title: `Title ${citeKey}`,
    citeKey,
    bibtex: '',
    doi: `10.1/${citeKey}`,
    authors: ['Author'],
    abstract: 'abstract',
    tags: [],
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    enrichedAt,
  } as PaperArtifact
}

function wiki(citeKey: string, generated_at = '2026-01-01T00:00:00Z'): WikiPaperMemoryMeta {
  return {
    schemaVersion: 3,
    canonicalKey: `doi:10.1/${citeKey}`,
    slug: `slug-${citeKey}`,
    generated_at,
    generator_version: 1,
    source_tier: 'fulltext',
    paper_type: 'method',
  } as WikiPaperMemoryMeta
}

function inputOf(entries: ReportPaperEntry[]): ReportInput {
  return {
    projectPath: '/tmp/test',
    projectName: 'P',
    papers: entries,
    capturedAt: '2026-05-12T00:00:00Z',
  }
}

// ─── Hash ────────────────────────────────────────────────────────────────

test('hash is stable across paper order', () => {
  const a = { paper: paper('a'), wiki: wiki('a') }
  const b = { paper: paper('b'), wiki: wiki('b') }
  const c = { paper: paper('c'), wiki: wiki('c') }
  const h1 = computeReportInputHash(inputOf([a, b, c]))
  const h2 = computeReportInputHash(inputOf([c, a, b]))
  assert.equal(h1, h2, 'order-independent')
})

test('hash changes when a paper is added', () => {
  const a = { paper: paper('a'), wiki: wiki('a') }
  const b = { paper: paper('b'), wiki: wiki('b') }
  const h1 = computeReportInputHash(inputOf([a]))
  const h2 = computeReportInputHash(inputOf([a, b]))
  assert.notEqual(h1, h2)
})

test('hash changes when enrichedAt changes (re-enrichment busts cache)', () => {
  const a1 = { paper: paper('a'), wiki: wiki('a') }
  const a2 = { paper: paper('a', '2026-02-01T00:00:00Z'), wiki: wiki('a') }
  assert.notEqual(computeReportInputHash(inputOf([a1])), computeReportInputHash(inputOf([a2])))
})

test('hash changes when wiki generated_at changes (wiki re-process busts cache)', () => {
  const a1 = { paper: paper('a'), wiki: wiki('a', '2026-01-01T00:00:00Z') }
  const a2 = { paper: paper('a'), wiki: wiki('a', '2026-03-01T00:00:00Z') }
  assert.notEqual(computeReportInputHash(inputOf([a1])), computeReportInputHash(inputOf([a2])))
})

test('hash differentiates "wiki absent" from "wiki present"', () => {
  const a1 = { paper: paper('a'), wiki: null }
  const a2 = { paper: paper('a'), wiki: wiki('a') }
  assert.notEqual(computeReportInputHash(inputOf([a1])), computeReportInputHash(inputOf([a2])))
})

test('hash output is 32 hex chars (truncated sha256)', () => {
  const h = computeReportInputHash(inputOf([{ paper: paper('a'), wiki: null }]))
  assert.match(h, /^[0-9a-f]{32}$/)
})

test('hash on empty input is consistent', () => {
  assert.equal(computeReportInputHash(inputOf([])), computeReportInputHash(inputOf([])))
})

// ─── State persistence ─────────────────────────────────────────────────

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-report-state-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('readReportState returns null when file does not exist', () => {
  const project = tmpProject()
  try {
    assert.equal(readReportState(project), null)
  } finally {
    cleanup(project)
  }
})

test('writeReportState + readReportState round-trip', () => {
  const project = tmpProject()
  try {
    const state = {
      schemaVersion: REPORT_STATE_SCHEMA_VERSION,
      status: 'done' as const,
      inputHash: 'a'.repeat(32),
      generatedAt: '2026-05-12T00:00:00Z',
      markdownPath: '/tmp/rp.md',
      htmlPath: '/tmp/rp.html',
      stats: {
        paperCount: 25,
        themeCount: 4,
        talkingPointCount: 3,
        onboardingCount: 5,
        fulltextCount: 20,
        abstractOnlyCount: 5,
      },
    }
    writeReportState(project, state)
    const loaded = readReportState(project)
    assert.deepEqual(loaded, state)
  } finally {
    cleanup(project)
  }
})

test('readReportState rejects unknown schemaVersion', () => {
  const project = tmpProject()
  try {
    mkdirSync(join(project, '.research-pilot'), { recursive: true })
    const path = join(project, '.research-pilot', 'report-state.json')
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 999, status: 'done' }),
      'utf-8',
    )
    assert.equal(readReportState(project), null, 'unknown schema → null')
  } finally {
    cleanup(project)
  }
})

test('readReportState tolerates corrupt JSON (returns null)', () => {
  const project = tmpProject()
  try {
    mkdirSync(join(project, '.research-pilot'), { recursive: true })
    const path = join(project, '.research-pilot', 'report-state.json')
    writeFileSync(path, '{ this is not valid }', 'utf-8')
    assert.equal(readReportState(project), null)
  } finally {
    cleanup(project)
  }
})

test('resetReportState writes an idle marker', () => {
  const project = tmpProject()
  try {
    resetReportState(project)
    const loaded = readReportState(project)
    assert.equal(loaded?.status, 'idle')
    assert.ok(existsSync(join(project, '.research-pilot', 'report-state.json')))
  } finally {
    cleanup(project)
  }
})
