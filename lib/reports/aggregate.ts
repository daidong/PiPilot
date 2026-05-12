/**
 * Deterministic aggregations over the report's paper set (RFC-007 PR-B).
 *
 * Everything here is pure pipeline-free counting + sorting. No LLM, no
 * network. The intentional design choice: the LLM only synthesizes
 * themes + talking points; everything else is histograms + ranking
 * over the wiki sidecar data the wiki agent already produced.
 *
 * Why "deterministic >= LLM" here:
 *   - "Twelve papers use transformers [refs]" is just frequency
 *     aggregation over the `methods[]` field. An LLM call to rephrase
 *     that adds latency + cost + hallucination risk without adding
 *     information.
 *   - "Most-cited papers" is a sort over citationCount. Trivially correct.
 *   - "Year span 2018-2026" is min/max.
 *
 * The cost savings vs. my over-engineered initial proposal (~$0.40 →
 * ~$0.05 per report) come almost entirely from moving these
 * computations out of LLM calls.
 */

import type {
  ReportInput,
  AggregateSummary,
  HistogramEntry,
  TopCitedEntry,
  YearBucket,
} from './types.js'

// ─── Configurable knobs ──────────────────────────────────────────────────

const TOP_CITED_LIMIT = 5
const HISTOGRAM_TOP_LIMIT = 10  // surface top-10 methods / datasets only
/**
 * A method/dataset term needs at least this many papers backing it to
 * appear in the report — single-occurrence noise from the wiki LLM's
 * synonym variation isn't worth listing.
 */
const HISTOGRAM_MIN_COUNT = 2

// ─── Term normalization ──────────────────────────────────────────────────

/**
 * Normalize a method/dataset term for grouping. Aggressive enough to
 * coalesce "Transformer" and "transformers" (case + trailing -s), but
 * conservative — we keep punctuation and multi-word terms intact so
 * "BERT-base" doesn't merge with "BERT-large".
 */
function normalizeTerm(raw: string): string {
  let s = raw.trim().toLowerCase()
  // Strip plural-s suffix (transformers → transformer). Skip if the
  // term ends in "ss" (e.g. "loss") or is very short.
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  return s
}

/**
 * Display-form of a term — prefer the most common original casing
 * across the contributors. (e.g. if 11 papers wrote "Transformer" and
 * 1 wrote "transformer", show "Transformer".)
 */
function pickDisplayForm(originals: string[]): string {
  const counts = new Map<string, number>()
  for (const o of originals) counts.set(o, (counts.get(o) ?? 0) + 1)
  let best = originals[0] ?? ''
  let bestCount = 0
  for (const [form, c] of counts) {
    if (c > bestCount) { best = form; bestCount = c }
  }
  return best
}

// ─── Per-field aggregators ───────────────────────────────────────────────

interface RawHistogramAccum {
  /** key = normalized term, value = list of citeKeys + the original casing each paper used */
  buckets: Map<string, { citeKeys: string[]; originals: string[] }>
}

function emptyAccum(): RawHistogramAccum {
  return { buckets: new Map() }
}

function bumpAccum(acc: RawHistogramAccum, term: string, citeKey: string): void {
  if (!citeKey) return
  const norm = normalizeTerm(term)
  if (!norm) return
  let bucket = acc.buckets.get(norm)
  if (!bucket) {
    bucket = { citeKeys: [], originals: [] }
    acc.buckets.set(norm, bucket)
  }
  if (!bucket.citeKeys.includes(citeKey)) bucket.citeKeys.push(citeKey)
  bucket.originals.push(term)
}

function finalizeHistogram(acc: RawHistogramAccum): HistogramEntry[] {
  const entries: HistogramEntry[] = []
  for (const bucket of acc.buckets.values()) {
    if (bucket.citeKeys.length < HISTOGRAM_MIN_COUNT) continue
    entries.push({
      term: pickDisplayForm(bucket.originals),
      count: bucket.citeKeys.length,
      citeKeys: bucket.citeKeys.slice().sort(),
    })
  }
  // Descending by count, then alphabetic on display form for stable
  // output across runs (important for the cache hash).
  entries.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  return entries.slice(0, HISTOGRAM_TOP_LIMIT)
}

// ─── Top-level aggregation ───────────────────────────────────────────────

export function aggregateReport(input: ReportInput): AggregateSummary {
  const total = input.papers.length
  let fulltextCount = 0
  let abstractOnlyCount = 0
  let earliestYear: number | null = null
  let latestYear: number | null = null

  const yearCounts = new Map<number, number>()
  const topCitedCandidates: TopCitedEntry[] = []
  const methodsAcc = emptyAccum()
  const datasetsAcc = emptyAccum()
  const limitations: Array<{ citeKey: string; text: string }> = []
  const negativeResults: Array<{ citeKey: string; text: string }> = []

  for (const entry of input.papers) {
    const { paper, wiki } = entry
    const citeKey = paper.citeKey
    if (!citeKey) continue

    // Source-tier counts. Treat missing wiki as abstract-only — that's
    // what'll happen when the report is generated for a paper whose
    // wiki page hasn't been written yet (rare given the button gate).
    if (wiki?.source_tier === 'fulltext') fulltextCount++
    else abstractOnlyCount++

    // Year distribution.
    if (typeof paper.year === 'number') {
      yearCounts.set(paper.year, (yearCounts.get(paper.year) ?? 0) + 1)
      if (earliestYear === null || paper.year < earliestYear) earliestYear = paper.year
      if (latestYear === null || paper.year > latestYear) latestYear = paper.year
    }

    // Top-cited candidates.
    if (typeof paper.citationCount === 'number' && paper.citationCount > 0) {
      topCitedCandidates.push({
        citeKey,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        citationCount: paper.citationCount,
      })
    }

    // Methods histogram (from wiki sidecar; wiki.methods is a string[]).
    if (wiki?.methods) {
      for (const m of wiki.methods) bumpAccum(methodsAcc, m, citeKey)
    }

    // Datasets histogram. Datasets are objects with a `name` field;
    // we ignore role/alias for v1 (could split out "introduced" vs
    // "used" in a future iteration).
    if (wiki?.datasets) {
      for (const d of wiki.datasets) bumpAccum(datasetsAcc, d.name, citeKey)
    }

    if (wiki?.limitations) {
      for (const l of wiki.limitations) {
        if (l.text) limitations.push({ citeKey, text: l.text })
      }
    }
    if (wiki?.negative_results) {
      for (const n of wiki.negative_results) {
        if (n.text) negativeResults.push({ citeKey, text: n.text })
      }
    }
  }

  // Year distribution → sorted ascending.
  const yearDistribution: YearBucket[] = Array.from(yearCounts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year)

  // Top-cited → descending by count.
  topCitedCandidates.sort((a, b) => b.citationCount - a.citationCount || a.citeKey.localeCompare(b.citeKey))
  const topCited = topCitedCandidates.slice(0, TOP_CITED_LIMIT)

  return {
    totalPapers: total,
    fulltextCount,
    abstractOnlyCount,
    earliestYear,
    latestYear,
    yearDistribution,
    topCited,
    methods: finalizeHistogram(methodsAcc),
    datasets: finalizeHistogram(datasetsAcc),
    limitations,
    negativeResults,
  }
}
