import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCitations,
  resolveCitations,
  toCanonicalDoi,
  toCanonicalArxiv,
  toCanonicalUrl,
  type ExtractedCitation
} from '../citations.js'

// ── canonicalizers ──────────────────────────────────────────────────────────

test('toCanonicalDoi: bare, prefixed, mixed-case, trailing punctuation', () => {
  assert.equal(toCanonicalDoi('10.1234/Foo.Bar'), 'doi:10.1234/foo.bar')
  assert.equal(toCanonicalDoi('https://doi.org/10.1234/foo'), 'doi:10.1234/foo')
  // sentence period / markdown paren should not leak into the id
  assert.equal(toCanonicalDoi('10.1234/foo.'), 'doi:10.1234/foo')
  assert.equal(toCanonicalDoi('10.1234/foo)'), 'doi:10.1234/foo')
  assert.equal(toCanonicalDoi('not a doi'), null)
})

test('toCanonicalArxiv: version suffix stripped, old-style ids kept', () => {
  assert.equal(toCanonicalArxiv('2404.18021v2'), 'arxiv:2404.18021')
  assert.equal(toCanonicalArxiv('2404.18021'), 'arxiv:2404.18021')
  assert.equal(toCanonicalArxiv('hep-th/9901001'), 'arxiv:hep-th/9901001')
})

test('toCanonicalUrl: doi.org / arxiv.org collapse, generic lowercased', () => {
  assert.equal(toCanonicalUrl('https://doi.org/10.1234/X'), 'doi:10.1234/x')
  assert.equal(toCanonicalUrl('https://arxiv.org/abs/2404.18021v3'), 'arxiv:2404.18021')
  assert.equal(toCanonicalUrl('https://arxiv.org/pdf/2404.18021'), 'arxiv:2404.18021')
  assert.equal(toCanonicalUrl('https://Example.com/Path/#frag'), 'url:https://example.com/path')
  assert.equal(toCanonicalUrl('ftp://nope'), null)
})

// ── extraction ───────────────────────────────────────────────────────────────

const canon = (cs: ExtractedCitation[]) => cs.map(c => c.canonical).sort()

test('extractCitations: finds DOI / arXiv / URL across surface forms', () => {
  const text = [
    'See [1] doi:10.1000/abc and arXiv:2404.18021v2.',
    'Also https://doi.org/10.1000/abc (duplicate of [1]),',
    'and https://example.org/paper, and https://arxiv.org/abs/2404.18021.'
  ].join('\n')
  const got = canon(extractCitations(text))
  // doi.org URL + bare doi dedupe to one; arxiv URL + bare arxiv dedupe to one
  assert.deepEqual(got, ['arxiv:2404.18021', 'doi:10.1000/abc', 'url:https://example.org/paper'])
})

test('extractCitations: empty / citation-free text yields nothing', () => {
  assert.deepEqual(extractCitations(''), [])
  assert.deepEqual(extractCitations('plain prose with no references at all'), [])
})

test('extractCitations: a doi.org URL is not double-counted as a plain url', () => {
  const got = canon(extractCitations('grounded in https://doi.org/10.5555/xyz here'))
  assert.deepEqual(got, ['doi:10.5555/xyz'])
})

// ── resolution ───────────────────────────────────────────────────────────────

test('resolveCitations: counts resolved vs unresolved against retrieved set', () => {
  const cites = extractCitations('uses 10.1000/a, 10.2000/b, and https://x.com/p')
  const retrieved = new Set(['doi:10.1000/a', 'url:https://x.com/p'])
  const res = resolveCitations(cites, retrieved)
  assert.equal(res.total, 3)
  assert.equal(res.resolved, 2)
  assert.equal(res.rate, 2 / 3)
  assert.deepEqual(res.unresolved, ['doi:10.2000/b'])
})

test('resolveCitations: cross-form match — cited as URL, retrieved as DOI', () => {
  const cites = extractCitations('cited as https://doi.org/10.9999/z')
  const retrieved = new Set(['doi:10.9999/z']) // e.g. a fetch-fulltext arg
  const res = resolveCitations(cites, retrieved)
  assert.equal(res.resolved, 1)
  assert.equal(res.rate, 1)
  assert.deepEqual(res.unresolved, [])
})

test('resolveCitations: no citations → rate is null (no signal, not 0)', () => {
  const res = resolveCitations([], new Set())
  assert.equal(res.total, 0)
  assert.equal(res.resolved, 0)
  assert.equal(res.rate, null)
})

test('resolveCitations: unresolved list is capped but counts stay exact', () => {
  const cites = Array.from({ length: 40 }, (_, i) => ({
    kind: 'doi' as const, raw: `10.1/${i}`, canonical: `doi:10.1/${i}`
  }))
  const res = resolveCitations(cites, new Set(), { maxUnresolved: 5 })
  assert.equal(res.total, 40)
  assert.equal(res.resolved, 0)
  assert.equal(res.unresolved.length, 5)
})
