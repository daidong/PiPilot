# RFC-007: Paper Pack Report

**Status:** Draft v1 — awaiting Captain's review
**Author:** Captain + Claude
**Date:** 2026-05-12
**Builds on:** RFC-006 (BibTeX import), RFC-003/005 (Paper Wiki + sidecar)
**Scope:** A one-click synthesis of the user's paper library into a citation-grounded local report (Markdown + HTML), positioned as the first "aha moment" of PiPilot.

## 1. Motivation

The five-PR BibTeX importer (RFC-006) handed the user a fast path to populate
their library. They now see a list of papers in the Literature tab. That's
**not** an aha moment — it's the same view they had in Zotero, minus the
features Zotero already has.

The aha moment we want: **"this app actually read my papers and told me
something I didn't know about my own pile."**

This RFC proposes a generated artifact at the project root —
`rp-paper-pack-report.md` plus its sibling `.html` — that does exactly
that, plus three concrete use cases:

- **Lab meeting prep** — "what are 3 talking points from the last 20 papers I added?"
- **Student onboarding** — "what should a new member of the lab read first?"
- **Paper planning** — "what's the consensus / open questions in this pile, so I can frame a new paper?"

## 2. Initial Misframe (and why this RFC exists)

The first sketch of this feature assumed report generation could run
immediately after BibTeX import. Captain flagged the problem: **a freshly
imported paper artifact has almost no usable content beyond title /
author / year / DOI / citeKey.** Abstracts are sparse (Zotero's `abstract`
field is often empty), and full text is never in the .bib file.

A "report" generated from just bibliographic metadata is a glorified
list — not insight. The aha moment we want **requires real content**:
abstracts, methods, findings, datasets, limitations. That content only
arrives after the existing enrichment + Paper Wiki pipeline has done
its work.

So this RFC pivots: **the report consumes Paper Wiki output, not raw
paper artifacts**. The Wiki agent has already done the per-paper LLM
extraction we'd otherwise have to redo from scratch. Report
synthesis becomes assembly + composition over structured wiki data,
not raw paper crunching. This is dramatically cheaper and higher
quality.

## 3. Pipeline Awareness — Where the Content Comes From

Three stages of paper artifact richness, surveyed in the existing
codebase:

### Stage 1 — Just imported (BibTeX → `upsertPaperArtifact`)

What's filled:
- title, authors, year, citeKey, doi (or `unknown:*`), bibtex, venue, url, arxivId, identityConfidence, tags

What's missing or empty:
- abstract (often), citationCount, anything synthesized

**Verdict:** A report here would be hollow — clustering by title alone is
weak signal. Not worth running.

### Stage 2 — After `enrichPaperArtifacts` (CrossRef + Semantic Scholar)

What gets filled (fill-only, only when prior field is empty/placeholder):
- abstract, venue (normalized), citationCount, doi (if was unknown:*), authors (if was Unknown), url, pdfUrl

What's still missing:
- task / methods / findings / datasets / limitations — these don't exist anywhere

**Verdict:** Better. A report here could do basic topic clustering on
abstracts + citation-count-based "must read" lists. But the value is
shallow: we're paraphrasing abstracts, not synthesizing claims. Skip.

### Stage 3 — After Paper Wiki processes the paper

The Wiki agent generates a per-paper markdown page with an embedded
`WikiPaperMemoryMeta` sidecar (`lib/wiki/memory-schema.ts:116`). Fields:

| Wiki sidecar field | What it gives us |
|---|---|
| `tldr` | 1-2 sentence paper summary |
| `task[]` | What problem the paper addresses |
| `methods[]` | Approaches used |
| `datasets[]` | Data used / introduced |
| `findings[]` | Specific claims the paper makes |
| `baselines[]` | What it was compared against |
| `limitations[]` | What the paper itself says it can't do |
| `negative_results[]` | Things that didn't work |
| `concept_edges[]` | Cross-paper concept links |
| `aliases[]` | Alternate names for this paper |
| `paper_type` | survey / method / dataset / application / ... |
| `source_tier` | `'fulltext'` / `'abstract-fallback'` / `'abstract-only'` |

Plus separate Concept pages (`WikiConceptMemoryMeta`,
`memory-schema.ts:162`) that already synthesize across papers per
concept — e.g. all papers that touch "retrieval augmentation" are
linked from one concept page with their respective relations.

**Verdict:** This is the input we want. Wiki has already done the
expensive per-paper LLM extraction. The report becomes
**assembly + composition** over structured data, not re-analysis.

## 4. Report-Readiness Gate

The Quick Action button replacing "Quick Update" in `LiteratureSidebar`
(`Generate Paper Report`) becomes the **status display for the entire
pipeline**, not just for report generation. Six states:

| State | Button label | Disabled? | Visual |
|---|---|---|---|
| `pre-enrichment` | `Enrichment needed first` | yes | gray, hint text |
| `enriching` | `Enriching N/M papers…` | yes | thin progress bar inside button |
| `pre-wiki` | `Wiki processing N/M…` | yes | same progress UX |
| `ready` | `Generate Paper Report` | no | accent color, primary CTA |
| `generating` | `Generating: <step>… N%` | yes | progress in button |
| `done` | `Open Paper Report` | no | accent, plus tiny ↻ regenerate icon |
| `error` | `Generate failed — retry` | no | warning color |

**Why a single button instead of separate UI for each stage:** every
button click here ends with one of two real actions ("open the
report") or ("trigger generation"). The other states are just
explaining *why you can't click yet*. Embedding the explanation in
the button text is more compact than a separate banner.

### What "caught up" means operationally

- **Enrichment**: no built-in IPC status channel today
  (`lib/commands/paper-enrichment.ts:21-24` has only a callback). We
  add a small renderer-side `enrichmentStatus` derived from observing
  `enrich:progress` events plus a "no events for >2s while papers
  still need enrichment" idle detector.
- **Wiki**: `wiki:status` already broadcasts
  `{ state, processed, pending, totalInWiki }`. Operational gate is
  `state === 'idle' && pending === 0` (the agent has caught up; failed
  papers are in backoff per `lib/wiki/scanner.ts`, not in the queue).

### What about papers that *never* reach fulltext?

Some papers (no DOI, no arXiv, no Paperclip key) stay forever as
`source_tier: 'abstract-only'` after wiki processing. Their findings
will be thin. Report handling:

1. Report **still uses these papers** — they have `tldr` and probably
   `task[]` from their abstract
2. Report footer notes counts: "Of N papers, K were synthesized from
   full text and (N-K) from abstracts only"
3. No infinite wait: wiki processes all artifacts, generates a page
   for each — even if `abstract-only`. `pending === 0` is reachable.

## 5. Auto-Trigger Enrichment After Import

Currently the ImportWizard's Done step has a `Run enrichment` button.
Users may not click it. Then they sit in `pre-enrichment` state
forever, confused why the report button is locked.

**Change:** auto-trigger `enrichPaperArtifacts(importedPaperIds)` when
import completes. Wizard's Done step removes the manual button and
shows the status inline. Wiki agent then auto-picks-up enriched
artifacts as it always does.

Net effect: one-click import flows through enrichment → wiki → report
button enables.

## 6. Report Contents

Six sections, each backed by a specific data source so the prompt
budget stays small. Citations use `[citeKey]` syntax — every claim
gets at least one.

```markdown
# Paper Pack Report — <Project Name>
Generated 2026-05-12 · N papers (K full-text, M abstract-only) · span 2018–2026

## 1. At a glance
- One-paragraph framing: what subfield does this pile span?
- Bar chart inline: papers per year (ASCII or HTML SVG)
- Top-5 most-cited papers in pack: [foo2024], [bar2023], ... — 1 line each

## 2. Thematic landscape
LLM clusters papers into 3-6 themes (NOT dozens).
Input: each paper's tldr + task[] + concept_edges[]
For each theme:
- **<theme name>** (n papers)
- 1-paragraph synthesis with inline cite keys
- Sub-bullet: consensus claims [refs]
- Sub-bullet: open disagreement [refs vs refs]

## 3. Methods & datasets used in this pack
- Histogram-style aggregation of methods[] across all papers
- "Twelve papers use transformer-based architectures [refs]"
- Same for datasets[]
- Top-3 baselines that recur [refs]

## 4. Open questions / what's missing
Input: limitations[] + negative_results[] + concept_edges[] gaps
- "Common limitation across the pile: <X> [refs]"
- "Frequently cited but absent from this pack: <relevant concept>" (from
  concept_edges pointing at papers NOT in the artifact set)
- "Negative results worth knowing: [refs]"

## 5. Onboarding path (5 papers, in reading order)
Computed (no LLM): rank by paper_type='survey' first, then by
citationCount, then by concept-graph centrality. Output:
1. [paper1] — one-sentence pitch from tldr
2. [paper2] — ...

## 6. Lab meeting talking points
LLM-selected: 3-5 surprising, controversial, or actionable findings
across the pile, each with citation.
- "Despite N papers using X, [oneref] reports it fails when Y"

## Appendix: per-paper one-liners
- [smith2024] — full tldr + paper_type + source_tier badge
- ...
```

HTML version: same sections, but cite keys become anchor links that
scroll to the appendix entry; appendix entries link out to DOI/URL and
expand the wiki page in a popover when available; TOC sidebar pinned
at left; print-friendly styles.

## 7. Architecture

```
lib/reports/
  paper-pack-report.ts       — orchestrator, exports generatePaperPackReport()
  input-builder.ts           — reads paper artifacts + wiki pages, builds
                                a `ReportInput` (structured, dedup'd)
  prompts/
    cluster-themes.ts        — one LLM call: cluster papers
    write-theme-section.ts   — one LLM call PER cluster: write theme block
    methods-section.ts       — one LLM call (over aggregated tags)
    gaps-section.ts          — one LLM call
    talking-points.ts        — one LLM call
  render-markdown.ts         — emits rp-paper-pack-report.md
  render-html.ts             — emits rp-paper-pack-report.html
  state.ts                   — read/write .research-pilot/report-state.json
  hash.ts                    — content-hash of input set for cache key

lib/commands/
  report.ts                  — generatePaperReport(ctx) command
                                wraps lib/reports + writes files

app/src/main/ipc.ts
  cmd:generate-paper-report   — triggers generation
  cmd:get-paper-report-state  — current state read
  report:progress             — main → renderer progress events
  report:done                 — main → renderer terminal event

app/src/renderer/stores/
  report-store.ts             — state machine for the button
                                + subscribes to wiki:status + enrich:progress
                                + exposes derived `buttonState` to UI

app/src/renderer/components/left/
  LiteratureSidebar.tsx       — replaces "Quick Update" QuickAction with
                                "Paper Report" (label + behavior per state)
```

State machine derivation (in `report-store.ts`):

```ts
function deriveButtonState(deps: {
  papers: EntityItem[]
  enrichment: EnrichmentStatus
  wiki: WikiStatusShape | null
  report: ReportState
}): ButtonState {
  if (deps.report.status === 'running') return 'generating'
  if (deps.report.status === 'done' && deps.report.inputHash === currentInputHash(deps.papers))
    return 'done'
  if (deps.report.status === 'error') return 'error'

  if (deps.enrichment.state === 'running') return 'enriching'
  if (deps.enrichment.state === 'pending') return 'pre-enrichment'

  if (!deps.wiki || deps.wiki.state === 'disabled') return 'pre-wiki'
  if (deps.wiki.state === 'processing' || deps.wiki.pending > 0) return 'pre-wiki'

  return 'ready'
}
```

## 8. Caching

Generation is expensive; double-click protection is non-negotiable.

- `report-state.json` stores `{ status, inputHash, generatedAt, path, error?, currentStep?, percent? }`.
- `inputHash` = sha256 of sorted `{id, citeKey, wikiSlug, wikiMetaHash}` per paper. Re-generating with the same hash is a no-op (button shows "Open report").
- Explicit `Regenerate` button (the ↻ icon, requires confirmation modal) is the only way to force re-run when hash hasn't changed.
- During `running`, the IPC handler refuses a second `cmd:generate-paper-report` call with `{ success: false, error: 'already-running' }`.

## 9. Cost & Sizing

Realistic numbers per typical library (Sonnet, with `wiki` data as
input rather than raw papers):

| Library size | LLM calls | Approx tokens in / out | Approx time | Approx cost |
|---|---|---|---|---|
| 25 papers | ~8 (5 themes + methods + gaps + talking) | 15k / 8k | 60-90s | $0.10 |
| 50 papers | ~9 | 30k / 12k | 90-150s | $0.20 |
| 100 papers | ~10 | 60k / 18k | 120-240s | $0.40 |
| 250 papers | ~12 (more themes) | 150k / 25k | 4-7 min | $0.90 |

Wait-times **prior** to the button enabling (pipeline catch-up,
mostly out of this RFC's control):

| Library size | Enrichment serial | Wiki processing |
|---|---|---|
| 25 papers | 5-10 min | 15-30 min |
| 100 papers | 30-60 min | 1-2 hours |

This is the real UX challenge: the aha moment isn't immediate after
import. **It arrives ~1-2 hours later for a 100-paper library.** The
button-as-status-display is how we make that wait honest and
inspectable rather than confusing.

A future PR may parallelize Wiki processing for first-import bursts;
out of scope here.

## 10. Out of Scope

- Wiki processing parallelization (separate RFC if pursued)
- Multi-project reports
- Per-paper reports (Paper Wiki already serves that)
- Diff reports ("what changed since last report")
- Auto-emailing / sharing
- Custom report sections / user-defined templates
- Citation graph beyond what `concept_edges` already provides

## 11. Resolved Decisions

| ID | Decision |
|---|---|
| Report input source | Paper Wiki sidecars (WikiPaperMemoryMeta), not raw paper artifacts |
| Output location | `<project-root>/rp-paper-pack-report.md` + `.html` |
| Button placement | Replaces "Quick Update" in LiteratureSidebar QUICK ACTIONS |
| Gate when ready? | `enrichment idle AND wiki state === 'idle' AND wiki pending === 0` |
| Auto-trigger enrichment after import? | Yes — remove manual "Run enrichment" button from wizard Done step |
| Cache key | sha256 of `{paperId, citeKey, wikiSlug, wikiMetaHash}` set |
| Regenerate UX | Tiny ↻ icon, confirm modal |
| Double-click protection | IPC refuses second call if running, state machine disables button |
| LLM for report | Reuse the project's configured chat model (no special model setting) |

## 12. Open Questions (Captain to decide)

**Q1 — Threshold for "wiki done"?**
Strict: 100% of papers must have a wiki page. Fails on backoff-stuck
papers. Practical: `wiki.state === 'idle' && wiki.pending === 0`
(wiki's own definition of caught-up). I lean **practical**.

**Q2 — Should the wizard auto-trigger enrichment, or just nudge?**
Auto-trigger means the user gets enrichment cost without explicitly
opting in (CrossRef/S2 calls aren't free in API limits but are free
in dollars). I lean **auto-trigger**, with a one-line note in the
wizard's Done step: *"Enrichment + Wiki processing started in the
background. Paper Report will become available when ready."*

**Q3 — Status visualization when many papers are stuck on
`abstract-only`?**
Some papers will never have full text. They get processed quickly but
provide thin data. Should the button gate on "X% of papers reached
fulltext" or be content with abstract-only?
Recommendation: **don't gate on fulltext** — wiki has done what it
can; the report explicitly disclaims data source per paper.

**Q4 — Confirm filename?** `rp-paper-pack-report.md` is reasonable
but bikesheddable. Alternatives: `paper-report.md`,
`lab-pack-report.md`, `<project-name>-pack.md`. I lean
**`rp-paper-pack-report.md`** for unambiguous discoverability
(`rp-` prefix signals "PiPilot generated this, safe to overwrite on
regen").

**Q5 — HTML viewer surface?** Two options:
(a) Generated `.html` is opened in user's browser via `shell.openPath()`.
(b) Generated `.html` is shown inside PiPilot's WikiReaderPanel or a new
"Report" pane.
(a) is simpler; (b) is more integrated but adds UI work. I lean
**(a)** for v1, **(b)** for v2.

**Q6 — Suggested PR cut?**
- PR-A: `report-state.json` + status store + button state machine in
  LiteratureSidebar (no generation yet — button shows status, click
  shows "not yet implemented")
- PR-B: `lib/reports/` headless generator + `cmd:generate-paper-report`
  IPC + markdown/html renderers; button now generates real reports
- PR-C: auto-trigger enrichment after import, plus the HTML rich UX
  (TOC sidebar, cite-key anchors, popover linking to wiki)

Lean toward **3 PRs**; PR-A is small, validates the gating UX in
isolation. Sign off on the cut so I can start.

## 13. PR Roadmap (subject to Q6)

| PR | Title | Scope |
|---|---|---|
| **PR-A** | report status store + gated button UI | report-store.ts, LiteratureSidebar swap, no-op handler |
| **PR-B** | headless report generation + write artifacts | lib/reports/, IPC, prompts, md+html renderers |
| **PR-C** | enrichment auto-trigger + HTML polish | wizard tweak, HTML cite-anchor + TOC, regenerate confirm |
