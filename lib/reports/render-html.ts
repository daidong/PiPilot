/**
 * Render the Paper Pack Report as standalone HTML (RFC-007 PR-B + PR-C).
 *
 * Self-contained single-file output. No external assets, no network.
 * Email-attachable. Works offline.
 *
 * What PR-C added on top of PR-B's basic emit:
 *   - Sticky TOC sidebar on the left (with `<nav>` landmark); collapses
 *     into a flat top bar at narrow widths
 *   - ~50 lines of vanilla JS doing IntersectionObserver-based scrollspy
 *     so the TOC entry for the visible section is highlighted as the
 *     user scrolls
 *   - Per-paper appendix entries gain a collapsible `<details>` block
 *     with the full wiki extraction (findings, methods, datasets,
 *     limitations, negative_results, concept_edges). Collapsed by
 *     default so the appendix stays scannable.
 *   - Tightened print styles (no TOC, no `<details>` toggle chrome,
 *     each paper-card unbroken across pages)
 *   - Polished `abstract-only` badge — visible but not alarming
 *
 * The scrollspy is the only client-side behavior. Everything else still
 * works with JS disabled (the TOC degrades to plain anchor links).
 */

import type {
  ReportInput,
  AggregateSummary,
  SynthesisOutput,
  OnboardingPath,
} from './types.js'
import type { WikiPaperMemoryMeta } from '../wiki/memory-schema.js'

export function renderHtml(
  input: ReportInput,
  agg: AggregateSummary,
  synthesis: SynthesisOutput,
  ranking: OnboardingPath
): string {
  const fmtDate = new Date(input.capturedAt).toISOString().slice(0, 10)
  const title = `Paper Pack Report — ${escapeHtml(input.projectName)}`

  // ── TOC entries — keyed off the section ids used below ──────────
  const tocItems: Array<{ id: string; label: string }> = [
    { id: 'at-a-glance', label: 'At a glance' },
    { id: 'themes', label: 'Themes' },
    { id: 'methods', label: 'Methods & datasets' },
    { id: 'gaps', label: 'Open questions' },
    { id: 'onboarding', label: 'Onboarding' },
    { id: 'talking-points', label: 'Talking points' },
    { id: 'appendix', label: 'Appendix' },
  ]

  const body: string[] = []
  body.push(`<header>`)
  body.push(`<h1>${escapeHtml(title)}</h1>`)
  body.push(
    `<p class="meta">${[
      `Generated ${fmtDate}`,
      `${agg.totalPapers} papers`,
      agg.fulltextCount > 0 || agg.abstractOnlyCount > 0
        ? `${agg.fulltextCount} full-text · ${agg.abstractOnlyCount} abstract-only`
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
  body.push(`<h2>Appendix: per-paper details</h2>`)
  for (const entry of input.papers) {
    const p = entry.paper
    if (!p.citeKey) continue
    const tierBadge = entry.wiki?.source_tier === 'fulltext'
      ? ''
      : ' <span class="badge tier-abstract" title="Wiki extraction came from the paper\'s abstract only — full text was not available">abstract only</span>'
    const authors = formatAuthorsShort(p.authors)
    const year = p.year != null ? `, ${p.year}` : ''
    const venue = p.venue ? ` · ${escapeHtml(p.venue)}` : ''
    const oneLine = entry.wiki?.tldr || firstSentence(p.abstract) || ''
    body.push(`<article id="cite-${escapeHtml(p.citeKey)}" class="paper-card">`)
    body.push(`<h3>${escapeHtml(p.citeKey)}${tierBadge}</h3>`)
    body.push(`<p class="paper-meta"><strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(authors)}${year}${venue}</p>`)
    if (oneLine) {
      body.push(`<p class="paper-tldr">${escapeHtml(oneLine)}</p>`)
    } else {
      body.push(`<p class="paper-tldr empty">No summary available.</p>`)
    }
    // PR-C addition: collapsible wiki extraction.
    const wikiBlock = renderWikiDetailsBlock(entry.wiki)
    if (wikiBlock) body.push(wikiBlock)
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

  return wrapHtml(title, tocItems, body.join('\n'))
}

// ─── PR-C: Wiki extraction details block ─────────────────────────────────

/**
 * Render the per-paper `<details>` block containing the wiki extraction.
 * Collapsed by default so the appendix stays scannable. Skipped entirely
 * when wiki is null OR when the extraction has nothing of substance to
 * show (only an empty TLDR isn't worth a disclosure widget).
 */
function renderWikiDetailsBlock(wiki: WikiPaperMemoryMeta | null): string | null {
  if (!wiki) return null

  const findings = wiki.findings ?? []
  const methods = wiki.methods ?? []
  const datasets = wiki.datasets ?? []
  const limitations = wiki.limitations ?? []
  const negativeResults = wiki.negative_results ?? []
  const conceptEdges = wiki.concept_edges ?? []

  const hasContent =
    findings.length > 0 ||
    methods.length > 0 ||
    datasets.length > 0 ||
    limitations.length > 0 ||
    negativeResults.length > 0 ||
    conceptEdges.length > 0
  if (!hasContent) return null

  const parts: string[] = []
  parts.push(`<details class="wiki-extract">`)
  parts.push(`<summary>Wiki extraction</summary>`)
  parts.push(`<div class="wiki-body">`)

  if (findings.length > 0) {
    parts.push(`<h4>Findings</h4><ul>`)
    for (const f of findings.slice(0, 8)) {
      const value = f.value ? ` <span class="finding-value">(${escapeHtml(f.value)})</span>` : ''
      parts.push(`<li>${escapeHtml(f.statement)}${value}</li>`)
    }
    if (findings.length > 8) parts.push(`<li class="more">… and ${findings.length - 8} more</li>`)
    parts.push(`</ul>`)
  }
  if (methods.length > 0) {
    parts.push(`<h4>Methods</h4><p>${methods.map(escapeHtml).join(', ')}</p>`)
  }
  if (datasets.length > 0) {
    parts.push(`<h4>Datasets</h4><ul>`)
    for (const d of datasets.slice(0, 6)) {
      const role = d.role ? ` <span class="dataset-role">(${escapeHtml(d.role)})</span>` : ''
      parts.push(`<li>${escapeHtml(d.name)}${role}</li>`)
    }
    parts.push(`</ul>`)
  }
  if (limitations.length > 0) {
    parts.push(`<h4>Limitations</h4><ul>`)
    for (const l of limitations.slice(0, 6)) parts.push(`<li>${escapeHtml(l.text)}</li>`)
    parts.push(`</ul>`)
  }
  if (negativeResults.length > 0) {
    parts.push(`<h4>Negative results</h4><ul>`)
    for (const n of negativeResults.slice(0, 6)) parts.push(`<li>${escapeHtml(n.text)}</li>`)
    parts.push(`</ul>`)
  }
  if (conceptEdges.length > 0) {
    parts.push(`<h4>Concepts</h4><p>${conceptEdges
      .slice(0, 8)
      .map((e) => `<span class="concept-pill">${escapeHtml(e.slug)}</span>`)
      .join(' ')}</p>`)
  }

  parts.push(`</div></details>`)
  return parts.join('\n')
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

// ─── HTML wrapper + CSS + scrollspy JS ───────────────────────────────────

function wrapHtml(title: string, tocItems: Array<{ id: string; label: string }>, body: string): string {
  const tocLinks = tocItems
    .map((t) => `<li><a href="#${t.id}" data-toc-target="${t.id}">${escapeHtml(t.label)}</a></li>`)
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${POLISHED_CSS}
</style>
</head>
<body>
<nav class="toc" aria-label="Table of contents">
<p class="toc-title">Contents</p>
<ul>
${tocLinks}
</ul>
</nav>
<main>
${body}
</main>
<script>
${SCROLLSPY_JS}
</script>
</body>
</html>
`
}

/**
 * IntersectionObserver-based scrollspy. ~50 lines. Highlights the TOC
 * entry corresponding to whichever section is currently most prominent
 * in the viewport. No dependencies, no transpilation needed — runs in
 * every browser that supports IntersectionObserver (all modern browsers
 * since 2017).
 *
 * If JS is disabled or the API is missing, the TOC degrades gracefully
 * to plain anchor links — clicks still work, just no active highlight.
 */
const SCROLLSPY_JS = `(function () {
  if (typeof IntersectionObserver === 'undefined') return;
  var tocLinks = document.querySelectorAll('[data-toc-target]');
  if (tocLinks.length === 0) return;
  var byId = {};
  tocLinks.forEach(function (a) {
    var id = a.getAttribute('data-toc-target');
    byId[id] = a;
  });
  var sections = [];
  Object.keys(byId).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) sections.push(el);
  });
  if (sections.length === 0) return;
  // Track which sections are currently visible. The "active" link is
  // the topmost visible one. This avoids the common scrollspy glitch
  // where two adjacent short sections both light up at once.
  var visible = new Set();
  function refresh() {
    var topmost = null;
    var topmostY = Infinity;
    visible.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < topmostY) {
        topmostY = rect.top;
        topmost = id;
      }
    });
    Object.keys(byId).forEach(function (id) {
      byId[id].classList.toggle('active', id === topmost);
    });
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var id = entry.target.id;
      if (entry.isIntersecting) visible.add(id);
      else visible.delete(id);
    });
    refresh();
  }, { rootMargin: '-80px 0px -50% 0px', threshold: 0 });
  sections.forEach(function (s) { io.observe(s); });
})();`

const POLISHED_CSS = `
:root {
  --fg: #1a1a1a;
  --fg-muted: #555;
  --fg-faint: #888;
  --bg: #fafafa;
  --bg-card: #fff;
  --border: #e0e0e0;
  --accent: #2c5aa0;
  --accent-faint: #e6efff;
  --warn-faint: #fff7e0;
  --warn-text: #8a6d00;
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
    --warn-faint: #3a3320;
    --warn-text: #d8c067;
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
/* Two-column layout: TOC pinned left at >= 1100px, stacked above at narrower widths. */
nav.toc {
  position: fixed;
  top: 2rem;
  left: 2rem;
  width: 210px;
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
  padding: 0;
  font-size: 0.85rem;
  z-index: 10;
}
nav.toc .toc-title {
  margin: 0 0 0.5rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-faint);
  font-weight: 600;
}
nav.toc ul {
  list-style: none;
  padding: 0;
  margin: 0;
  border-left: 2px solid var(--border);
}
nav.toc li { margin: 0; }
nav.toc a {
  display: block;
  padding: 4px 12px;
  color: var(--fg-muted);
  text-decoration: none;
  margin-left: -2px;
  border-left: 2px solid transparent;
  font-size: 0.85rem;
  transition: color 0.15s, border-color 0.15s;
}
nav.toc a:hover { color: var(--fg); }
nav.toc a.active {
  color: var(--accent);
  border-left-color: var(--accent);
}
main {
  max-width: 820px;
  margin: 0 auto;
  padding: 2.5rem 2rem 4rem;
}
@media (max-width: 1100px) {
  nav.toc {
    position: static;
    width: auto;
    max-height: none;
    padding: 1rem 2rem 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  nav.toc ul {
    display: flex;
    flex-wrap: wrap;
    border-left: none;
    gap: 0.25rem 0.75rem;
  }
  nav.toc a {
    padding: 2px 0;
    margin-left: 0;
    border-left: none;
    border-bottom: 2px solid transparent;
  }
  nav.toc a.active { border-bottom-color: var(--accent); border-left: none; }
  main { padding-top: 1.25rem; }
}
@media (min-width: 1101px) {
  main { padding-left: 240px; }
}
header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
h1 { font-size: 1.6rem; margin: 0 0 0.5rem; font-weight: 600; }
h2 { font-size: 1.25rem; margin-top: 2.5rem; margin-bottom: 0.75rem; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; scroll-margin-top: 1rem; }
h3 { font-size: 1.05rem; margin-top: 1.5rem; margin-bottom: 0.4rem; font-weight: 600; }
h4 { font-size: 0.85rem; margin-top: 0.8rem; margin-bottom: 0.3rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.meta { color: var(--fg-muted); font-size: 0.9rem; margin: 0; }
section { margin-top: 1.5rem; scroll-margin-top: 1rem; }
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
  font-weight: 600;
}
.badge.tier-abstract {
  background: var(--warn-faint);
  color: var(--warn-text);
}
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
.paper-tldr.empty { color: var(--fg-faint); font-style: italic; }
.paper-links a { font-size: 0.88rem; color: var(--accent); text-decoration: none; }
.paper-links a:hover { text-decoration: underline; }
details.wiki-extract {
  margin: 0.5rem 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-card);
}
details.wiki-extract > summary {
  cursor: pointer;
  padding: 0.35rem 0.65rem;
  font-size: 0.82rem;
  color: var(--fg-muted);
  user-select: none;
  font-weight: 500;
}
details.wiki-extract[open] > summary {
  border-bottom: 1px solid var(--border);
  color: var(--fg);
}
.wiki-body { padding: 0.5rem 0.9rem 0.7rem; }
.wiki-body h4 { margin-top: 0.7rem; }
.wiki-body h4:first-child { margin-top: 0.3rem; }
.wiki-body ul { padding-left: 1.2rem; margin: 0.25rem 0; }
.wiki-body li { margin: 0.18rem 0; font-size: 0.9rem; }
.finding-value { color: var(--accent); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85em; }
.dataset-role { color: var(--fg-faint); font-size: 0.85em; }
.concept-pill {
  display: inline-block;
  padding: 1px 8px;
  margin: 2px 4px 2px 0;
  background: var(--accent-faint);
  color: var(--accent);
  border-radius: 10px;
  font-size: 0.8em;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--fg-faint); font-size: 0.85rem; }
@media print {
  body { background: white; color: black; }
  nav.toc { display: none; }
  main { padding-left: 0; max-width: 100%; }
  /* Auto-open wiki extractions for print — readers can't click. */
  details.wiki-extract > summary { display: none; }
  details.wiki-extract > .wiki-body { padding: 0.3rem 0; }
  details.wiki-extract { border: none; background: transparent; }
  .paper-card { break-inside: avoid; page-break-inside: avoid; }
  section { break-inside: avoid-page; }
  a.cite { color: black; text-decoration: none; }
  a { color: black; }
  .badge, .concept-pill { background: transparent !important; border: 1px solid #999; color: black; }
}
`
