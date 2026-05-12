/**
 * Tests for the Paper Report button state machine (RFC-007 PR-A).
 *
 * Validates the pure `deriveButtonState` function against every input
 * combination that maps to a distinct visible state. No live Zustand
 * subscriptions, no IPC — just snapshot in, state out.
 *
 * Also tests `computeInputHash` for stability across order permutations.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pure-logic module — no window dependency, no transitive store
// imports. Safe to import directly under node:test.
import {
  deriveButtonState,
  computeInputHash,
  type ButtonStateInputs,
  type WikiStatusShape,
} from '../report-button-state.ts'

// ─── Test data helpers ────────────────────────────────────────────────────

/** Build a paper with N core fields populated (or all if N=7). */
function paper(citeKey: string, coreCount: number = 7): any {
  const base: any = {
    id: citeKey,
    type: 'paper',
    title: 'A Paper',
    citeKey,
  }
  // Maximally populate; then strip down to coreCount.
  const FULL: Record<string, unknown> = {
    title: 'A Paper',
    authors: ['Author A.'],
    year: 2024,
    venue: 'NeurIPS',
    abstract: 'Some abstract here.',
    doi: '10.1234/real',
    citationCount: 7,
  }
  const keys = Object.keys(FULL)
  for (let i = 0; i < keys.length; i++) {
    if (i < coreCount) base[keys[i]] = FULL[keys[i]]
  }
  return base
}

function wikiIdle(): WikiStatusShape {
  return { state: 'idle', processed: 10, pending: 0, totalInWiki: 10 }
}

function wikiProcessing(processed = 3, pending = 7): WikiStatusShape {
  return { state: 'processing', processed, pending, totalInWiki: processed + pending }
}

const EMPTY_INPUTS: ButtonStateInputs = {
  papers: [],
  enrichmentStatus: 'idle',
  wikiStatus: null,
  reportStatus: 'idle',
  currentInputHash: 'h',
}

// ─── State coverage ───────────────────────────────────────────────────────

test('no-papers: empty library → no-papers', () => {
  assert.equal(deriveButtonState(EMPTY_INPUTS), 'no-papers')
})

test('pre-enrichment: papers exist, enrichment idle, most papers thin', () => {
  const papers = [paper('a', 2), paper('b', 2), paper('c', 2)]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers }),
    'pre-enrichment',
  )
})

test('pre-enrichment: unknown:* DOI counts as missing for enrichment heuristic', () => {
  // A paper with everything filled BUT doi='unknown:foo' has 6 real core
  // fields, not 7 — and could be at 5 with abstract missing. We want
  // such papers to count as "needs enrichment".
  const p = paper('a', 7)
  p.doi = 'unknown:a'
  delete p.abstract
  delete p.venue
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers: [p] }),
    'pre-enrichment',
    'unknown:* DOI + missing fields should fall below the threshold',
  )
})

test('enriching: enrichment is running, regardless of paper richness', () => {
  const papers = [paper('a', 7), paper('b', 7)]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, enrichmentStatus: 'running' }),
    'enriching',
  )
})

test('pre-wiki: papers well-enriched, but wiki status not loaded yet', () => {
  const papers = [paper('a', 7), paper('b', 7)]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, wikiStatus: null }),
    'pre-wiki',
  )
})

test('pre-wiki: papers well-enriched, wiki disabled', () => {
  const papers = [paper('a', 7), paper('b', 7)]
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: { state: 'disabled', processed: 0, pending: 0, totalInWiki: 0 },
    }),
    'pre-wiki',
  )
})

test('pre-wiki: papers well-enriched, wiki processing', () => {
  const papers = [paper('a', 7), paper('b', 7)]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, wikiStatus: wikiProcessing() }),
    'pre-wiki',
  )
})

test('pre-wiki: wiki idle but pending > 0 — still queueing', () => {
  const papers = [paper('a', 7), paper('b', 7)]
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: { state: 'idle', processed: 3, pending: 7, totalInWiki: 10 },
    }),
    'pre-wiki',
  )
})

test('ready: enrichment idle, wiki idle + pending=0, no report yet', () => {
  const papers = [paper('a', 7), paper('b', 7), paper('c', 7)]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, wikiStatus: wikiIdle() }),
    'ready',
  )
})

test('ready: 90% of papers enriched is enough (10% can be perma-thin)', () => {
  // 9 well-enriched, 1 thin. Threshold is 90% → pass.
  const papers = [
    ...Array.from({ length: 9 }, (_, i) => paper(`good${i}`, 7)),
    paper('bad', 2),
  ]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, wikiStatus: wikiIdle() }),
    'ready',
  )
})

test('pre-enrichment: 89% enriched is below threshold', () => {
  // 8 / 10 = 80% well-enriched → below 90% → pre-enrichment.
  const papers = [
    ...Array.from({ length: 8 }, (_, i) => paper(`good${i}`, 7)),
    paper('bad1', 2),
    paper('bad2', 2),
  ]
  assert.equal(
    deriveButtonState({ ...EMPTY_INPUTS, papers, wikiStatus: wikiIdle() }),
    'pre-enrichment',
  )
})

// ─── Report state overrides ──────────────────────────────────────────────

test('generating: reportStatus=running overrides any pipeline state', () => {
  const papers = [paper('a', 7)]
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      enrichmentStatus: 'running',  // would normally be 'enriching'
      reportStatus: 'running',
    }),
    'generating',
  )
})

test('error: reportStatus=error overrides pipeline state', () => {
  const papers = [paper('a', 7)]
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: wikiIdle(),
      reportStatus: 'error',
    }),
    'error',
  )
})

test('done: report status=done AND hash matches → done', () => {
  const papers = [paper('a', 7)]
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: wikiIdle(),
      reportStatus: 'done',
      reportInputHash: 'h-match',
      currentInputHash: 'h-match',
    }),
    'done',
  )
})

test('NOT done: report status=done but hash differs → falls through to ready (regeneratable)', () => {
  const papers = [paper('a', 7)]
  // User imported more papers after last report — hash now differs.
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: wikiIdle(),
      reportStatus: 'done',
      reportInputHash: 'h-old',
      currentInputHash: 'h-new',
    }),
    'ready',
    'stale report should not block regeneration',
  )
})

test('NOT done: report status=done with NO inputHash recorded → falls through to ready', () => {
  const papers = [paper('a', 7)]
  // Defensive: stored state missing the hash field entirely.
  assert.equal(
    deriveButtonState({
      ...EMPTY_INPUTS,
      papers,
      wikiStatus: wikiIdle(),
      reportStatus: 'done',
      // reportInputHash: undefined
      currentInputHash: 'h',
    }),
    'ready',
  )
})

// ─── Input hash ──────────────────────────────────────────────────────────

test('computeInputHash: stable across paper order', () => {
  const p1 = paper('a', 7)
  const p2 = paper('b', 7)
  const p3 = paper('c', 7)
  const a = computeInputHash([p1, p2, p3])
  const b = computeInputHash([p3, p1, p2])
  assert.equal(a, b, 'order-independent')
})

test('computeInputHash: changes when papers added', () => {
  const p1 = paper('a', 7)
  const p2 = paper('b', 7)
  const a = computeInputHash([p1])
  const b = computeInputHash([p1, p2])
  assert.notEqual(a, b)
})

test('computeInputHash: empty library is consistent', () => {
  assert.equal(computeInputHash([]), computeInputHash([]))
})

test('computeInputHash: changes when enrichedAt changes (regen trigger)', () => {
  const p = paper('a', 7)
  const a = computeInputHash([p])
  ;(p as any).enrichedAt = '2026-05-12T00:00:00Z'
  const b = computeInputHash([p])
  assert.notEqual(a, b, 'enrichment update should invalidate cache')
})
