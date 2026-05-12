/**
 * Onboarding-path ranker (RFC-007 PR-B).
 *
 * Deterministic algorithm. No LLM. Outputs up to 5 papers in suggested
 * reading order for a new lab member.
 *
 * Scoring (each component normalized to [0, 1]):
 *   - isSurvey:           +0.5 if paper_type === 'review' (surveys go first)
 *   - citationCountNorm:  +0.3 × (citationCount / max(citationCount))
 *   - conceptCentrality:  +0.2 × (incoming_concept_edges / max(incoming))
 *
 * Concept centrality is computed by counting how many other papers in
 * the pack point at this paper's concepts via concept_edges. A paper
 * that introduces concepts many others use is foundational.
 *
 * No LLM here keeps the ranker debuggable: a user can mentally
 * reconstruct why paper X ranked above paper Y by reading
 * `scoreComponents`. If we'd used an LLM, "the LLM said so" is the
 * only explanation we could offer.
 */

import type {
  ReportInput,
  OnboardingPaperEntry,
  OnboardingPath,
} from './types.js'

const MAX_ENTRIES = 5

interface ScoredEntry {
  citeKey: string
  title: string
  oneLineWhy: string
  isSurvey: boolean
  citationCount: number
  conceptCentrality: number  // raw count, normalized later
  totalScore: number
}

export function rankOnboardingPath(input: ReportInput): OnboardingPath {
  const papers = input.papers.filter((e) => e.paper.citeKey)
  if (papers.length === 0) return { entries: [] }

  // ── Pass 1: compute concept centrality ──────────────────────────
  // For each paper, count how many OTHER papers in the pack reference
  // a concept that THIS paper claims (via `aliases` matching the other
  // paper's concept_edges.slug). That's a rough proxy for "this paper
  // is what others build on".
  //
  // We use the paper's own slug as a key — wiki concept_edges point at
  // concept slugs, not paper slugs, so this isn't a true citation graph
  // (the wiki doesn't materialize one), but it does capture conceptual
  // overlap. Honest in the report: it's "concept centrality" not
  // "citation centrality".
  const conceptCounts = new Map<string, number>()  // citeKey → incoming concept references
  // Collect concept slugs each paper uses:
  const conceptsUsedBy = new Map<string, Set<string>>()  // citeKey → set of concept slugs
  for (const entry of papers) {
    const citeKey = entry.paper.citeKey
    const used = new Set<string>()
    for (const edge of entry.wiki?.concept_edges ?? []) used.add(edge.slug)
    conceptsUsedBy.set(citeKey, used)
  }
  // For each (a, b) pair, if a's concepts overlap b's used-concepts,
  // bump a's centrality.
  for (const a of papers) {
    const aKey = a.paper.citeKey
    const aAliases = new Set(a.wiki?.aliases ?? [])
    if (aAliases.size === 0) continue
    let incoming = 0
    for (const b of papers) {
      if (b.paper.citeKey === aKey) continue
      const bUses = conceptsUsedBy.get(b.paper.citeKey)
      if (!bUses) continue
      // Concept-slug match: is any concept b uses an alias for a?
      for (const alias of aAliases) {
        if (bUses.has(alias)) { incoming++; break }
      }
    }
    conceptCounts.set(aKey, incoming)
  }

  // ── Pass 2: build candidate entries ─────────────────────────────
  const candidates: ScoredEntry[] = papers.map((entry) => {
    const { paper, wiki } = entry
    return {
      citeKey: paper.citeKey,
      title: paper.title,
      oneLineWhy: pickOneLineWhy(entry),
      isSurvey: wiki?.paper_type === 'review',
      citationCount: paper.citationCount ?? 0,
      conceptCentrality: conceptCounts.get(paper.citeKey) ?? 0,
      totalScore: 0,
    }
  })

  // ── Pass 3: normalize + score ──────────────────────────────────
  const maxCitations = Math.max(1, ...candidates.map((c) => c.citationCount))
  const maxConcept = Math.max(1, ...candidates.map((c) => c.conceptCentrality))
  for (const c of candidates) {
    const surveyPart = c.isSurvey ? 0.5 : 0
    const citationPart = 0.3 * (c.citationCount / maxCitations)
    const conceptPart = 0.2 * (c.conceptCentrality / maxConcept)
    c.totalScore = surveyPart + citationPart + conceptPart
  }

  // Sort: total score desc; tie-break on citationCount desc; then citeKey for stability.
  candidates.sort((a, b) =>
    b.totalScore - a.totalScore ||
    b.citationCount - a.citationCount ||
    a.citeKey.localeCompare(b.citeKey)
  )

  const entries: OnboardingPaperEntry[] = candidates.slice(0, MAX_ENTRIES).map((c) => ({
    citeKey: c.citeKey,
    title: c.title,
    oneLineWhy: c.oneLineWhy,
    scoreComponents: {
      isSurvey: c.isSurvey,
      citationCount: c.citationCount,
      conceptCentrality: c.conceptCentrality,
    },
  }))

  return { entries }
}

/**
 * Pick the most informative single-sentence description for a paper's
 * onboarding entry. Order of preference:
 *   1. wiki.tldr (already 1-2 sentences, written by wiki LLM)
 *   2. paper.abstract first sentence
 *   3. "<paper-type> paper" fallback
 *
 * The wiki tldr is the best source because it was generated with the
 * intent of "describe this paper in one breath" — exactly what we want.
 */
function pickOneLineWhy(entry: ReportInput['papers'][number]): string {
  const wiki = entry.wiki
  if (wiki?.tldr && wiki.tldr.trim().length > 0) {
    return wiki.tldr.trim()
  }
  const abs = entry.paper.abstract
  if (abs && abs.trim().length > 0) {
    // First sentence (rough split — handles "Dr." reasonably for our use).
    const firstSentence = abs.trim().split(/(?<=[.!?])\s+/)[0]
    return firstSentence.length > 0 ? firstSentence : abs.slice(0, 180)
  }
  if (wiki?.paper_type) {
    return `${wiki.paper_type[0].toUpperCase()}${wiki.paper_type.slice(1)} paper.`
  }
  return 'No summary available.'
}
