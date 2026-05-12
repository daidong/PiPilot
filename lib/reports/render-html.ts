/**
 * Render the Paper Pack Report as standalone HTML (RFC-007 PR-B).
 *
 * Basic version. PR-C will add `<details>` wiki extraction, sticky
 * TOC sidebar with scrollspy, print styles, and an "abstract-only"
 * badge. Here we deliver:
 *   - Inlined CSS (no external assets)
 *   - Same six sections as markdown
 *   - `[citeKey]` becomes `<a href="#cite-citekey">[citeKey]</a>`
 *   - Appendix has `<article id="cite-citekey">` anchors with title,
 *     authors, year, venue, tldr, DOI link
 *
 * Zero JavaScript required for the core flow. The HTML works offline,
 * is sharable as a single file, and renders the same in every modern
 * browser.
 */

import type {
  ReportInput,
  AggregateSummary,
  SynthesisOutput,
  OnboardingPath,
} from './types.js'

export function renderHtml(
  input: ReportInput,
  agg: AggregateSummary,
  synthesis: SynthesisOutput,
  ranking: OnboardingPath
): string {
  const fmtDate = new Date(input.capturedAt).toISOString().slice(0, 10)
  const title = `Paper Pack Report — ${escapeHtml(input.projectName)}`

  const body: string[] = []
  body.push(`<header>`)
  body.push(`<h1>${escapeHtml(title)}</h1>`)
  body.push(
    `<p class="meta">${[
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
      .join(' · ')}</p>`
  )
  body.push(`</header>`)

  // ── §1: At a glance ─────────────────────────────────────────
  body.push(`<section id="at-a-glance">`)
  body.push(`<h2>1. At a glance</h2>`)
  if (agg.yearDistribution.length > 0) {
    body.push(`<table class="year-histogram"><tbody>`)
    const maxCount = Math.max(...agg.yearDistribution.map((y) => y.count), 1)
    for (const yb of agg.yearDistribution) {
      const width = Math.round((yb.count / maxCount) * 100)
      body.push(
        `<tr><td class="year">${yb.year}</td><td class="bar-cell"><div class="bar" style="width:${width}%"></div></td><td class="count">${yb.count}</td></tr>`
      )
    }
    body.push(`</tbody></table>`)
  }
  if (agg.topCited.length > 0) {
    body.push(`<h3>Most cited in this pack</h3>`)
    body.push(`<ul>`)
    for (const tc of agg.topCited) {
      body.push(
        `<li>${citeLink(tc.citeKey)} — <em>${escapeHtml(tc.title)}</em> (${escapeHtml(formatAuthorsShort(tc.authors))}${tc.year != null ? `, ${tc.year}` : ''}) — ${tc.citationCount} citations</li>`
      )
    }
    body.push(`</ul>`)
  }
  body.push(`</section>`)

  // ── §2: Themes ──────────────────────────────────────────────
  body.push(`<section id="themes">`)
  body.push(`<h2>2. Thematic landscape</h2>`)
  if (synthesis.themes.length === 0) {
    body.push(`<p class="empty">No thematic synthesis available. The deterministic sections below still apply.</p>`)
  } else {
    for (const theme of synthesis.themes) {
      body.push(`<article class="theme">`)
      body.push(`<h3>${escapeHtml(theme.name)} <span class="count">(${theme.papers.length} papers)</span></h3>`)
      body.push(`<p>${linkifyCiteKeysHtml(theme.synthesis)}</p>`)
      if (theme.papers.length > 0) {
        body.push(`<p class="theme-papers"><em>Papers: ${theme.papers.map(citeLink).join(', ')}</em></p>`)
      }
      body.push(`</article>`)
    }
  }
  body.push(`</section>`)

  // ── §3: Methods & datasets ──────────────────────────────────
  body.push(`<section id="methods">`)
  body.push(`<h2>3. Methods & datasets</h2>`)
  if (agg.methods.length > 0) {
    body.push(`<h3>Methods (terms appearing in 2+ papers)</h3>`)
    body.push(`<ul>`)
    for (const m of agg.methods) {
      body.push(
        `<li><strong>${escapeHtml(m.term)}</strong> — ${m.count} papers — ${m.citeKeys.map(citeLink).join(', ')}</li>`
      )
    }
    body.push(`</ul>`)
  }
  if (agg.datasets.length > 0) {
    body.push(`<h3>Datasets</h3>`)
    body.push(`<ul>`)
    for (const d of agg.datasets) {
      body.push(
        `<li><strong>${escapeHtml(d.term)}</strong> — ${d.count} papers — ${d.citeKeys.map(citeLink).join(', ')}</li>`
      )
    }
    body.push(`</ul>`)
  }
  if (agg.methods.length === 0 && agg.datasets.length === 0) {
    body.push(`<p class="empty">No recurring methods or datasets detected yet.</p>`)
  }
  body.push(`</section>`)

  // ── §4: Open questions ──────────────────────────────────────
  body.push(`<section id="gaps">`)
  body.push(`<h2>4. Open questions & limitations</h2>`)
  if (agg.limitations.length === 0 && agg.negativeResults.length === 0) {
    body.push(`<p class="empty">No limitations or negative results captured in this pack yet.</p>`)
  } else {
    if (agg.limitations.length > 0) {
      body.push(`<h3>Limitations papers themselves call out</h3>`)
      body.push(`<ul>`)
      for (const l of agg.limitations.slice(0, 15)) {
        body.push(`<li>${citeLink(l.citeKey)}: ${escapeHtml(l.text)}</li>`)
      }
      if (agg.limitations.length > 15) {
        body.push(`<li class="more">… and ${agg.limitations.length - 15} more (see appendix)</li>`)
      }
      body.push(`</ul>`)
    }
    if (agg.negativeResults.length > 0) {
      body.push(`<h3>Negative results worth knowing</h3>`)
      body.push(`<ul>`)
      for (const n of agg.negativeResults.slice(0, 10)) {
        body.push(`<li>${citeLink(n.citeKey)}: ${escapeHtml(n.text)}</li>`)
      }
      body.push(`</ul>`)
    }
  }
  body.push(`</section>`)

  // ── §5: Onboarding ──────────────────────────────────────────
  body.push(`<section id="onboarding">`)
  body.push(`<h2>5. Onboarding path</h2>`)
  if (ranking.entries.length === 0) {
    body.push(`<p class="empty">No clear reading order — the pack lacks signal for ranking.</p>`)
  } else {
    body.push(`<p>Suggested reading order for a new lab member:</p>`)
    body.push(`<ol>`)
    for (const e of ranking.entries) {
      const flag = e.scoreComponents.isSurvey ? ' <span class="badge">survey</span>' : ''
      body.push(
        `<li>${citeLink(e.citeKey)} — <em>${escapeHtml(e.title)}</em>${flag}<br><span class="onboarding-why">${escapeHtml(e.oneLineWhy)}</span></li>`
      )
    }
    body.push(`</ol>`)
  }
  body.push(`</section>`)

  // ── §6: Talking points ──────────────────────────────────────
  body.push(`<section id="talking-points">`)
  body.push(`<h2>6. Lab meeting talking points</h2>`)
  if (synthesis.talkingPoints.length === 0) {
    body.push(`<p class="empty">No talking points surfaced this run.</p>`)
  } else {
    body.push(`<ul>`)
    for (const tp of synthesis.talkingPoints) {
      body.push(`<li>${linkifyCiteKeysHtml(tp.point)}</li>`)
    }
    body.push(`</ul>`)
  }
  body.push(`</section>`)

  // ── Appendix ────────────────────────────────────────────────
  body.push(`<section id="appendix">`)
  body.push(`<h2>Appendix: per-paper one-liners</h2>`)
  for (const entry of input.papers) {
    const p = entry.paper
    if (!p.citeKey) continue
    const tierBadge = entry.wiki?.source_tier === 'fulltext'
      ? ''
      : ' <span class="badge muted">abstract only</span>'
    const authors = formatAuthorsShort(p.authors)
    const year = p.year != null ? `, ${p.year}` : ''
    const venue = p.venue ? ` · ${escapeHtml(p.venue)}` : ''
    const oneLine = entry.wiki?.tldr || firstSentence(p.abstract) || '<em>No summary available.</em>'
    body.push(`<article id="cite-${escapeHtml(p.citeKey)}" class="paper-card">`)
    body.push(`<h3>${escapeHtml(p.citeKey)}${tierBadge}</h3>`)
    body.push(`<p class="paper-meta"><strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(authors)}${year}${venue}</p>`)
    body.push(`<p class="paper-tldr">${escapeHtml(oneLine)}</p>`)
    if (p.doi && !p.doi.startsWith('unknown:')) {
      body.push(`<p class="paper-links"><a href="https://doi.org/${escapeHtml(p.doi)}" target="_blank" rel="noopener">DOI: ${escapeHtml(p.doi)} ↗</a></p>`)
    } else if (p.url) {
      body.push(`<p class="paper-links"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.url)} ↗</a></p>`)
    }
    body.push(`</article>`)
  }
  body.push(`</section>`)

  // ── Footer ──────────────────────────────────────────────────
  body.push(`<footer>`)
  body.push(
    `<p>Generated by PiPilot from the Paper Wiki extraction of this project. ${agg.abstractOnlyCount} of ${agg.totalPapers} papers were synthesized from abstracts only; the rest from full text.</p>`
  )
  body.push(`</footer>`)

  return wrapHtml(title, body.join('\n'))
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const CITE_INLINE_RE = /\[([a-zA-Z][a-zA-Z0-9_:\-]*(?:\s*,\s*[a-zA-Z][a-zA-Z0-9_:\-]*)*)\]/g

function citeLink(citeKey: string): string {
  return `<a class="cite" href="#cite-${escapeHtml(citeKey)}">[${escapeHtml(citeKey)}]</a>`
}

function linkifyCiteKeysHtml(text: string): string {
  // Apply citation rewrites first, then HTML-escape the surrounding text.
  // To keep both safe, we escape the text in chunks split by the cite-
  // regex and emit unescaped <a> tags from our own template.
  const out: string[] = []
  let lastIndex = 0
  CITE_INLINE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CITE_INLINE_RE.exec(text))) {
    if (match.index > lastIndex) {
      out.push(escapeHtml(text.slice(lastIndex, match.index)))
    }
    const inside = match[1]
    const keys = inside.split(',').map((s) => s.trim()).filter(Boolean)
    out.push(keys.map(citeLink).join(', '))
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    out.push(escapeHtml(text.slice(lastIndex)))
  }
  return out.join('')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

// ─── HTML wrapper + CSS ──────────────────────────────────────────────────

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${BASIC_CSS}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

const BASIC_CSS = `
:root {
  --fg: #1a1a1a;
  --fg-muted: #555;
  --fg-faint: #888;
  --bg: #fafafa;
  --bg-card: #fff;
  --border: #e0e0e0;
  --accent: #2c5aa0;
  --accent-faint: #e6efff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e8e8e8;
    --fg-muted: #b0b0b0;
    --fg-faint: #888;
    --bg: #1a1a1a;
    --bg-card: #252525;
    --border: #3a3a3a;
    --accent: #6ea3ff;
    --accent-faint: #1f2a40;
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
  padding: 0;
}
main {
  max-width: 820px;
  margin: 0 auto;
  padding: 2.5rem 2rem 4rem;
}
header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
h1 { font-size: 1.6rem; margin: 0 0 0.5rem; font-weight: 600; }
h2 { font-size: 1.25rem; margin-top: 2.5rem; margin-bottom: 0.75rem; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
h3 { font-size: 1.05rem; margin-top: 1.5rem; margin-bottom: 0.4rem; font-weight: 600; }
.meta { color: var(--fg-muted); font-size: 0.9rem; margin: 0; }
section { margin-top: 1.5rem; }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.35rem 0; }
a.cite {
  text-decoration: none;
  color: var(--accent);
  padding: 0 1px;
  border-radius: 2px;
  font-size: 0.92em;
}
a.cite:hover { background: var(--accent-faint); }
a { color: var(--accent); }
.empty { color: var(--fg-faint); font-style: italic; }
.count { color: var(--fg-muted); font-weight: normal; font-size: 0.85em; }
.badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--accent-faint);
  color: var(--accent);
  font-size: 0.7em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  vertical-align: middle;
}
.badge.muted { background: transparent; border: 1px solid var(--border); color: var(--fg-muted); }
.theme { margin-bottom: 1rem; }
.theme-papers { color: var(--fg-muted); font-size: 0.88em; margin-top: 0.4rem; }
.onboarding-why { color: var(--fg-muted); font-size: 0.93em; }
.year-histogram { width: 100%; max-width: 500px; border-collapse: collapse; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85rem; }
.year-histogram td { padding: 1px 6px; vertical-align: middle; }
.year-histogram .year { color: var(--fg-muted); }
.year-histogram .count { text-align: right; color: var(--fg-muted); width: 3em; }
.year-histogram .bar-cell { width: 70%; }
.year-histogram .bar { height: 0.8em; background: var(--accent); border-radius: 1px; min-width: 2px; }
.paper-card { margin-top: 1.25rem; padding: 0.5rem 0 0.75rem; border-top: 1px solid var(--border); }
.paper-card h3 { margin-top: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.95rem; color: var(--fg-muted); }
.paper-meta { margin: 0.25rem 0; }
.paper-tldr { color: var(--fg); margin: 0.4rem 0; }
.paper-links a { font-size: 0.88rem; color: var(--accent); text-decoration: none; }
.paper-links a:hover { text-decoration: underline; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--fg-faint); font-size: 0.85rem; }
@media print {
  body { background: white; color: black; }
  .paper-card { break-inside: avoid; }
}
`
