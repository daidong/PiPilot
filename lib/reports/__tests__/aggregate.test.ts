/**
 * Tests for deterministic report aggregation (RFC-007 PR-B).
 *
 * No LLM, no file IO. Pure function over a `ReportInput` fixture.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateReport } from '../aggregate.js'
import type { ReportInput, ReportPaperEntry } from '../types.js'
import type { PaperArtifact } from '../../types.js'
import type { WikiPaperMemoryMeta } from '../../wiki/memory-schema.js'

// ─── Fixture builders ────────────────────────────────────────────────────

function paper(citeKey: string, overrides: Partial<PaperArtifact> = {}): PaperArtifact {
  return {
    id: `art-${citeKey}`,
    type: 'paper',
    title: `Title ${citeKey}`,
    citeKey,
    bibtex: '',
    doi: `10.1/${citeKey}`,
    authors: ['Author A.'],
    abstract: 'An abstract.',
    tags: [],
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as PaperArtifact
}

function wiki(citeKey: string, overrides: Partial<WikiPaperMemoryMeta> = {}): WikiPaperMemoryMeta {
  return {
    schemaVersion: 3,
    canonicalKey: `doi:10.1/${citeKey}`,
    slug: `slug-${citeKey}`,
    generated_at: '2026-01-01T00:00:00Z',
    generator_version: 1,
    source_tier: 'fulltext',
    paper_type: 'method',
    tldr: `TLDR for ${citeKey}.`,
    methods: ['Transformer', 'Self-attention'],
    datasets: [],
    findings: [],
    baselines: [],
    concept_edges: [],
    aliases: [],
    limitations: [],
    negative_results: [],
    ...overrides,
  } as WikiPaperMemoryMeta
}

function entry(citeKey: string, paperOverrides: Partial<PaperArtifact> = {}, wikiOverrides: Partial<WikiPaperMemoryMeta> | null = {}): ReportPaperEntry {
  return {
    paper: paper(citeKey, paperOverrides),
    wiki: wikiOverrides === null ? null : wiki(citeKey, wikiOverrides),
    wikiSlug: `slug-${citeKey}`,
  }
}

function inputOf(entries: ReportPaperEntry[]): ReportInput {
  return {
    projectPath: '/tmp/test',
    projectName: 'TestProject',
    papers: entries,
    capturedAt: '2026-05-12T00:00:00Z',
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('source tier counts: fulltext vs abstract-only', () => {
  const input = inputOf([
    entry('a', {}, { source_tier: 'fulltext' }),
    entry('b', {}, { source_tier: 'fulltext' }),
    entry('c', {}, { source_tier: 'abstract-only' }),
    entry('d', {}, null),  // no wiki at all → treated as abstract-only
  ])
  const agg = aggregateReport(input)
  assert.equal(agg.fulltextCount, 2)
  assert.equal(agg.abstractOnlyCount, 2)
  assert.equal(agg.totalPapers, 4)
})

test('year distribution: sorted asc, only papers with year', () => {
  const input = inputOf([
    entry('a', { year: 2024 }),
    entry('b', { year: 2022 }),
    entry('c', { year: 2024 }),
    entry('d', { year: undefined }),  // no year → excluded
  ])
  const agg = aggregateReport(input)
  assert.deepEqual(agg.yearDistribution, [
    { year: 2022, count: 1 },
    { year: 2024, count: 2 },
  ])
  assert.equal(agg.earliestYear, 2022)
  assert.equal(agg.latestYear, 2024)
})

test('year distribution: all papers missing year → null span', () => {
  const input = inputOf([entry('a', { year: undefined })])
  const agg = aggregateReport(input)
  assert.equal(agg.earliestYear, null)
  assert.equal(agg.latestYear, null)
  assert.equal(agg.yearDistribution.length, 0)
})

test('top-cited: sorted desc, capped at 5', () => {
  const input = inputOf([
    entry('a', { citationCount: 10 }),
    entry('b', { citationCount: 100 }),
    entry('c', { citationCount: 50 }),
    entry('d', { citationCount: 0 }),  // zero excluded
    entry('e', { citationCount: 200 }),
    entry('f', { citationCount: 5 }),
    entry('g', { citationCount: 25 }),
  ])
  const agg = aggregateReport(input)
  assert.equal(agg.topCited.length, 5)
  assert.equal(agg.topCited[0].citeKey, 'e')  // 200
  assert.equal(agg.topCited[1].citeKey, 'b')  // 100
  assert.equal(agg.topCited[2].citeKey, 'c')  // 50
  assert.equal(agg.topCited[3].citeKey, 'g')  // 25
  assert.equal(agg.topCited[4].citeKey, 'a')  // 10
})

test('methods histogram: normalizes case + plural, min-count gate of 2', () => {
  const input = inputOf([
    entry('a', {}, { methods: ['Transformer', 'BERT'] }),
    entry('b', {}, { methods: ['transformer'] }),         // case-normalized → same bucket as 'Transformer'
    entry('c', {}, { methods: ['Transformers'] }),         // plural-normalized → same bucket
    entry('d', {}, { methods: ['BERT'] }),
    entry('e', {}, { methods: ['LSTM'] }),                 // single occurrence → dropped
  ])
  const agg = aggregateReport(input)
  // Three contributors to "Transformer" bucket: a, b, c.
  const trans = agg.methods.find((m) => m.term.toLowerCase().startsWith('transformer'))
  assert.ok(trans, 'transformer bucket exists')
  assert.equal(trans!.count, 3)
  assert.deepEqual(trans!.citeKeys.sort(), ['a', 'b', 'c'])
  // BERT has 2 → in
  const bert = agg.methods.find((m) => m.term === 'BERT')
  assert.ok(bert, 'BERT bucket exists')
  assert.equal(bert!.count, 2)
  // LSTM has 1 → dropped
  assert.equal(agg.methods.find((m) => m.term === 'LSTM'), undefined)
})

test('methods histogram: most-common original casing wins for display', () => {
  // Three "transformer" lowercase occurrences should beat one "Transformer" cap.
  const input = inputOf([
    entry('a', {}, { methods: ['transformer'] }),
    entry('b', {}, { methods: ['transformer'] }),
    entry('c', {}, { methods: ['transformer'] }),
    entry('d', {}, { methods: ['Transformer'] }),
  ])
  const agg = aggregateReport(input)
  const trans = agg.methods.find((m) => m.term.toLowerCase().startsWith('transformer'))
  assert.equal(trans?.term, 'transformer')
})

test('datasets histogram: dedups across papers, picks display form', () => {
  const input = inputOf([
    entry('a', {}, { datasets: [{ name: 'ImageNet' }] }),
    entry('b', {}, { datasets: [{ name: 'imagenet' }] }),
    entry('c', {}, { datasets: [{ name: 'CIFAR-10' }, { name: 'ImageNet' }] }),
  ])
  const agg = aggregateReport(input)
  const imagenet = agg.datasets.find((d) => d.term.toLowerCase().startsWith('imagenet'))
  assert.ok(imagenet)
  assert.equal(imagenet!.count, 3)
})

test('limitations + negative results flattened with citeKeys', () => {
  const input = inputOf([
    entry('a', {}, { limitations: [{ text: 'No GPU support' }, { text: 'Single-language only' }] }),
    entry('b', {}, { negative_results: [{ text: 'Method X failed on small data' }] }),
  ])
  const agg = aggregateReport(input)
  assert.equal(agg.limitations.length, 2)
  assert.equal(agg.limitations[0].citeKey, 'a')
  assert.equal(agg.negativeResults.length, 1)
  assert.equal(agg.negativeResults[0].citeKey, 'b')
})

test('empty input is a safe no-op', () => {
  const agg = aggregateReport(inputOf([]))
  assert.equal(agg.totalPapers, 0)
  assert.equal(agg.fulltextCount, 0)
  assert.equal(agg.abstractOnlyCount, 0)
  assert.deepEqual(agg.yearDistribution, [])
  assert.deepEqual(agg.topCited, [])
  assert.deepEqual(agg.methods, [])
  assert.equal(agg.earliestYear, null)
})

test('paper with no citeKey is skipped silently (defensive)', () => {
  const input = inputOf([
    entry('a'),
    { paper: { ...paper('b'), citeKey: '' } as PaperArtifact, wiki: wiki('b') },
  ])
  const agg = aggregateReport(input)
  assert.equal(agg.totalPapers, 2, 'still counted in total')
  // But the b paper has empty citeKey, so its methods are dropped.
  assert.equal(agg.methods.length, 0, 'no methods entries because b was skipped')
})
