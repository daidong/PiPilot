/**
 * Regression tests for `countCoreFields` (RFC-007 PR-C bug fix).
 *
 * The function decides which papers to skip during enrichment. Before
 * this fix it counted `unknown:*` DOI placeholders as evidence that
 * the paper was "already enriched" → CrossRef + Semantic Scholar got
 * no chance to discover the real DOI, even when title+author would
 * have matched.
 *
 * Pure function, no IPC, no LLM, no file IO.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countCoreFields, type PaperInput } from '../metadata-enrichment.js'

function paperInput(overrides: Partial<PaperInput> = {}): PaperInput {
  // Build a 4-field baseline: title, authors, year, abstract.
  return {
    title: 'A Paper',
    authors: ['Author A'],
    year: 2024,
    abstract: 'An abstract.',
    ...overrides,
  } as PaperInput
}

test('baseline: 4 real fields → count is 4', () => {
  assert.equal(countCoreFields(paperInput()), 4)
})

test('real DOI counts: 4 real + DOI → count is 5', () => {
  assert.equal(countCoreFields(paperInput({ doi: '10.1234/real' })), 5)
})

test('REGRESSION: unknown:* DOI does NOT count → still 4', () => {
  // Before the fix this returned 5. enrichPaperArtifacts:95 (>= 5 → skip)
  // would then refuse to look up the real DOI, leaving the paper
  // permanently stuck on its placeholder.
  assert.equal(countCoreFields(paperInput({ doi: 'unknown:foo2024' })), 4)
})

test('empty-string DOI does not count', () => {
  assert.equal(countCoreFields(paperInput({ doi: '' })), 4)
})

test('null DOI does not count', () => {
  assert.equal(countCoreFields(paperInput({ doi: null })), 4)
})

test('citationCount: zero is a real value, counts', () => {
  // Defensible: enrichment that returns citationCount=0 is still
  // signal (paper exists in CrossRef). Don't re-trigger lookup.
  assert.equal(countCoreFields(paperInput({ citationCount: 0 })), 5)
})

test('all 7 fields present (real DOI + real citationCount) → count is 7', () => {
  assert.equal(
    countCoreFields(paperInput({
      venue: 'NeurIPS',
      doi: '10.1234/real',
      citationCount: 12,
    })),
    7,
  )
})

test('all 6 real fields + unknown:* DOI → count is 6, not 7', () => {
  // Important: keep counting the OTHER fields correctly even when
  // we exclude unknown:*. This prevents over-correction.
  assert.equal(
    countCoreFields(paperInput({
      venue: 'NeurIPS',
      doi: 'unknown:foo',
      citationCount: 12,
    })),
    6,
  )
})

test('the real-world bug scenario: 4 real fields + unknown:* DOI → enrichment NOT skipped', () => {
  // This is the exact shape that triggered the deadlock on a user's
  // 195-paper workspace. paper-enrichment.ts:95 uses `>= 5` as the
  // skip threshold; before the fix this returned 5 (skip), after the
  // fix it returns 4 (enrich). Pin the boundary.
  const paper = paperInput({ doi: 'unknown:foo2024' })
  const count = countCoreFields(paper)
  assert.equal(count, 4)
  assert.ok(count < 5, 'must be below the >=5 skip threshold')
})
