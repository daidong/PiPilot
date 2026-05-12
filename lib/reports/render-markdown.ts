/**
 * Render the Paper Pack Report as Markdown (RFC-007 PR-B).
 *
 * Assembles all the upstream pieces — deterministic aggregations,
 * the LLM synthesis, the onboarding ranker — into the final
 * `rp-paper-pack-report.md` document at the project root.
 *
 * Layout follows RFC-007 §6: at-a-glance, themes, methods+datasets,
 * gaps, onboarding, talking points, appendix.
 *
 * Citation syntax: `[citeKey]` becomes a Markdown link to the appendix
 * anchor on the same page: `[citeKey](#cite-citekey)`. Standard
 * markdown renderers (VS Code, GitHub, Obsidian) handle this natively.
 */

import type {
  ReportInput,
  AggregateSummary,
  SynthesisOutput,
  OnboardingPath,
} from './types.js'

export function renderMarkdown(
  input: ReportInput,
  agg: AggregateSummary,
  synthesis: SynthesisOutput,
  ranking: OnboardingPath
): string {
  const lines: string[] = []
  const fmtDate = new Date(input.capturedAt).toISOString().slice(0, 10)

  // ── Header ──────────────────────────────────────────────────
  lines.push(`# Paper Pack Report — ${input.projectName}`)
  lines.push('')
  lines.push(
    [
      `Generated ${fmtDate}`,
      `${agg.totalPapers} papers`,
      agg.fulltextCount > 0 || agg.abstractOnlyCount > 0
        ? `${agg.fulltextCount} full-text / ${agg.abstractOnlyCount} abstract-only`
        : null,
      agg.earliestYear !== null && agg.latestYear !== null
        ? `span ${agg.earliestYear}–${agg.latestYear}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
  )
  lines.push('')

  // ── §1: At a glance ─────────────────────────────────────────
  lines.push('## 1. At a glance')
  lines.push('')
  if (agg.yearDistribution.length > 0) {
    lines.push('Papers per year:')
    lines.push('')
    lines.push('```')
    for (const yb of agg.yearDistribution) {
      const bar = '█'.repeat(Math.min(yb.count, 40))
      lines.push(`${yb.year}  ${bar} ${yb.count}`)
    }
    lines.push('```')
    lines.push('')
  }
  if (agg.topCited.length > 0) {
    lines.push('**Most cited in this pack:**')
    lines.push('')
    for (const tc of agg.topCited) {
      const authors = formatAuthorsShort(tc.authors)
      const year = tc.year != null ? `, ${tc.year}` : ''
      lines.push(`- [${tc.citeKey}](#cite-${tc.citeKey}) — *${tc.title}* (${authors}${year}) — ${tc.citationCount} citations`)
    }
    lines.push('')
  } else {
    lines.push('_No citation counts available yet — enrichment may still be running._')
    lines.push('')
  }

  // ── §2: Thematic landscape ──────────────────────────────────
  lines.push('## 2. Thematic landscape')
  lines.push('')
  if (synthesis.themes.length === 0) {
    lines.push('_No thematic synthesis available. The model output failed to parse, or no theme could be reliably extracted with citations. The pack still contains the deterministic sections below._')
    lines.push('')
  } else {
    for (const theme of synthesis.themes) {
      lines.push(`### ${theme.name} (${theme.papers.length} papers)`)
      lines.push('')
      lines.push(linkifyCiteKeys(theme.synthesis))
      lines.push('')
      if (theme.papers.length > 0) {
        const list = theme.papers
          .map((k) => `[${k}](#cite-${k})`)
          .join(', ')
        lines.push(`_Papers: ${list}_`)
        lines.push('')
      }
    }
  }

  // ── §3: Methods & datasets ──────────────────────────────────
  lines.push('## 3. Methods & datasets')
  lines.push('')
  if (agg.methods.length > 0) {
    lines.push('**Methods (terms appearing in 2+ papers):**')
    lines.push('')
    for (const m of agg.methods) {
      const refs = m.citeKeys.map((k) => `[${k}](#cite-${k})`).join(', ')
      lines.push(`- **${m.term}** — ${m.count} papers — ${refs}`)
    }
    lines.push('')
  } else {
    lines.push('_No recurring methods detected._')
    lines.push('')
  }
  if (agg.datasets.length > 0) {
    lines.push('**Datasets:**')
    lines.push('')
    for (const d of agg.datasets) {
      const refs = d.citeKeys.map((k) => `[${k}](#cite-${k})`).join(', ')
      lines.push(`- **${d.term}** — ${d.count} papers — ${refs}`)
    }
    lines.push('')
  } else {
    lines.push('_No recurring datasets detected._')
    lines.push('')
  }

  // ── §4: Open questions / what's missing ─────────────────────
  lines.push('## 4. Open questions & limitations')
  lines.push('')
  if (agg.limitations.length === 0 && agg.negativeResults.length === 0) {
    lines.push('_No limitations or negative results captured in this pack yet._')
    lines.push('')
  } else {
    if (agg.limitations.length > 0) {
      lines.push('**Limitations papers themselves call out:**')
      lines.push('')
      for (const l of agg.limitations.slice(0, 15)) {
        lines.push(`- [${l.citeKey}](#cite-${l.citeKey}): ${l.text}`)
      }
      if (agg.limitations.length > 15) {
        lines.push(`- _… and ${agg.limitations.length - 15} more (see per-paper appendix)_`)
      }
      lines.push('')
    }
    if (agg.negativeResults.length > 0) {
      lines.push('**Negative results worth knowing:**')
      lines.push('')
      for (const n of agg.negativeResults.slice(0, 10)) {
        lines.push(`- [${n.citeKey}](#cite-${n.citeKey}): ${n.text}`)
      }
      lines.push('')
    }
  }

  // ── §5: Onboarding path ─────────────────────────────────────
  lines.push('## 5. Onboarding path')
  lines.push('')
  if (ranking.entries.length === 0) {
    lines.push('_No clear reading order — the pack lacks signal for ranking (no citation counts, no surveys)._')
    lines.push('')
  } else {
    lines.push('Suggested reading order for a new lab member:')
    lines.push('')
    for (let i = 0; i < ranking.entries.length; i++) {
      const e = ranking.entries[i]
      const flag = e.scoreComponents.isSurvey ? ' _(survey)_' : ''
      lines.push(`${i + 1}. [${e.citeKey}](#cite-${e.citeKey}) — *${e.title}*${flag}`)
      lines.push(`   ${e.oneLineWhy}`)
    }
    lines.push('')
  }

  // ── §6: Lab meeting talking points ──────────────────────────
  lines.push('## 6. Lab meeting talking points')
  lines.push('')
  if (synthesis.talkingPoints.length === 0) {
    lines.push('_No talking points surfaced this run._')
    lines.push('')
  } else {
    for (const tp of synthesis.talkingPoints) {
      lines.push(`- ${linkifyCiteKeys(tp.point)}`)
    }
    lines.push('')
  }

  // ── Appendix ────────────────────────────────────────────────
  lines.push('## Appendix: per-paper one-liners')
  lines.push('')
  for (const entry of input.papers) {
    const p = entry.paper
    if (!p.citeKey) continue
    const tier = entry.wiki?.source_tier === 'fulltext'
      ? ''
      : ' _[abstract only]_'
    const authors = formatAuthorsShort(p.authors)
    const year = p.year != null ? `, ${p.year}` : ''
    const venue = p.venue ? ` · ${p.venue}` : ''
    lines.push(`### <a id="cite-${p.citeKey}"></a>${p.citeKey}${tier}`)
    lines.push('')
    lines.push(`**${p.title}** — ${authors}${year}${venue}`)
    lines.push('')
    const oneLine = entry.wiki?.tldr || firstSentence(p.abstract) || '_No summary available._'
    lines.push(oneLine)
    lines.push('')
    if (p.doi && !p.doi.startsWith('unknown:')) {
      lines.push(`DOI: [${p.doi}](https://doi.org/${p.doi})`)
      lines.push('')
    } else if (p.url) {
      lines.push(`URL: ${p.url}`)
      lines.push('')
    }
  }

  // ── Footer ──────────────────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push(`_Generated by PiPilot from the Paper Wiki extraction of this project. ${agg.abstractOnlyCount} of ${agg.totalPapers} papers were synthesized from abstracts only; the rest from full text._`)

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const CITE_INLINE_RE = /\[([a-zA-Z][a-zA-Z0-9_:\-]*(?:\s*,\s*[a-zA-Z][a-zA-Z0-9_:\-]*)*)\]/g

/**
 * Convert `[citeKey]` and `[citeKey1, citeKey2]` inline references
 * into anchor-linked markdown.
 */
function linkifyCiteKeys(text: string): string {
  return text.replace(CITE_INLINE_RE, (_, inside: string) => {
    const keys = inside.split(',').map((s) => s.trim()).filter(Boolean)
    if (keys.length === 0) return ''
    return keys.map((k) => `[${k}](#cite-${k})`).join(', ')
  })
}

function formatAuthorsShort(authors: string[]): string {
  if (!authors || authors.length === 0) return 'Unknown'
  if (authors.length === 1) return authors[0]
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`
  return `${authors[0]} et al.`
}

function firstSentence(s: string | undefined): string | null {
  if (!s) return null
  const trimmed = s.trim()
  if (!trimmed) return null
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0]
  return sentence.length > 0 ? sentence : trimmed.slice(0, 200)
}
