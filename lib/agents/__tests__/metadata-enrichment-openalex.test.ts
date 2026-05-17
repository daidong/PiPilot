/**
 * Tests for the OpenAlex enrichment adapter.
 *
 * Two layers:
 *  - `reconstructOpenAlexAbstract`: pure function, tested directly.
 *  - `enrichPapers` end-to-end with a mocked `fetch`: exercises the full
 *    CrossRef → OpenAlex → Semantic Scholar fallback chain and the
 *    inverted-index → plain-text round trip via the real `enrichByDOI`
 *    code path. This is the integration story we actually want to pin —
 *    "BibTeX paper with no abstract gets one back from OpenAlex when
 *    CrossRef doesn't have one."
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enrichPapers,
  createEnrichmentConfig,
  reconstructOpenAlexAbstract,
  type PaperInput,
} from '../metadata-enrichment.js'
import { RateLimiter, CircuitBreaker } from '../rate-limiter.js'

// ─── Test plumbing ────────────────────────────────────────────────────────

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = impl
  return fn().finally(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = orig
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeConfig() {
  const rateLimiter = new RateLimiter({
    crossref: { requestsPerMinute: 1000, concurrency: 5 },
    openalex: { requestsPerMinute: 1000, concurrency: 5 },
    semantic_scholar: { requestsPerMinute: 1000, concurrency: 5 },
    dblp: { requestsPerMinute: 1000, concurrency: 5 },
  })
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeMs: 60_000,
  })
  const config = createEnrichmentConfig(rateLimiter, circuitBreaker, {
    crossrefMailto: 'test@example.com',
  })
  // Loosen budgets so tests don't trip on slow CI.
  config.maxTimeMs = 60_000
  config.maxPapersToEnrich = 50
  return config
}

// ─── reconstructOpenAlexAbstract ──────────────────────────────────────────

test('reconstructOpenAlexAbstract: single word per position → ordered join', () => {
  const index = {
    Hello: [0],
    world: [1],
    today: [2],
  }
  assert.equal(reconstructOpenAlexAbstract(index), 'Hello world today')
})

test('reconstructOpenAlexAbstract: word with multiple positions → repeats', () => {
  // "the cat saw the dog" — 'the' appears at positions 0 and 3
  const index = {
    the: [0, 3],
    cat: [1],
    saw: [2],
    dog: [4],
  }
  assert.equal(reconstructOpenAlexAbstract(index), 'the cat saw the dog')
})

test('reconstructOpenAlexAbstract: undefined / null → undefined', () => {
  assert.equal(reconstructOpenAlexAbstract(undefined), undefined)
  assert.equal(reconstructOpenAlexAbstract(null), undefined)
})

test('reconstructOpenAlexAbstract: empty index → undefined', () => {
  assert.equal(reconstructOpenAlexAbstract({}), undefined)
})

test('reconstructOpenAlexAbstract: ignores malformed positions', () => {
  // String positions get filtered; only the real numeric one survives.
  const index = {
    valid: [0],
    bogus: ['not-a-number' as unknown as number],
  }
  assert.equal(reconstructOpenAlexAbstract(index), 'valid')
})

// ─── End-to-end: OpenAlex fills the abstract gap CrossRef leaves ──────────

test('enrichByDOI: CrossRef returns no abstract, OpenAlex fills it in', async () => {
  const calls: string[] = []
  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    calls.push(url)

    if (url.includes('api.crossref.org/works/10.1145%2F3442381.3450085')) {
      return jsonResponse({
        message: {
          title: ['An Investigation of Identity-Account Inconsistency in SSO'],
          author: [{ given: 'Guannan', family: 'Liu' }],
          'container-title': ['The Web Conference (WWW)'],
          'published': { 'date-parts': [[2021]] },
          'is-referenced-by-count': 42,
          // No abstract field — this is the gap OpenAlex needs to fill.
        },
      })
    }

    if (url.includes('api.openalex.org/works/doi:10.1145%2F3442381.3450085')) {
      return jsonResponse({
        title: 'An Investigation of Identity-Account Inconsistency in SSO',
        publication_year: 2021,
        cited_by_count: 42,
        doi: 'https://doi.org/10.1145/3442381.3450085',
        primary_location: {
          source: { display_name: 'The Web Conference (WWW)' },
          landing_page_url: 'https://dl.acm.org/doi/10.1145/3442381.3450085',
        },
        authorships: [
          { author: { display_name: 'Guannan Liu' } },
          { author: { display_name: 'Xing Gao' } },
        ],
        abstract_inverted_index: {
          We: [0],
          investigate: [1],
          identity: [2],
          inconsistency: [3],
          in: [4],
          SSO: [5],
        },
      })
    }

    // Catch-all: 404 anything else so the fallback can short-circuit.
    return new Response('not found', { status: 404 })
  }

  const paper: PaperInput = {
    title: 'An Investigation of Identity-Account Inconsistency in SSO',
    authors: ['Guannan Liu'],
    year: 2021,
    venue: 'The Web Conference (WWW)',
    doi: '10.1145/3442381.3450085',
    abstract: '',
    source: 'bibtex-import',
  }

  await withMockFetch(mockFetch, async () => {
    const stats = await enrichPapers([paper], makeConfig())
    assert.equal(stats.enriched, 1)
  })

  assert.equal(
    paper.abstract,
    'We investigate identity inconsistency in SSO',
    'OpenAlex should fill in the abstract CrossRef left empty',
  )
  assert.equal(
    (paper as { enrichmentSource?: string }).enrichmentSource,
    'openalex',
    'enrichmentSource should track the LAST source that contributed data',
  )
  assert.ok(
    (paper as { enrichedAt?: string }).enrichedAt,
    'enrichedAt should be stamped once any source returns',
  )

  // CrossRef + OpenAlex were consulted; SS was skipped because the paper
  // hit 7/7 core fields after OpenAlex.
  const hitCrossref = calls.some(u => u.includes('api.crossref.org'))
  const hitOpenAlex = calls.some(u => u.includes('api.openalex.org'))
  const hitSS = calls.some(u => u.includes('api.semanticscholar.org'))
  assert.ok(hitCrossref, 'CrossRef should be consulted first')
  assert.ok(hitOpenAlex, 'OpenAlex should be consulted as the second hop')
  assert.ok(!hitSS, 'Semantic Scholar should be skipped once 7/7 fields are filled')
})

test('enrichByDOI: OpenAlex sends polite mailto in query string when configured', async () => {
  let observedOpenAlexUrl = ''
  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('api.openalex.org')) {
      observedOpenAlexUrl = url
      return jsonResponse({
        title: 'X',
        publication_year: 2020,
        doi: 'https://doi.org/10.1/x',
        abstract_inverted_index: { hi: [0] },
      })
    }
    if (url.includes('api.crossref.org')) {
      return jsonResponse({ message: { title: ['X'] } })  // bare, forces fallback
    }
    return new Response('not found', { status: 404 })
  }

  const paper: PaperInput = {
    title: 'X',
    doi: '10.1/x',
    abstract: '',
  }

  await withMockFetch(mockFetch, async () => {
    await enrichPapers([paper], makeConfig())
  })

  assert.match(
    observedOpenAlexUrl,
    /mailto=test%40example\.com/,
    'OpenAlex requests should carry the polite mailto query param',
  )
})

test('enrichByDOI: OpenAlex HTTP error opens its circuit but CrossRef result still applies', async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('api.crossref.org')) {
      return jsonResponse({
        message: {
          title: ['Paper'],
          author: [{ given: 'A', family: 'Author' }],
          'container-title': ['Venue'],
          published: { 'date-parts': [[2020]] },
          'is-referenced-by-count': 1,
          abstract: 'CR abstract',
        },
      })
    }
    if (url.includes('api.openalex.org')) {
      return new Response('upstream error', { status: 503 })
    }
    return new Response('not found', { status: 404 })
  }

  const paper: PaperInput = {
    title: 'Paper',
    doi: '10.1/foo',
    abstract: '',
  }

  await withMockFetch(mockFetch, async () => {
    await enrichPapers([paper], makeConfig())
  })

  assert.equal(paper.abstract, 'CR abstract', 'CrossRef result should still land')
})
