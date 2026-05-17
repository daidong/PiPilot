/**
 * Tests for the deterministic onboarding-path ranker (RFC-007 PR-B).
 *
 * The ranker assigns each paper a score = 0.5 × isSurvey + 0.3 × citation-
 * norm + 0.2 × concept-centrality-norm, then returns the top 5 in order.
 *
 * These tests pin specific orderings against fixtures with known
 * structure, so a future change to the scoring formula trips a clear
 * red flag rather than silently shifting recommendations.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankOnboardingPath } from '../ranker.js'
import type { ReportInput, ReportPaperEntry } from '../types.js'
import type { PaperArtifact } from '../../types.js'
import type { WikiPaperMemoryMeta } from '../../wiki/memory-schema.js'

function paper(citeKey: string, year = 2024, citationCount?: number): PaperArtifact {
  return {
    id: `art-${citeKey}`,
    type: 'paper',
    title: `Title for ${citeKey}`,
    citeKey,
    bibtex: '',
    doi: `10.1/${citeKey}`,
    authors: ['Author'],
    abstract: `Abstract of ${citeKey}.`,
    year,
    citationCount,
    tags: [],
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as PaperArtifact
}

function wiki(
  citeKey: string,
  paperType: WikiPaperMemoryMeta['paper_type'] = 'method',
  conceptEdges: Array<{ slug: string; relation: 'introduces' | 'uses' | 'advances' | 'critiques' }> = [],
  aliases: string[] = [],
  tldr?: string,
): WikiPaperMemoryMeta {
  return {
    schemaVersion: 3,
    canonicalKey: `doi:10.1/${citeKey}`,
    slug: `slug-${citeKey}`,
    generated_at: '2026-01-01T00:00:00Z',
    generator_version: 1,
    source_tier: 'fulltext',
    paper_type: paperType,
    tldr: tldr ?? `TLDR ${citeKey}`,
    methods: [],
    datasets: [],
    findings: [],
    baselines: [],
    concept_edges: conceptEdges,
    aliases,
    limitations: [],
    negative_results: [],
  } as WikiPaperMemoryMeta
}

function entry(p: PaperArtifact, w: WikiPaperMemoryMeta | null): ReportPaperEntry {
  return { paper: p, wiki: w, wikiSlug: w?.slug }
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

test('empty input returns empty path', () => {
  const result = rankOnboardingPath(inputOf([]))
  assert.deepEqual(result.entries, [])
})

test('survey paper outranks high-citation non-survey', () => {
  const survey = entry(paper('survey1', 2024, 30), wiki('survey1', 'review'))
  const cited = entry(paper('cited1', 2024, 1000), wiki('cited1', 'method'))
  const result = rankOnboardingPath(inputOf([cited, survey]))
  assert.equal(result.entries[0].citeKey, 'survey1', 'survey wins')
  assert.equal(result.entries[1].citeKey, 'cited1')
})

test('among non-surveys, higher citation count wins', () => {
  const a = entry(paper('a', 2024, 50), wiki('a', 'method'))
  const b = entry(paper('b', 2024, 200), wiki('b', 'method'))
  const c = entry(paper('c', 2024, 10), wiki('c', 'method'))
  const result = rankOnboardingPath(inputOf([a, b, c]))
  assert.deepEqual(result.entries.map((e) => e.citeKey), ['b', 'a', 'c'])
})

test('caps at 5 entries', () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    entry(paper(`p${i}`, 2024, (10 - i) * 10), wiki(`p${i}`, 'method'))
  )
  const result = rankOnboardingPath(inputOf(entries))
  assert.equal(result.entries.length, 5)
})

test('concept centrality boosts a foundational paper', () => {
  // a defines two concepts (via aliases). b, c, d all USE those concepts.
  // a should out-rank a peer with the same citation count but no incoming concept refs.
  const a = entry(
    paper('a', 2024, 100),
    wiki('a', 'method', [], ['attention', 'transformer-block'])  // a's aliases
  )
  const peer = entry(
    paper('peer', 2024, 100),
    wiki('peer', 'method', [], ['unrelated-concept'])
  )
  const b = entry(
    paper('b', 2024, 50),
    wiki('b', 'method', [{ slug: 'attention', relation: 'uses' }])
  )
  const c = entry(
    paper('c', 2024, 50),
    wiki('c', 'method', [{ slug: 'transformer-block', relation: 'uses' }])
  )
  const d = entry(
    paper('d', 2024, 50),
    wiki('d', 'method', [{ slug: 'attention', relation: 'advances' }])
  )
  const result = rankOnboardingPath(inputOf([peer, a, b, c, d]))
  // a's concept centrality is 3 (b, c, d), peer's is 0 → a wins.
  assert.equal(result.entries[0].citeKey, 'a')
  // peer should be ranked behind a, but ahead of b/c/d since it has higher
  // citation count than them.
  assert.equal(result.entries[1].citeKey, 'peer')
})

test('oneLineWhy prefers wiki.tldr over abstract', () => {
  const a = entry(paper('a', 2024, 1), wiki('a', 'method', [], [], 'Wiki-supplied TLDR.'))
  const b = entry(
    { ...paper('b', 2024, 0), abstract: 'A paper abstract. With sentences.' } as PaperArtifact,
    null,
  )
  const result = rankOnboardingPath(inputOf([a, b]))
  assert.equal(result.entries[0].oneLineWhy, 'Wiki-supplied TLDR.')
  assert.equal(result.entries[1].oneLineWhy, 'A paper abstract.')
})

test('isSurvey flag surfaces correctly in scoreComponents', () => {
  const survey = entry(paper('s', 2024, 1), wiki('s', 'review'))
  const result = rankOnboardingPath(inputOf([survey]))
  assert.equal(result.entries[0].scoreComponents.isSurvey, true)
})

test('papers without citeKey are excluded', () => {
  const valid = entry(paper('valid', 2024, 10), wiki('valid'))
  const invalid: ReportPaperEntry = {
    paper: { ...paper('', 2024, 100), citeKey: '' } as PaperArtifact,
    wiki: wiki('invalid'),
  }
  const result = rankOnboardingPath(inputOf([invalid, valid]))
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].citeKey, 'valid')
})
