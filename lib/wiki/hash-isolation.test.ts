/**
 * Hash-isolation regression test — hotfix guardrail for the cross-project
 * wiki reprocess bug.
 *
 * Invariants under test:
 *
 *   A. V2 content hash ignores lens fields
 *      Two PaperArtifacts that differ ONLY in per-project lens fields
 *      (relevanceJustification, subTopic, keyFindings) must produce
 *        1. identical computeSemanticHash() output, and
 *        2. identical buildPaperUserContent() output
 *      because the wiki's shared page body and content watermark should
 *      care about canonical paper data, not about how any particular
 *      project describes its relevance.
 *
 *   B. V1 legacy hash is preserved exactly
 *      computeSemanticHashV1 is a frozen copy of the pre-hotfix projection
 *      and must continue to differentiate artifacts by lens fields. It is
 *      ONLY used by the scanner's migration predicate; anything else must
 *      use the V2 function.
 *
 *   C. Migration predicate never swallows real canonical changes
 *      canSilentRestampLegacyWatermark must return false whenever the
 *      stored V1 hash does not match what V1 would compute from the
 *      current artifact. This is the guard that keeps the
 *      "paper changed → reprocess" invariant alive across the
 *      HASH_SCHEMA_VERSION bump.
 *
 * Background: before the hotfix, lens fields leaked into both the hash
 * projection and the page-body LLM prompt. When two projects saved the
 * same paper with different justifications, the scanner would treat that
 * as a semantic-change and reprocess the page, and the regenerated body
 * would read as if written from the most-recent project's point of view.
 * See the hotfix commit message and RFC-005 §4 for the layering rationale.
 *
 * This is a single-file self-checking script, not wired to any test
 * runner — the repo has no test infra yet (that's follow-up work).
 *
 * How to run (verified working):
 *
 *     npx tsx lib/wiki/hash-isolation.test.ts
 *
 * Note: `node --experimental-strip-types` does NOT work for this file.
 * Node's built-in TS stripping does not remap `./types.js` imports to the
 * `.ts` source the way tsx does, so module resolution fails. If/when a
 * proper test runner (vitest) lands, wire this file into it and drop the
 * inline assert + main() pattern.
 *
 * Exits 0 on success, nonzero on failure. Keep the file typechecked under
 * the project's tsc config so regressions in the signatures surface even
 * when nobody runs the script.
 */

import { strict as assert } from 'node:assert'
import type { PaperArtifact } from '../types.js'
import {
  HASH_SCHEMA_VERSION,
  computeSemanticHash,
  computeSemanticHashV1,
  canSilentRestampLegacyWatermark,
  type ProcessedEntry,
} from './types.js'
import { buildPaperUserContent } from './generator.js'

function makePaper(overrides: Partial<PaperArtifact> = {}): PaperArtifact {
  const base: PaperArtifact = {
    id: 'test-id',
    type: 'paper',
    title: 'A Canonical Paper About Canonical Things',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    abstract: 'We study the canonical properties of canonical things.',
    year: 2024,
    venue: 'Journal of Canonicalization',
    doi: '10.1000/canonical.2024.001',
    citeKey: 'lovelace2024canonical',
    bibtex: '@article{lovelace2024canonical, ...}',
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    provenance: { source: 'user', sessionId: 'test-session', extractedFrom: 'user-input' },
  }
  return { ...base, ...overrides }
}

function main(): void {
  const failures: string[] = []
  const record = (name: string, check: () => void): void => {
    try {
      check()
      console.log(`  ok — ${name}`)
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      console.log(`  FAIL — ${name}`)
    }
  }

  console.log('hash-isolation regression test')

  const paperA = makePaper({
    id: 'paper-project-A',
    relevanceJustification: 'Critical to project A because it addresses X.',
    subTopic: 'sub-topic-A',
    keyFindings: ['A-finding-1', 'A-finding-2'],
  })

  const paperB = makePaper({
    id: 'paper-project-B',
    relevanceJustification: 'Tangential to project B but useful background.',
    subTopic: 'sub-topic-B',
    keyFindings: ['B-finding-1'],
  })

  const paperC = makePaper({
    id: 'paper-project-C',
    // No lens fields at all — represents a paper saved without
    // relevance context (e.g. imported from a plain bibliography).
  })

  record('computeSemanticHash ignores relevanceJustification', () => {
    assert.equal(
      computeSemanticHash(paperA),
      computeSemanticHash(paperB),
      'hash must be equal for artifacts that differ only in lens fields',
    )
  })

  record('computeSemanticHash ignores absence vs presence of lens fields', () => {
    assert.equal(
      computeSemanticHash(paperA),
      computeSemanticHash(paperC),
      'hash must be equal whether or not lens fields are set',
    )
  })

  record('computeSemanticHash still reacts to canonical content change', () => {
    const edited = makePaper({ title: 'A Completely Different Title' })
    assert.notEqual(
      computeSemanticHash(paperA),
      computeSemanticHash(edited),
      'hash must change when canonical content (title) changes',
    )
  })

  record('computeSemanticHash ignores fulltextPath', () => {
    // fulltextPath is a local cache pointer, not a generation input — the
    // page body only consumes the DOWNLOADED fulltext string, not this
    // field. Including it would create "hash changed but generation input
    // is identical" false positives.
    const withPath = makePaper({ fulltextPath: '/cache/paper.pdf' })
    const withoutPath = makePaper()
    assert.equal(
      computeSemanticHash(withPath),
      computeSemanticHash(withoutPath),
      'hash must be equal whether or not fulltextPath is set',
    )
  })

  record('buildPaperUserContent ignores lens fields', () => {
    const promptA = buildPaperUserContent(paperA, null, [])
    const promptB = buildPaperUserContent(paperB, null, [])
    assert.equal(
      promptA,
      promptB,
      'shared page body prompt must not change when lens fields change',
    )
  })

  record('buildPaperUserContent contains no lens phrases', () => {
    const prompt = buildPaperUserContent(paperA, null, [])
    // The lens values from paperA must not appear in the prompt at all.
    for (const needle of [
      'Critical to project A',
      'sub-topic-A',
      'A-finding-1',
      'Key Findings',
      'Relevance:',
      'Sub-topic:',
    ]) {
      assert.ok(
        !prompt.includes(needle),
        `prompt must not contain lens phrase "${needle}" — found:\n${prompt}`,
      )
    }
  })

  record('buildPaperUserContent still reflects canonical title change', () => {
    const edited = makePaper({ title: 'A Completely Different Title' })
    assert.notEqual(
      buildPaperUserContent(paperA, null, []),
      buildPaperUserContent(edited, null, []),
      'prompt must change when canonical title changes',
    )
  })

  // ── V1 legacy hash pinning ────────────────────────────────────────────
  // These tests make sure the frozen computeSemanticHashV1 keeps the
  // pre-hotfix behavior it is supposed to preserve. If someone "cleans
  // up" V1 to match V2 they break the migration guard.

  record('computeSemanticHashV1 DOES distinguish by lens fields', () => {
    assert.notEqual(
      computeSemanticHashV1(paperA),
      computeSemanticHashV1(paperB),
      'V1 hash must react to lens changes (that was the bug it embodied)',
    )
  })

  record('computeSemanticHashV1 differs from V2 on the same artifact', () => {
    // Different projections → different digests. Guards against someone
    // accidentally rewriting V1 to call the V2 function.
    assert.notEqual(
      computeSemanticHashV1(paperA),
      computeSemanticHash(paperA),
      'V1 and V2 hash functions must produce distinct digests',
    )
  })

  record('computeSemanticHashV1 is deterministic', () => {
    assert.equal(computeSemanticHashV1(paperA), computeSemanticHashV1(paperA))
  })

  // ── Migration predicate: canSilentRestampLegacyWatermark ──────────────
  // The guard that keeps canonical changes from being silently swallowed
  // during the V1→V2 watermark upgrade. See types.ts for the full
  // rationale. Each case here corresponds to a real scanner scenario.

  const makeWatermark = (overrides: Partial<ProcessedEntry> = {}): ProcessedEntry => ({
    canonicalKey: 'doi:10.1000/canonical.2024.001',
    slug: 'doi-10-1000-canonical-2024-001',
    semanticHash: 'placeholder',
    fulltextStatus: 'abstract-only',
    generatorVersion: 3,
    processedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  })

  record('migration predicate: V1 watermark, canonical unchanged → silent restamp', () => {
    // Stored hash is exactly what V1 would compute for the current artifact
    // → nothing changed → safe to silently upgrade the schema version.
    const watermark = makeWatermark({
      semanticHash: computeSemanticHashV1(paperA),
      // hashSchemaVersion omitted → treated as 1 (legacy)
    })
    assert.equal(canSilentRestampLegacyWatermark(watermark, paperA), true)
  })

  record('migration predicate: V1 watermark, canonical CHANGED → NOT silent', () => {
    // Stored hash corresponds to an older version of the artifact with a
    // different title. The scanner MUST fall through to the normal diff
    // path so the paper gets reprocessed. This is the invariant the
    // previous (unguarded) hotfix broke.
    const olderVersion = makePaper({ title: 'An Old Title Before The Edit' })
    const watermark = makeWatermark({
      semanticHash: computeSemanticHashV1(olderVersion),
    })
    const current = makePaper({ title: 'A New Title After The Edit' })
    assert.equal(
      canSilentRestampLegacyWatermark(watermark, current),
      false,
      'predicate must reject silent restamp when canonical content changed',
    )
  })

  record('migration predicate: V1 watermark, lens-only change → NOT silent (conservative)', () => {
    // We cannot tell a lens-only edit apart from a canonical edit once
    // the V1 projection hashes them together. The predicate correctly
    // rejects the silent restamp; the normal flow will reprocess once,
    // the new entry will be stamped V2, and the next scan will be clean.
    // This is the accepted small-cost tail from the hotfix design note.
    const olderLens = makePaper({ relevanceJustification: 'old justification text' })
    const watermark = makeWatermark({
      semanticHash: computeSemanticHashV1(olderLens),
    })
    const current = makePaper({ relevanceJustification: 'new justification text' })
    assert.equal(canSilentRestampLegacyWatermark(watermark, current), false)
  })

  record('migration predicate: V2 watermark → always false', () => {
    // Entry is already at current schema. The migration branch must not
    // touch it at all — normal hash comparison takes over.
    const watermark = makeWatermark({
      semanticHash: computeSemanticHash(paperA),
      hashSchemaVersion: HASH_SCHEMA_VERSION,
    })
    assert.equal(canSilentRestampLegacyWatermark(watermark, paperA), false)
  })

  record('migration predicate: future schema → always false', () => {
    // Defensive: if some future code wrote an entry at a higher schema
    // version, the migration predicate must not downgrade it.
    const watermark = makeWatermark({
      semanticHash: computeSemanticHash(paperA),
      hashSchemaVersion: HASH_SCHEMA_VERSION + 5,
    })
    assert.equal(canSilentRestampLegacyWatermark(watermark, paperA), false)
  })

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('\nall invariants hold')
}

main()
