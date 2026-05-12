/**
 * Tests for the markdown + HTML renderers (RFC-007 PR-B).
 *
 * These are structural smoke tests, not formatting goldens — we verify
 * the report contains the expected sections, has properly linked
 * cite-keys, and emits stable empty-state copy when sections have no
 * content.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../render-markdown.js'
import { renderHtml } from '../render-html.js'
import type { ReportInput, AggregateSummary, SynthesisOutput, OnboardingPath, ReportPaperEntry } from '../types.js'
import type { PaperArtifact } from '../../types.js'
import type { WikiPaperMemoryMeta } from '../../wiki/memory-schema.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

function paper(citeKey: string, overrides: Partial<PaperArtifact> = {}): PaperArtifact {
  return {
    id: `art-${citeKey}`,
    type: 'paper',
    title: `Title ${citeKey}`,
    citeKey,
    bibtex: '',
    doi: `10.1/${citeKey}`,
    authors: ['First Last'],
    abstract: 'Some abstract.',
    year: 2024,
    venue: 'NeurIPS',
    tags: [],
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as PaperArtifact
}

function wiki(citeKey: string): WikiPaperMemoryMeta {
  return {
    schemaVersion: 3,
    canonicalKey: `doi:10.1/${citeKey}`,
    slug: `slug-${citeKey}`,
    generated_at: '2026-01-01T00:00:00Z',
    generator_version: 1,
    source_tier: 'fulltext',
    paper_type: 'method',
    tldr: `TLDR for ${citeKey}.`,
  } as WikiPaperMemoryMeta
}

function entry(citeKey: string): ReportPaperEntry {
  return { paper: paper(citeKey), wiki: wiki(citeKey), wikiSlug: `slug-${citeKey}` }
}

function inputOf(citeKeys: string[]): ReportInput {
  return {
    projectPath: '/tmp/test',
    projectName: 'TestLab',
    papers: citeKeys.map(entry),
    capturedAt: '2026-05-12T00:00:00Z',
  }
}

function emptyAgg(papers: number): AggregateSummary {
  return {
    totalPapers: papers,
    fulltextCount: papers,
    abstractOnlyCount: 0,
    earliestYear: papers > 0 ? 2024 : null,
    latestYear: papers > 0 ? 2024 : null,
    yearDistribution: papers > 0 ? [{ year: 2024, count: papers }] : [],
    topCited: [],
    methods: [],
    datasets: [],
    limitations: [],
    negativeResults: [],
  }
}

const emptySynthesis: SynthesisOutput = { themes: [], talkingPoints: [] }
const emptyRanking: OnboardingPath = { entries: [] }

// ─── Markdown ────────────────────────────────────────────────────────────

test('renderMarkdown: emits H1 with project name + date in header', () => {
  const md = renderMarkdown(inputOf(['a']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(md, /^# Paper Pack Report — TestLab/)
  assert.match(md, /Generated 2026-05-12/)
  assert.match(md, /1 papers/)
})

test('renderMarkdown: cite-keys become anchor-linked markdown', () => {
  const synthesis: SynthesisOutput = {
    themes: [
      { name: 'Theme One', papers: ['a', 'b'], synthesis: 'Claim X [a] and Y [b].' },
    ],
    talkingPoints: [{ point: 'Surprising thing [a].', citeKeys: ['a'] }],
  }
  const md = renderMarkdown(inputOf(['a', 'b']), emptyAgg(2), synthesis, emptyRanking)
  // Inline [a] → [a](#cite-a)
  assert.match(md, /\[a\]\(#cite-a\)/)
  assert.match(md, /\[b\]\(#cite-b\)/)
  // Theme header
  assert.match(md, /### Theme One \(2 papers\)/)
})

test('renderMarkdown: appendix has stable anchor for each paper', () => {
  const md = renderMarkdown(inputOf(['alpha', 'beta']), emptyAgg(2), emptySynthesis, emptyRanking)
  assert.match(md, /<a id="cite-alpha"><\/a>alpha/)
  assert.match(md, /<a id="cite-beta"><\/a>beta/)
})

test('renderMarkdown: empty themes falls back to graceful copy', () => {
  const md = renderMarkdown(inputOf(['a']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(md, /No thematic synthesis available/)
})

test('renderMarkdown: empty methods + datasets shows empty-state copy', () => {
  const md = renderMarkdown(inputOf(['a']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(md, /No recurring methods detected/)
  assert.match(md, /No recurring datasets detected/)
})

test('renderMarkdown: methods histogram emits a list with refs', () => {
  const agg: AggregateSummary = {
    ...emptyAgg(3),
    methods: [
      { term: 'Transformer', count: 3, citeKeys: ['a', 'b', 'c'] },
    ],
  }
  const md = renderMarkdown(inputOf(['a', 'b', 'c']), agg, emptySynthesis, emptyRanking)
  assert.match(md, /\*\*Transformer\*\* — 3 papers/)
  assert.match(md, /\[a\]\(#cite-a\), \[b\]\(#cite-b\), \[c\]\(#cite-c\)/)
})

test('renderMarkdown: onboarding path numbered + linked', () => {
  const ranking: OnboardingPath = {
    entries: [
      {
        citeKey: 'a',
        title: 'Foundational',
        oneLineWhy: 'A foundational paper.',
        scoreComponents: { isSurvey: true, citationCount: 100, conceptCentrality: 5 },
      },
      {
        citeKey: 'b',
        title: 'Frontier',
        oneLineWhy: 'A frontier paper.',
        scoreComponents: { isSurvey: false, citationCount: 30, conceptCentrality: 1 },
      },
    ],
  }
  const md = renderMarkdown(inputOf(['a', 'b']), emptyAgg(2), emptySynthesis, ranking)
  assert.match(md, /1\. \[a\]\(#cite-a\)/)
  assert.match(md, /2\. \[b\]\(#cite-b\)/)
  assert.match(md, /_\(survey\)_/)  // survey badge inline
})

// ─── HTML ────────────────────────────────────────────────────────────────

test('renderHtml: produces a valid-looking HTML document', () => {
  const html = renderHtml(inputOf(['a']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(html, /^<!DOCTYPE html>/)
  assert.match(html, /<title>Paper Pack Report — TestLab<\/title>/)
  assert.match(html, /<style>/)
})

test('renderHtml: cite-keys become anchor links', () => {
  const synthesis: SynthesisOutput = {
    themes: [{ name: 'T1', papers: ['a'], synthesis: 'Claim [a].' }],
    talkingPoints: [],
  }
  const html = renderHtml(inputOf(['a']), emptyAgg(1), synthesis, emptyRanking)
  assert.match(html, /<a class="cite" href="#cite-a">\[a\]<\/a>/)
})

test('renderHtml: appendix article has id="cite-citekey"', () => {
  const html = renderHtml(inputOf(['alpha']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(html, /<article id="cite-alpha" class="paper-card">/)
})

test('renderHtml: abstract-only paper carries the badge', () => {
  const e: ReportPaperEntry = { paper: paper('thin'), wiki: { ...wiki('thin'), source_tier: 'abstract-only' } as WikiPaperMemoryMeta }
  const input: ReportInput = {
    projectPath: '/tmp/test',
    projectName: 'TestLab',
    papers: [e],
    capturedAt: '2026-05-12T00:00:00Z',
  }
  const agg: AggregateSummary = { ...emptyAgg(1), fulltextCount: 0, abstractOnlyCount: 1 }
  const html = renderHtml(input, agg, emptySynthesis, emptyRanking)
  assert.match(html, /abstract only/)
})

test('renderHtml: escapes HTML in user-supplied strings (XSS guard)', () => {
  const malicious = paper('xss', {
    title: '<script>alert("XSS")</script>',
  })
  const input: ReportInput = {
    projectPath: '/tmp/test',
    projectName: 'TestLab',
    papers: [{ paper: malicious, wiki: wiki('xss') }],
    capturedAt: '2026-05-12T00:00:00Z',
  }
  const html = renderHtml(input, emptyAgg(1), emptySynthesis, emptyRanking)
  assert.ok(!html.includes('<script>alert'), 'raw script tag must not survive')
  assert.match(html, /&lt;script&gt;alert/)
})

test('renderHtml: year histogram emits inline bars when data exists', () => {
  const html = renderHtml(inputOf(['a']), emptyAgg(1), emptySynthesis, emptyRanking)
  assert.match(html, /year-histogram/)
})

test('renderHtml: malicious theme name + synthesis are escaped', () => {
  const synthesis: SynthesisOutput = {
    themes: [{ name: '<img src=x onerror=alert(1)>', papers: ['a'], synthesis: 'Claim <b>X</b> [a].' }],
    talkingPoints: [],
  }
  const html = renderHtml(inputOf(['a']), emptyAgg(1), synthesis, emptyRanking)
  assert.ok(!html.includes('<img src=x onerror'), 'theme name xss escaped')
  assert.ok(!html.includes('<b>X</b>'), 'synthesis body escaped, no raw html')
})
