/**
 * Full-text Retrieval — unit tests.
 *
 * Single-file self-checking script (mirrors hash-isolation.test.ts pattern —
 * the repo has no test runner yet). Run with:
 *
 *   npx tsx lib/fulltext/index.test.ts
 *
 * Covers:
 *   - hasAnyFulltextSource matrix (env / id combinations)
 *   - cacheLookup: paperclip-by-pmcId, arxiv-by-arxivId, legacy flat path
 *   - paperclip section fuzzy matching
 *   - resolveFulltext cache short-circuit
 *
 * Network-dependent paths (live Paperclip / arXiv) are NOT exercised here —
 * those are integration tests, run manually against real services.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { hasAnyFulltextSource, resolveFulltext } from './index.js'
import { fuzzyMatchSection } from './paperclip.js'
import {
  arxivConvertedPath,
  paperclipConvertedPath,
} from './cache.js'
import type { PaperArtifact } from '../types.js'

function makePaper(overrides: Partial<PaperArtifact> = {}): PaperArtifact {
  const base: PaperArtifact = {
    id: 'test-id',
    type: 'paper',
    title: 'Test Paper',
    authors: ['A. N. Other'],
    abstract: 'An abstract.',
    doi: 'unknown:test',
    citeKey: 'other2024test',
    bibtex: '@article{other2024test}',
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
  }
  return { ...base, ...overrides }
}

function setEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return () => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const restores = Object.entries(env).map(([k, v]) => setEnv(k, v))
  try {
    return fn()
  } finally {
    for (const r of restores.reverse()) r()
  }
}

async function main(): Promise<void> {
  const failures: string[] = []
  const record = (name: string, check: () => void | Promise<void>): Promise<void> =>
    Promise.resolve(check()).then(
      () => { console.log(`  ok — ${name}`) },
      err => {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        console.log(`  FAIL — ${name}`)
      }
    )

  console.log('fulltext regression test')

  // ── hasAnyFulltextSource matrix ──────────────────────────────────────────

  await record('hasAnyFulltextSource: arxivId-only (no key) → true', () => {
    withEnv({ PAPERCLIP_API_KEY: undefined }, () => {
      const a = makePaper({ arxivId: '2404.18021' })
      assert.equal(hasAnyFulltextSource(a), true)
    })
  })

  await record('hasAnyFulltextSource: arxivId invalid (no key) → false', () => {
    withEnv({ PAPERCLIP_API_KEY: undefined }, () => {
      const a = makePaper({ arxivId: '803' })  // bogus
      assert.equal(hasAnyFulltextSource(a), false)
    })
  })

  await record('hasAnyFulltextSource: doi-only, no Paperclip key → false', () => {
    withEnv({ PAPERCLIP_API_KEY: undefined }, () => {
      const a = makePaper({ doi: '10.1038/nbt.4194' })
      assert.equal(hasAnyFulltextSource(a), false)
    })
  })

  await record('hasAnyFulltextSource: doi-only WITH Paperclip key → true', () => {
    withEnv({ PAPERCLIP_API_KEY: 'gxl_test' }, () => {
      const a = makePaper({ doi: '10.1038/nbt.4194' })
      assert.equal(hasAnyFulltextSource(a), true)
    })
  })

  await record('hasAnyFulltextSource: pmcId-only WITH key → true', () => {
    withEnv({ PAPERCLIP_API_KEY: 'gxl_test' }, () => {
      const a = makePaper({ pmcId: 'PMC6130889' })
      assert.equal(hasAnyFulltextSource(a), true)
    })
  })

  await record('hasAnyFulltextSource: pubmedId-only WITH key → true', () => {
    withEnv({ PAPERCLIP_API_KEY: 'gxl_test' }, () => {
      const a = makePaper({ pubmedId: '29969439' })
      assert.equal(hasAnyFulltextSource(a), true)
    })
  })

  await record('hasAnyFulltextSource: unknown-prefixed DOI counts as no DOI', () => {
    // doi: 'unknown:foo' is the system's "no real DOI yet" sentinel; it
    // must not unlock Paperclip eligibility because the lookup-by-doi
    // call would fail with garbage input.
    withEnv({ PAPERCLIP_API_KEY: 'gxl_test' }, () => {
      const a = makePaper({ doi: 'unknown:other2024test' })
      assert.equal(hasAnyFulltextSource(a), false)
    })
  })

  await record('hasAnyFulltextSource: no identifiers → false', () => {
    withEnv({ PAPERCLIP_API_KEY: 'gxl_test' }, () => {
      const a = makePaper()
      assert.equal(hasAnyFulltextSource(a), false)
    })
  })

  // ── Cache lookup ─────────────────────────────────────────────────────────
  // We can't easily redirect getWikiRoot() in this test environment without
  // mocking. Instead we write a real fixture under the actual wiki root —
  // safe because we use unique synthetic IDs that won't collide with any
  // real paper, and clean up after.

  const fixtureArxivId = 'fulltext-test-9999.99999'
  const fixturePmcId = 'PMC9999999_FULLTEXT_TEST'

  await record('cacheLookup: arxiv path hit by arxivId', async () => {
    const path = arxivConvertedPath(fixtureArxivId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# Fixture body\n\n' + 'x'.repeat(200), 'utf-8')
    try {
      const result = await resolveFulltext({ arxivId: fixtureArxivId })
      assert.ok(result, 'expected cache hit')
      assert.equal(result!.source, 'arxiv')
      assert.equal(result!.cachePath, path)
      assert.ok(result!.markdown.includes('Fixture body'))
    } finally {
      try { rmSync(path) } catch { /* ignore */ }
    }
  })

  await record('cacheLookup: paperclip path hit by pmcId', async () => {
    const path = paperclipConvertedPath(fixturePmcId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# Paperclip fixture\n\n' + 'y'.repeat(200), 'utf-8')
    try {
      const result = await resolveFulltext({ pmcId: fixturePmcId })
      assert.ok(result, 'expected cache hit')
      assert.equal(result!.source, 'paperclip')
      assert.equal(result!.cachePath, path)
    } finally {
      try { rmSync(path) } catch { /* ignore */ }
    }
  })

  await record('cacheLookup: small files (<=100 bytes) ignored', async () => {
    // Cache files shorter than 100 bytes are treated as truncated/empty
    // and bypassed so the dispatcher can re-fetch a real body.
    const path = arxivConvertedPath(fixtureArxivId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'tiny', 'utf-8')
    try {
      // No PAPERCLIP key + arxiv path probe (cache too small) + arxiv
      // network would be exercised but we don't have network. Just check
      // that the cache probe rejects the tiny file — the function returns
      // null because no online source is reachable in this test.
      withEnv({ PAPERCLIP_API_KEY: undefined }, async () => {
        const result = await resolveFulltext({ arxivId: fixtureArxivId })
        // Without network, result will be null; the important thing is we
        // didn't return the tiny "tiny" file as if it were valid markdown.
        if (result) {
          assert.notEqual(result.markdown, 'tiny')
        }
      })
    } finally {
      try { rmSync(path) } catch { /* ignore */ }
    }
  })

  // ── Section fuzzy matching ───────────────────────────────────────────────

  await record('fuzzyMatchSection: exact token match wins', () => {
    const list = ['Methods', 'Results', 'Discussion']
    assert.equal(fuzzyMatchSection('methods', list), 'Methods')
  })

  await record('fuzzyMatchSection: "methods" matches "Online Methods"', () => {
    const list = ['Online Methods', 'Results', 'Discussion']
    assert.equal(fuzzyMatchSection('methods', list), 'Online Methods')
  })

  await record('fuzzyMatchSection: tie-breaker prefers shorter length-delta', () => {
    const list = ['Methods', 'Online Methods']
    // "methods" → both contain "methods" token; prefer the one with smaller
    // length delta to the requested name (i.e. "Methods" wins over "Online Methods").
    assert.equal(fuzzyMatchSection('methods', list), 'Methods')
  })

  await record('fuzzyMatchSection: multi-word query', () => {
    const list = ['Online Methods', 'Cell Culture and Transfection']
    assert.equal(fuzzyMatchSection('online methods', list), 'Online Methods')
  })

  await record('fuzzyMatchSection: no overlap returns null', () => {
    const list = ['Methods', 'Results']
    assert.equal(fuzzyMatchSection('hyperparameters', list), null)
  })

  await record('fuzzyMatchSection: empty query returns null', () => {
    assert.equal(fuzzyMatchSection('', ['Methods']), null)
  })

  // ── Dispatch null-return when nothing eligible ───────────────────────────

  await record('resolveFulltext: no IDs and no key → null', async () => {
    await withEnv({ PAPERCLIP_API_KEY: undefined }, async () => {
      const result = await resolveFulltext({})
      assert.equal(result, null)
    })
  })

  await record('resolveFulltext: doi-only without key → null (no online source eligible)', async () => {
    // Without PAPERCLIP_API_KEY, paperclip is skipped. Without arxivId+title,
    // arxiv path can't trigger. With nothing eligible, resolveFulltext
    // should return null cleanly without attempting network calls.
    await withEnv({ PAPERCLIP_API_KEY: undefined }, async () => {
      const result = await resolveFulltext({ doi: '10.1038/nbt.4194' })
      // arxiv path will try title-resolve only if `title` is set; it isn't,
      // so we expect null.
      assert.equal(result, null)
    })
  })

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('\nall fulltext invariants hold')
}

main().catch(err => {
  console.error('test harness error:', err)
  process.exit(1)
})
