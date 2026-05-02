# Full-Text Retrieval: Unified Service for Paper Wiki + Agent Tools

> Spec version: 0.2 (DRAFT — incorporating review-round-1 feedback) | Last updated: 2026-05-02 | Author: dialogue with Captain

## 1. Summary

Add a single, shared full-text retrieval service that backs both:

1. The **Paper Wiki** background indexer (currently arXiv-only via local PDF download + `markitdown`).
2. A **new agent-facing tool `fetch-fulltext`** the LLM can call in foreground conversations.

The service unifies three sources:

| Source | Coverage | Output |
|---|---|---|
| **arXiv** (existing, kept) | arXiv papers | local PDF → `markitdown` → markdown |
| **Paperclip** (new, hosted MCP) | bioRxiv + medRxiv + PubMed Central + arXiv | network call → section-aware markdown |
| **Unpaywall** (new, fallback) | any DOI with an open-access copy | OA PDF URL → `markitdown` |

The motivating gap: **the Paper Wiki currently has no full-text path for any non-arXiv paper.** Roughly half of biomedical work never appears on arXiv, so for those papers the wiki produces summaries from the abstract alone — visibly worse pages, and the user has no way to upgrade them.

## 2. Design Axiom

> **The full-text service is a side road, not the highway.**
> Search remains the highway. The wiki state machine remains authoritative for paper-level lifecycle. The new service plugs in *under* both, swaps in cleaner fulltext when available, and silently degrades when not.

Concrete commitments derived from this axiom:

- **No new state machine.** We extend the existing `FulltextStatus` enum and watermark fields; we do not introduce a parallel lifecycle.
- **No new global cache directory.** We extend `<wiki-root>/raw/` and `<wiki-root>/converted/` to host new sources, keeping the wiki as the canonical cache home.
- **No semantic-hash changes.** Adding a new fulltext source must NOT trigger a `semantic-change` rescan. (Constraint 3.4 — it must be tested.)
- **Graceful degradation.** Network failures, missing API keys, and uncovered papers must produce the same `abstract-fallback` / `abstract-only` outcomes the system already handles.
- **Foreground & background share one implementation.** Both paths go through the same `resolveFulltext()` entry point, the same cache, the same rate gates.

## 3. Hard Constraints (from the System Survey)

These came out of the cross-system survey and are non-negotiable. The design below was shaped to fit them.

**3.1 — `fulltextPath` is informational, not operational.**
The `PaperArtifact.fulltextPath` field exists today (`lib/types.ts`) but the wiki generator does not read fulltext from it; it gets fulltext from `downloadAndConvertArxiv()`'s return value. We can update `fulltextPath` for record-keeping but cannot reroute the wiki through it without a deeper refactor.

**3.2 — Hash schema V2 already excludes lens fields.**
A prior incident (V1 → V2 migration) burned the team when lens fields polluted the semantic hash. The hash today covers only canonical paper fields (`title`, `authors`, `abstract`, `year`, `venue`, `doi`, `arxivId`). New fulltext-source metadata MUST live outside the hash. (`lib/wiki/types.ts` — `computeSemanticHash`.)

**3.3 — `FulltextStatus` is asymmetric, but its *semantics* must broaden.**
The state machine can only upgrade `abstract-fallback → fulltext`, never downgrade or switch sources — we keep that direction. **However**, the *meaning* of `abstract-fallback` changes from "arXiv download failed, retryable" to "**any fulltext source is potentially available, retryable**". Without this broadening, a DOI-only biomedical paper (no arXiv ID) lands in terminal `abstract-only` on first miss and never gets upgraded — silently defeating the whole point of adding Paperclip. The 3-state enum stays; only the trigger predicate widens (§5.6).

**3.4 — `fulltext-upgrade` retries are arxivId-gated.**
Today: `scanner.ts:294-301` re-queues a paper for upgrade only if `arxivId && isValidArxivId(arxivId) && canRetryFulltext(watermark)`. Adding Paperclip means this gate must also accept "has DOI or pubmedId AND PAPERCLIP_API_KEY available." We will widen the predicate, not invent a new reason.

**3.5 — Sibling propagation must NOT propagate fulltextPath.**
`agent.ts:277-288` propagates a freshly-resolved `arxivId` to the same paper's artifacts in sibling projects to keep canonical keys aligned. This logic must NOT be extended to `fulltextPath`. Fulltext is a project-local convenience; siblings can each fetch their own copy (cache hit will be free).

**3.6 — Wiki retry backoff is per-canonical-key, not per-source.**
`canRetryFulltext()` reads `lastFulltextTryAt` and `fulltextFailures` from the watermark. If we treat "tried arXiv, failed" and "tried Paperclip, failed" as separate counters, the watermark schema bloats. We instead treat the backoff as **"tried any source, all failed"** — the retry attempts the next-best uncached source on each tick.

**3.7 — Markitdown is a hard dependency on the arXiv path only.**
Paperclip returns markdown directly; no markitdown needed. The wiki's existing markitdown failure mode (silently → `abstract-fallback`) is preserved for arXiv. Paperclip is a partial workaround for the markitdown-not-installed scenario — biomedical papers will succeed even without it.

**3.8 — API keys are stored plaintext.**
`PAPERCLIP_API_KEY` will be added to the existing `~/.research-copilot/config.json` plumbing alongside `BRAVE_API_KEY` etc. Same security model as today; documented but not changed.

**3.9 — `pmcId` is a missing first-class identifier and must be added.**
For biomedical papers, **PMC ID is the most reliable handle** — Paperclip's `lookup pmc PMC6130889` succeeds where `lookup doi 10.1038/nbt.4194` for the same paper failed in our probe (some DOIs aren't indexed in Paperclip's DOI table even when the PMC body is). The current `PaperArtifact` (lib/types.ts) has `arxivId`, `doi`, `pubmedId`, `semanticScholarId` but **no `pmcId`**. Without persisting it, every wiki scan would re-derive PMC IDs from PubMed lookups, and dispatch in §5.3 would lose its strongest biomedical match. **v0.1 must add `pmcId?: string` to PaperArtifact and populate it from search/enrichment paths** before Paperclip integration is meaningful. See §5.7 for population strategy and §6 for the schema diff.

## 4. Background: Existing Full-Text Touchpoints

(Distilled from the system survey. Each item here is something the new service must respect or extend.)

**Storage**

- `PaperArtifact` (lib/types.ts:90-121): has `doi`, `arxivId`, `pubmedId`, `semanticScholarId`, `fulltextPath` already. **No schema change required.**
- Per-project paper artifacts in `.research-pilot/artifacts/papers/`. Independent across projects.
- Wiki cache: `<wiki-root>/raw/arxiv/<safeId>.pdf` + `<wiki-root>/converted/<safeId>.md`. (`<wiki-root>` = `~/.research-pilot/paper-wiki`.)

**Wiki lifecycle**

- `lib/wiki/scanner.ts` enumerates project artifacts, computes canonical keys (`doi:` > `arxiv:` > `title+year:`), produces `ScanResult[]` with one of 6 reasons (`new`, `semantic-change`, `fulltext-upgrade`, `generator-bump`, `provenance-only`, `repair`).
- `lib/wiki/agent.ts` (`processPaper`) consumes scan results, calls `resolveArxivIdByTitle` if needed, calls `downloadAndConvertArxiv`, generates a wiki page, writes a sidecar with `source_tier` ∈ `{metadata-only, abstract-only, fulltext}`.
- `lib/wiki/io.ts` writes `ProcessedEntry` watermarks: `{canonicalKey, slug, semanticHash, fulltextStatus, generatorVersion, processedAt, hashSchemaVersion?, fulltextFailures?, lastFulltextTryAt?}`.
- Backoff: 1h → 2h → 4h → 8h → 24h, max 5 failures, then terminal.

**Mentions & retrieval**

- `lib/mentions/resolver.ts` resolves `@paper:` to `Title + Authors + Year + CiteKey + Abstract`. **Does not currently surface fulltext.**
- `lib/wiki/wiki-tools.ts` exposes 6 tools (`wiki_search`, `wiki_get`, `wiki_coverage`, `wiki_facets`, `wiki_neighbors`, `wiki_source`). `wiki_source` returns paths to underlying artifacts including any cached fulltext.
- Coordinator system prompt (lines 126-132) already directs the agent to use `wiki_source` for "exact quotes, precise numbers, or cross-paper comparisons."

**Other consumers of converted markdown**

- `lib/tools/convert-document.ts` — chat attachments / file uploads. Caches under `.research-pilot/cache/documents/`. **Different cache from wiki.**
- `lib/mentions/document-cache.ts` — same cache as above.

These two stay untouched; this RFC does not unify chat-attachment cache with wiki cache (they have different invalidation semantics).

## 5. Proposed Architecture

### 5.1 Module Layout

```
lib/fulltext/                          (NEW)
├── index.ts            public API: resolveFulltext({...}) → FulltextResult
├── paperclip.ts        Paperclip MCP fetcher (lookup + cat sections)
├── arxiv.ts            arXiv PDF fetch + markitdown convert
│                       (logic moved verbatim from lib/wiki/downloader.ts)
├── unpaywall.ts        Unpaywall DOI → OA URL → markitdown convert
├── cache.ts            shared local cache w/ index.json reverse map
└── types.ts            FulltextRequest, FulltextResult, FulltextSource

lib/wiki/downloader.ts                 (RETAINED, becomes thin wrapper)
└── re-exports resolveArxivIdByTitle() and downloadAndConvertArxiv()
    that now delegate to lib/fulltext

lib/tools/fetch-fulltext.ts            (NEW) agent-facing tool
```

### 5.2 Public API

```typescript
// lib/fulltext/types.ts
export type FulltextSource = 'paperclip' | 'arxiv' | 'unpaywall'

export interface FulltextRequest {
  doi?: string                  // canonical key when available
  arxivId?: string              // bare id (e.g. "2301.12345"), no version
  pmcId?: string                // e.g. "PMC6130889"
  pubmedId?: string             // e.g. "29969439"
  title?: string                // last-resort: arXiv title-resolve
  year?: number                 // disambiguates title-resolve
  sections?: string[]           // optional: only fetch named sections (Paperclip)
  preferSource?: FulltextSource // optional priority hint; defaults to dispatch order
}

export interface FulltextResult {
  markdown: string              // converted body, source-agnostic
  source: FulltextSource
  cachePath: string             // absolute path to the cached .md
  sections?: Record<string,string>  // present iff source='paperclip' and sections requested
  sectionList?: string[]        // names of available sections (Paperclip only)
  fetchedAt: string             // ISO timestamp
}

export async function resolveFulltext(
  req: FulltextRequest
): Promise<FulltextResult | null>
```

`resolveFulltext` returns `null` if no source produced fulltext (network/auth failure, paper not in any corpus, API key absent). Callers must handle null.

### 5.3 Source Dispatch Order

```
                   ┌────────────────────────────────────────────────┐
                   │   resolveFulltext(req)                          │
                   └─────────────────┬──────────────────────────────┘
                                     │
              ┌──────────────────────┴───────────────────────────┐
              │ 1. cache.lookup(req) — by doi/pmcId/arxivId/title │
              │    → if hit, return immediately                   │
              └──────────────────────┬───────────────────────────┘
                                     │ miss
              ┌──────────────────────┴───────────────────────────┐
              │ 2. PAPERCLIP                                      │
              │    eligibility: PAPERCLIP_API_KEY set             │
              │                AND (pmcId OR doi OR arxivId)      │
              │    on success: cache + return                     │
              │    on miss/fail: log, continue                    │
              └──────────────────────┬───────────────────────────┘
                                     │ miss
              ┌──────────────────────┴───────────────────────────┐
              │ 3. ARXIV (existing path)                          │
              │    eligibility: arxivId valid                     │
              │                OR (title resolve succeeds)        │
              │    on success: cache + return                     │
              │    on fail: log, continue                         │
              └──────────────────────┬───────────────────────────┘
                                     │ miss
              ┌──────────────────────┴───────────────────────────┐
              │ 4. UNPAYWALL                                      │
              │    eligibility: doi present                       │
              │    behavior: query Unpaywall, follow OA URL,      │
              │              markitdown the PDF                   │
              │    on success: cache + return                     │
              │    on fail: log, return null                      │
              └──────────────────────┬───────────────────────────┘
                                     │
                                  ┌──┴──┐
                                  │ null │
                                  └──────┘
```

**Why Paperclip first?** When available, it returns clean section-aware markdown without `markitdown` overhead, and covers four sources at once. When unavailable (no API key, paper not in their corpus), the existing arXiv path is unchanged.

`preferSource` overrides the order — useful for the `fetch-fulltext` tool when the agent has a specific reason (e.g., the paper is on arXiv and the agent wants the formal version, not a Paperclip preprint copy).

### 5.4 Cache Layout

```
<wiki-root>/                                (= ~/.research-pilot/paper-wiki)
├── raw/
│   ├── arxiv/<safeArxivId>.pdf            (existing)
│   └── paperclip/<paperId>.json           (new — raw MCP response)
├── converted/
│   ├── arxiv/<safeArxivId>.md             (existing layout, now nested)
│   ├── paperclip/<pmcOrBio>.md            (new)
│   └── unpaywall/<doiSafe>.md             (new)
├── index.json                              (new)
└── pages/                                  (existing — wiki page bodies)
```

`index.json` is a flat reverse-lookup map:

```json
{
  "doi:10.1038/nbt.4194":      "converted/paperclip/PMC6130889.md",
  "pmc:PMC6130889":            "converted/paperclip/PMC6130889.md",
  "arxiv:2404.18021":          "converted/arxiv/2404.18021.md",
  "doi:10.48550/arxiv.2404.18021": "converted/arxiv/2404.18021.md"
}
```

Multiple identifiers can point to the same cache file (e.g., a paper has both a DOI and a PMC ID). Cache is content-addressed by source's canonical paper ID, then aliased by `index.json` for reverse lookup from any input identifier.

**Cache invalidation:** none in v0.1. Explicit `cache.clear(req)` API for future use; no TTL. (Open question §11.4.)

**Existing `<wiki-root>/converted/<id>.md` files** (flat layout from current code) get migrated lazily: `cache.lookup` checks both the new nested path and the legacy flat path. Old files are not moved.

### 5.5 State Machine Extension — Provenance vs. Evidence Tier

**No new states. Crucially: `source_tier` and `fulltextSource` are kept orthogonal.**

The two fields answer different questions and must not be conflated:

| Field | Question it answers | Domain |
|---|---|---|
| `source_tier` | *How strong is the evidence backing this wiki page?* | `'metadata-only' \| 'abstract-only' \| 'fulltext'` — **unchanged from today** |
| `fulltextSource` | *Which provider supplied the fulltext (when present)?* | `'paperclip' \| 'arxiv' \| 'unpaywall' \| undefined` — **NEW** |

This split was a review-round-1 correction. An earlier draft of this RFC merged provenance into `source_tier` (`fulltext-arxiv`, `fulltext-paperclip`, …). That breaks every existing parser, indexer, sidecar reader, and wiki filter that switches on `source_tier`. Keep them orthogonal.

#### 5.5.1 Watermark schema

```typescript
// lib/wiki/types.ts — ProcessedEntry (existing fields + ONE new)
interface ProcessedEntry {
  canonicalKey: string
  slug: string
  semanticHash: string
  fulltextStatus: FulltextStatus              // unchanged: 'fulltext' | 'abstract-only' | 'abstract-fallback'
  generatorVersion: number
  processedAt: string
  hashSchemaVersion?: number
  fulltextFailures?: number
  lastFulltextTryAt?: string
  fulltextSource?: FulltextSource             // NEW. Optional. undefined = legacy/unknown.
}
```

`fulltextSource` is not part of the canonical key, not part of the semantic hash, and is set only when `fulltextStatus === 'fulltext'`. It is additive metadata used by:

- Wiki UI: small badge on each wiki page indicating source.
- Backfill / observability: count `arxiv` vs `paperclip` vs `unpaywall` coverage.
- Future cache invalidation: target a single source for forced refresh.

#### 5.5.2 Wiki sidecar schema

The wiki page sidecar (`<!-- WIKI-META -->` JSON block) keeps `source_tier` exactly as today. We add **one** new field next to it:

```jsonc
{
  "schemaVersion": 3,
  "source_tier": "fulltext",                  // unchanged enum
  "fulltext_source": "paperclip",             // NEW. Present iff source_tier=="fulltext".
  // ... rest unchanged
}
```

Existing pages without `fulltext_source` are valid (treated as "fulltext, source unknown"). Old parser code reading `source_tier` continues to work without modification.

### 5.6 Predicate for `fulltext-upgrade` Retry — and the Symmetric Initial Decision

Two predicates change, not one. Both must use the **same** function or DOI-only biomedical papers will be silently terminal.

#### 5.6.1 Initial classification (`generator.ts`)

Today:

```typescript
const hasRealArxiv = artifact.arxivId && isValidArxivId(artifact.arxivId)
const fulltextStatus: FulltextStatus = fulltext
  ? 'fulltext'
  : (hasRealArxiv ? 'abstract-fallback' : 'abstract-only')
```

Proposed:

```typescript
const fulltextStatus: FulltextStatus = fulltext
  ? 'fulltext'
  : (hasAnyFulltextSource(artifact, settings) ? 'abstract-fallback' : 'abstract-only')
```

This is the review-round-1 fix for issue 3. Without it, a fresh PMC paper with no arXiv ID lands in `abstract-only` (terminal) on first scan and never gets retried via Paperclip — even though Paperclip is exactly the source that would have succeeded.

#### 5.6.2 Retry trigger (`scanner.ts:294-301`)

Today:

```typescript
} else if (
  watermark.fulltextStatus === 'abstract-fallback' &&
  artifact.arxivId && isValidArxivId(artifact.arxivId) &&
  canRetryFulltext(watermark)
) { toProcess.push({ ...base, reason: 'fulltext-upgrade' }) }
```

Proposed:

```typescript
} else if (
  watermark.fulltextStatus === 'abstract-fallback' &&
  hasAnyFulltextSource(artifact, settings) &&
  canRetryFulltext(watermark)
) { toProcess.push({ ...base, reason: 'fulltext-upgrade' }) }
```

#### 5.6.3 Shared eligibility function

```typescript
// lib/fulltext/index.ts — exported for use by both scanner.ts and generator.ts
export function hasAnyFulltextSource(a: PaperArtifact, s: Settings): boolean {
  if (a.arxivId && isValidArxivId(a.arxivId)) return true
  if (s.paperclipApiKey && (a.doi || a.pmcId || a.pubmedId)) return true
  if (a.doi) return true   // unpaywall fallback
  return false
}
```

#### 5.6.4 Backoff coordination

Backoff state (`fulltextFailures`, `lastFulltextTryAt`) remains **per-canonical-key, not per-source** (constraint 3.6). A retry tries Paperclip → arXiv → Unpaywall in dispatch order; an all-fail bumps the counter once. (Open question §11.6 → resolved as "1 budget consumed per tick.")

**3.6 enforcement:** if Paperclip succeeds where arXiv would have failed (e.g., paper has DOI but no arxivId), backoff state is *consumed* — `markFulltextFailure` is not called. The wiki transitions `abstract-fallback → fulltext` cleanly and resets the failure counter on success (existing behavior preserved).

### 5.7 Settings, API Key, and the `pmcId` Schema Addition

#### 5.7.1 API key plumbing

Add `PAPERCLIP_API_KEY` to:

| File | Change |
|---|---|
| `shared-electron/ipc-base.ts` | append to `API_KEY_NAMES` const |
| `app/src/renderer/components/settings/ApiKeysSettings.tsx` | append to `KEY_FIELDS` array, label "Paperclip", help text "Biomedical & arXiv full-text via DOI/PMC ID. Free key at paperclip.gxl.ai" |
| `lib/tools/types.ts` | extend `ResolvedSettings` with `paperclipApiKey?: string` |
| `lib/fulltext/paperclip.ts` | reads `process.env.PAPERCLIP_API_KEY` (or `ctx.getSettings().paperclipApiKey`) |

This mirrors the `BRAVE_API_KEY` pattern exactly.

#### 5.7.2 `pmcId` first-class identifier (constraint 3.9)

**Schema diff (lib/types.ts):**

```typescript
interface PaperArtifact extends ArtifactBase {
  // ... existing fields ...
  arxivId?: string
  pubmedId?: string
  pmcId?: string                              // NEW. e.g. "PMC6130889" (with prefix)
  semanticScholarId?: string
  // ...
}
```

**Population paths** (must all be wired in v0.1):

| Source | Where to populate | How |
|---|---|---|
| Semantic Scholar API | `searchSemanticScholar()` in `literature-search.ts:119-149` | Add `'externalIds'` already in fields list — extract `externalIds.PubMedCentral` (returns `"PMC6130889"`) |
| OpenAlex | `searchOpenAlex()` in `literature-search.ts:194-228` | OpenAlex returns `pmcid` field on `ids` object (e.g. `"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6130889"`); strip prefix |
| Paperclip lookup | `lib/fulltext/paperclip.ts` | When we successfully `lookup pmc <id>` or `lookup doi <doi>`, write the resolved `pmcId` back into the artifact via `upsertPaperArtifact` |
| Manual user entry | future — not in this RFC | — |

**Sibling propagation:** `pmcId` IS propagated to sibling artifacts (same as `arxivId` today, agent.ts:277-288). It's a stable external identifier, not project-local state. Add to the propagation block.

**Upsert function (`commands/paper-artifact.ts`):** `pmcId?: string` added to the `opts` parameter and persisted alongside other identifiers. Dedup logic unchanged (still keys on `doi || citeKey || title+year`).

This is non-trivial work but unavoidable — without `pmcId` as a first-class identifier, Paperclip's strongest matching path (the `lookup pmc` command) would not be reachable from a wiki rescan and the integration's biomedical value would collapse to "DOIs that happen to be in Paperclip's DOI table" (a much smaller set than papers in their PMC corpus).

### 5.8 Agent Tool: `fetch-fulltext` — Metadata-First by Default

A naive default of "return up to 80 000 chars of body" floods the agent's context with material it usually doesn't need. The reviewer flagged this directly. Default behavior is now **metadata + section list + cache path**; body is opt-in.

```typescript
// lib/tools/fetch-fulltext.ts
{
  name: 'fetch-fulltext',
  label: 'Fetch Full Text',
  description:
    'Retrieve metadata, section listing, and (optionally) body of a paper. ' +
    'Tries Paperclip (section-aware biomedical/arXiv) first, then arXiv direct, ' +
    'then Unpaywall for open-access copies. Default mode returns metadata + ' +
    'section list + cache path so the agent can decide which section to read ' +
    'next. Pass `sections=[...]` for specific sections, or `mode="body"` for ' +
    'the full body.',
  parameters: Type.Object({
    doi:      Type.Optional(Type.String()),
    arxiv_id: Type.Optional(Type.String()),
    pmc_id:   Type.Optional(Type.String()),
    title:    Type.Optional(Type.String()),
    year:     Type.Optional(Type.Integer()),

    mode: Type.Optional(Type.Union([
      Type.Literal('metadata'),   // DEFAULT. Metadata + section list + cache path. No body bytes.
      Type.Literal('sections'),   // Implied when `sections=[...]` is non-empty.
      Type.Literal('body')        // Full body, capped by max_chars.
    ], { default: 'metadata' })),

    sections: Type.Optional(Type.Array(Type.String(), {
      description: 'Section names (Paperclip only, fuzzy-matched). Setting this implies mode="sections".'
    })),

    max_chars: Type.Optional(Type.Integer({
      default: 40_000,                       // halved from earlier draft
      description: 'Cap on returned body bytes. Only applies when mode="body" or mode="sections".'
    })),

    prefer_source: Type.Optional(Type.Union([
      Type.Literal('paperclip'), Type.Literal('arxiv'), Type.Literal('unpaywall')
    ]))
  }),
}
```

**Default-mode return shape** (`mode='metadata'`):

```jsonc
{
  "metadata": {
    "title": "...",
    "authors": ["..."],
    "year": 2018,
    "venue": "...",
    "doi": "10.1038/nbt.4194",
    "pmc_id": "PMC6130889",
    "arxiv_id": null,
    "abstract": "...",
    "fulltext_available": true               // if any source returned content
  },
  "sections": ["Title", "Abstract", "Online Methods", "Cell culture, ...", "Statistics", ...],
                                             // present if Paperclip succeeded
  "cache_path": "<wiki-root>/converted/paperclip/PMC6130889.md",
                                             // absolute path; agent can use Read tool to view it
  "source": "paperclip",
  "fetched_at": "2026-05-02T20:15:00Z",
  "next_actions": [                          // hint to the agent about cheap follow-ups
    "Call fetch-fulltext again with sections=['Online Methods'] to read just the methods.",
    "Or use the Read tool on cache_path to view the full converted markdown."
  ]
}
```

Body-modes return shape (`mode='sections'` or `mode='body'`):

```jsonc
{
  "metadata": { ... },
  "body": "...markdown...",                  // present (truncated to max_chars if needed)
  "sections_returned": { "Methods": "..." }, // present in mode='sections'
  "sections_unmatched": ["typo-name"],       // names that didn't match any actual section
  "truncated": false,                        // true when max_chars hit
  "cache_path": "...",
  "source": "paperclip",
  "fetched_at": "..."
}
```

**Why this default is better** (from the reviewer's framing):

- The metadata response is small (~1 KB), so the agent can call it speculatively for many papers without bloating context.
- The `sections` array exposes Paperclip's most differentiated capability — the agent learns *what is available* before deciding *what to read*.
- `cache_path` lets the agent fall through to the Read tool for ad-hoc inspection without re-fetching.

**Coordinator prompt addition** (after the existing wiki guidance, around line 132 of `lib/agents/prompts/index.ts`):

```
After literature-search, when an abstract is not sufficient (extracting
methods, comparing baselines, quoting specific results):

  1. Call fetch-fulltext with mode='metadata' (the default) to learn
     which sections are available and confirm fulltext exists.
  2. Then call fetch-fulltext again with sections=['Methods', ...] for
     just the sections you need.

Avoid mode='body' unless you genuinely need the whole paper — section
reads are cheaper and more focused. Results are cached and shared with
the paper wiki, so the wiki entry will upgrade on next scan.
```

### 5.9 Wiki Agent Integration

`lib/wiki/agent.ts:304-308` becomes:

```typescript
// existing
let fulltext: string | null = null
if (resolvedArxivId && isValidArxivId(resolvedArxivId)) {
  fulltext = await downloadAndConvertArxiv(resolvedArxivId)
}

// NEW (additive — only runs if existing path missed)
let fulltextSource: FulltextSource | undefined = fulltext ? 'arxiv' : undefined
if (!fulltext) {
  const result = await resolveFulltext({
    doi: artifact.doi,
    arxivId: resolvedArxivId ?? undefined,
    pmcId: artifact.pmcId,
    pubmedId: artifact.pubmedId,
  })
  if (result) {
    fulltext = result.markdown
    fulltextSource = result.source            // for watermark + sidecar
  }
}
```

`downloadAndConvertArxiv()` retained as a thin wrapper (calls `resolveFulltext({arxivId})`) so that **existing callers and tests don't break.** The wiki agent now has two entry points — explicit arXiv-first (back-compat) and unified (new). Over time the explicit branch can be removed.

### 5.10 `wiki_source` Tool — Cache Index Integration (review-round-1 issue 5)

`wiki_source(slug)` is the existing tool the coordinator is told to use *"when you need exact quotes, precise numbers, or cross-paper comparisons"* (`lib/agents/prompts/index.ts:130`). It returns paths to underlying paper artifacts including any cached fulltext. The whole "wiki memory is derived summary, not source evidence" closed-loop in the prompt rests on this tool surfacing the same fulltext the agent could have fetched directly.

**Without this section, the closed loop breaks.** A user-uploaded chat PDF currently surfaces via the existing `fulltextPath` field. An arXiv paper surfaces via `<wiki-root>/converted/<id>.md`. But a Paperclip- or Unpaywall-sourced paper would land in `<wiki-root>/converted/paperclip/...` or `.../unpaywall/...` — a path `wiki_source` doesn't currently know how to resolve.

**Required change to `lib/wiki/wiki-tools.ts`:**

`wiki_source` must consult the new `cache.index.json` (§5.4) to resolve fulltext paths regardless of source:

```typescript
// pseudocode for the relevant branch in wiki_source
const cacheLookup = await fulltextCache.lookup({
  doi: artifact.doi,
  arxivId: artifact.arxivId,
  pmcId: artifact.pmcId,
  pubmedId: artifact.pubmedId,
})

return {
  artifactPath: ...,
  pdfPath: ...,                                 // unchanged — only arXiv path has PDF
  fulltextPath: cacheLookup?.cachePath ?? null, // now finds Paperclip + Unpaywall too
  fulltextSource: cacheLookup?.source ?? null,  // NEW field in the response
  sectionList: cacheLookup?.sectionList ?? null,// Paperclip only
}
```

The response schema gains `fulltextSource` and `sectionList` fields; existing `fulltextPath` field semantics widen but signature is unchanged for back-compat.

**Implication for §6 component change list**: `lib/wiki/wiki-tools.ts` must be added to the modify list (~+25 lines). See the updated table.

## 6. Component-Level Change List

(Concrete diffs — line counts approximate, intended for review.)

| # | File | Action | Lines | Risk |
|---|---|---|---|---|
| 1 | `lib/fulltext/index.ts` | NEW — public `resolveFulltext()` + dispatch | ~80 | new |
| 2 | `lib/fulltext/paperclip.ts` | NEW — MCP HTTP client, text-output parser, section fetch | ~150 | new |
| 3 | `lib/fulltext/arxiv.ts` | MOVE — verbatim from `lib/wiki/downloader.ts` | ~100 | semantics-preserving move |
| 4 | `lib/fulltext/unpaywall.ts` | NEW — DOI → OA URL → markitdown | ~60 | new |
| 5 | `lib/fulltext/cache.ts` | NEW — index.json + nested dirs + lookup | ~120 | new |
| 6 | `lib/fulltext/types.ts` | NEW — types | ~30 | new |
| 7 | `lib/wiki/downloader.ts` | REWRITE — delegate to `lib/fulltext` | -125 / +30 | low (pure delegation) |
| 8 | `lib/wiki/types.ts` | EXTEND — `ProcessedEntry.fulltextSource?: FulltextSource` | +2 | low |
| 9 | `lib/wiki/scanner.ts` | EXTEND — `hasAnyFulltextSource` in upgrade predicate | +15 | medium (touches scan logic) |
| 10 | `lib/wiki/agent.ts` | EXTEND — additive Paperclip fallback after arXiv attempt | +20 | medium (touches main flow) |
| 11 | `lib/wiki/generator.ts` | EXTEND — `fulltextStatus` decision uses `hasAnyFulltextSource`; sidecar adds `fulltext_source` field | +10 | low |
| 12 | `lib/wiki/wiki-tools.ts` | EXTEND — `wiki_source` consults fulltext cache index, returns `fulltextSource` + `sectionList` | +25 | medium (touches retrieval contract) |
| 13 | `lib/tools/fetch-fulltext.ts` | NEW — agent tool, metadata-default | ~180 | new |
| 14 | `lib/tools/index.ts` | REGISTER — add to `createResearchTools()` | +3 | trivial |
| 15 | `lib/tools/types.ts` | EXTEND — `ResolvedSettings.paperclipApiKey?` | +1 | trivial |
| 16 | `lib/agents/prompts/index.ts` | EXTEND — coordinator prompt: metadata-first guidance | +10 | low |
| 17 | `shared-electron/ipc-base.ts` | EXTEND — `API_KEY_NAMES` adds `PAPERCLIP_API_KEY` | +1 | trivial |
| 18 | `app/src/renderer/components/settings/ApiKeysSettings.tsx` | EXTEND — `KEY_FIELDS` adds Paperclip entry | +6 | trivial |
| 19 | `lib/types.ts` | **EXTEND — `PaperArtifact.pmcId?: string`** | +1 | low |
| 20 | `lib/commands/paper-artifact.ts` | EXTEND — `pmcId` in `opts`, persistence, dedup unchanged | +10 | low |
| 21 | `lib/tools/literature-search.ts` | EXTEND — extract `pmcId` from S2 (`externalIds.PubMedCentral`) and OpenAlex (`ids.pmcid`); pass to upsert | +20 | low |
| 22 | `lib/wiki/agent.ts` (sibling propagation block, lines 277-288) | EXTEND — propagate `pmcId` alongside `arxivId` | +15 | low |
| 23 | `lib/wiki/hash-isolation.test.ts` | EXTEND — `pmcId` not in hash; `fulltextSource` change doesn't trigger semantic-change | +40 | low (test-only) |
| 24 | `lib/fulltext/index.test.ts` | NEW — dispatch, cache hit, all-fail, section fuzzy, `hasAnyFulltextSource` matrix | ~180 | new (test-only) |
| 25 | `README.md` + `docs/wiki/Paper-Wiki.md` | UPDATE — describe Paperclip integration, pmcId field | ~30 | docs |

**Total**: ~1 050 lines of code (incl. ~220 lines of tests), 14 modified files, 7 new files.

**Net delta vs. spec v0.1**: +180 lines from the pmcId schema work (rows 19-22) and the `wiki_source` patch (row 12). These are **non-optional** consequences of review-round-1 issues 2 and 5; without them the integration loses biomedical reach (no PMC ID matching) or evidence reach (`wiki_source` can't surface Paperclip cache).

**Files we're explicitly NOT touching:** `lib/mentions/resolver.ts`, `lib/tools/convert-document.ts`, `lib/mentions/document-cache.ts`, `app/src/main/ipc.ts`, `lib/memory-v2/*`, all skill markdown files. Future RFCs can extend mentions to surface fulltext (§10.1) and skills to recommend `fetch-fulltext` (§10.2).

## 7. Behavioral Specifications

### 7.1 Cache hit semantics

`cache.lookup` resolves any of: `doi`, `arxivId` (bare or full), `pmcId`, `pubmedId`. All four are first-class lookup keys (constraint 3.9). Returns the same cache entry regardless of which identifier was used; `index.json` aliases all known identifiers of a paper to the same cache file. `arxivId` matching strips version suffix (`v2`). `pmcId` matching is case-insensitive on the `PMC` prefix.

### 7.2 Network failure handling

| Failure | Source | Action |
|---|---|---|
| 401/403 | Paperclip | Log "PAPERCLIP_API_KEY invalid"; skip source for entire process lifetime; surface to user via wiki status |
| 404 / "No papers found" | Paperclip | Log; continue to next source |
| 429 | Paperclip | Wait, retry once with exponential backoff (1s, 4s); then continue to next source |
| 5xx | Paperclip | Log; continue to next source (do not retry; let backoff handle next pass) |
| Network timeout (>15s) | any | Log; continue to next source |
| Markitdown missing | arXiv / Unpaywall | Log "markitdown not installed"; continue to next source. Paperclip path remains usable. |

### 7.3 Section fuzzy match (Paperclip)

User passes `sections: ['methods']`. Paperclip's section names vary: `'Methods'`, `'Online Methods'`, `'Materials and Methods'`. Strategy:

1. List sections via `ls /papers/<id>/sections/`.
2. Match each requested name against actual section names: lowercase-token-overlap, longest-match-wins.
3. Return only matched sections in `result.sections[name]`. Unmatched names returned in `result.unmatchedSections[]` for the caller's benefit.
4. If `sections` is omitted, return `content.lines` as the body.

### 7.4 Unpaywall integration

```
GET https://api.unpaywall.org/v2/<doi>?email=<configured>
→ {best_oa_location: {url_for_pdf: "..."}}
→ download PDF
→ markitdown
```

Email parameter required by Unpaywall's TOS. Use `process.env.UNPAYWALL_EMAIL` if set, else fall back to a project-wide neutral address (Open question §11.3 — choose a value).

### 7.5 Wiki retry coordination

When the wiki processes a `fulltext-upgrade` for a paper:

1. Call `resolveFulltext` (cache lookup → Paperclip → arXiv → Unpaywall).
2. If returns a result:
   - Update wiki page (regenerate via `generatePaperPage`).
   - Set `processed.fulltextStatus = 'fulltext'`, `processed.fulltextSource = result.source`, clear `fulltextFailures`.
3. If returns null:
   - Existing behavior: `markFulltextFailure(canonicalKey)`. Bumps counter, increments `lastFulltextTryAt`. After 5 failures, terminal `abstract-only` (existing logic).

## 8. Cross-System Integration

### 8.1 Mentions (out of scope for v0.1, noted)

`@paper:smith2024novel` could surface fulltext when `fulltextPath` exists. This is a separate enhancement; the resolver currently sends only metadata + abstract. Recommended follow-up RFC. (Risk: token budget — fulltext is large.)

### 8.2 Skills (out of scope, noted)

- `paper-writing` could recommend `fetch-fulltext` during related-work assembly to ground specific quotes.
- `scholar-evaluation` could fetch full methods sections to assess methodology quality.
- `paper-revision` could fetch baselines' methods to compare claims.

These are skill-prompt edits, separate from this RFC.

### 8.3 Wiki page sidecar (this RFC)

The sidecar `source_tier` field is extended (§5.5). Existing pages with bare `source_tier: "fulltext"` are accepted as-is during scanner read-back (treated as "fulltext, source unknown"). Old pages are not regenerated for this change alone — the sidecar update is opportunistic when the page is regenerated for any other reason.

## 9. Test Plan

**Unit (new):**

1. `lib/fulltext/index.test.ts`
   - cache hit short-circuits dispatch
   - dispatch order respected (Paperclip → arXiv → Unpaywall)
   - `preferSource` overrides order
   - all sources fail → returns null
   - PAPERCLIP_API_KEY absent → Paperclip silently skipped
   - section fuzzy matching produces expected pairs
2. `lib/fulltext/cache.test.ts`
   - identifier aliasing (DOI + PMC ID hit same file)
   - legacy flat-layout files still resolved
3. `lib/fulltext/paperclip.test.ts`
   - text response parser extracts title/authors/source/date/DOI/abstract
   - error responses (401/404/429) classified correctly

**Regression (extend existing):**

4. `lib/wiki/hash-isolation.test.ts`
   - same paper, `fulltextSource` change (arXiv → Paperclip): semantic hash unchanged, `processedAt` updates, `fulltextStatus` may change but no `semantic-change` reason fires
   - `processedEntry.fulltextSource` round-trips through serialization

**Integration (manual, with live token):**

5. End-to-end via `fetch-fulltext` tool — search a known paper (PMC6130889), call tool, verify cache file written under `<wiki-root>/converted/paperclip/`, verify next wiki scan picks up the cached file as `fulltext-upgrade`.

## 10. Migration & Rollout

**Phase 0 — RFC review & sign-off** (this document).

**Phase 1 — `lib/fulltext/` skeleton + tests.** Ship the new modules with arXiv path as a verbatim move; wiki delegates to the new module. Behavior identical to today. Goal: zero-regression refactor lands first.

**Phase 2 — Paperclip + Unpaywall sources.** Ship `paperclip.ts` and `unpaywall.ts`. Wire `PAPERCLIP_API_KEY` plumbing. Wiki agent gains additive fallback. New papers in Paperclip's corpus get fulltext immediately.

**Phase 3 — `fetch-fulltext` agent tool + coordinator prompt.** Foreground access. Documented in README + wiki docs.

**Phase 4 — Backfill.** Optional one-shot script that walks all `abstract-only` wiki entries with DOI/PMC IDs and triggers a `fulltext-upgrade` rescan. Bypasses backoff timer once. (Open question §11.5.)

**Phase 5 (later RFC) — Mentions integration, skills updates.**

Each phase is a separate PR. Phase 1 must land green before Phase 2 starts.

## 11. Open Questions

**11.1 — Source priority for arXiv papers.**
Paperclip indexes arXiv. For a paper that's on both arXiv and Paperclip, we prefer Paperclip (cleaner section parsing). But the arXiv version is "official" and the Paperclip copy is derived. Is this OK, or should we always prefer arXiv direct for arXiv-first papers? **Proposed default: Paperclip first when API key present.** Easy to flip.

**11.2 — Backoff reset on enrichment.**
A paper in `abstract-fallback` with no DOI is later enriched (literature-search adds a DOI). Today the backoff timer is still active. Should adding a new identifier reset the failure counter? **Proposed: yes**, but adds enrichment-aware logic to the scanner. (Constraint 3.6 says backoff is per-canonical-key, but enrichment changes the eligibility set.)

**11.3 — Unpaywall email.**
TOS requires an email. Options: (a) hardcode `research-pilot@noreply.invalid` (not a real address but accepted by their endpoint), (b) reuse the user's git config email, (c) require explicit configuration. **Proposed: (a) by default**, override via `UNPAYWALL_EMAIL` env var.

**11.4 — Cache TTL.**
Paperclip papers can be revised; arXiv papers have versions. Currently no eviction. **Proposed: no TTL in v0.1**; revisit if users report stale content. Add `cache.purge({doi, olderThan})` API for future use without using it.

**11.5 — One-shot backfill.**
Should Phase 4 (backfill) be a CLI command? An auto-run on first launch after upgrade? Off-by-default? **Proposed: explicit CLI** (`npm run wiki:backfill-fulltext`), runs in background, idempotent. Auto-run feels intrusive.

**11.6 — Retry-budget semantics.**
Today: 5 failures = terminal. With 3 sources, a paper might fail Paperclip + arXiv + Unpaywall in one tick. Does that count as 1 failure or 3? **Proposed: 1** (one tick = one budget consumed regardless of how many sources tried).

**11.7 — `fetch-fulltext` token budget.** ✅ **RESOLVED (review-round-1):** default mode is `metadata` — returns metadata + section list + cache path only. Body returned only when `sections=[...]` or `mode='body'` is explicitly passed. `max_chars` default lowered from 80k to 40k. See §5.8.

**11.8 — Paperclip rate limits.**
Not documented. Reasonable: 1 req/s. If we batch wiki backfill, we may need a `ProviderRateGate` per `lib/tools/web-tools.ts`. **Proposed: reuse the existing `ProviderRateGate` class with a 1000ms interval**; tighten if Paperclip team specifies.

## 12. Risks

**R1 — Paperclip outage.** Hosted dependency. Mitigation: graceful degradation to arXiv path; Paperclip-only papers stay `abstract-fallback` until service returns. Documented in operator runbook.

**R2 — Paperclip changes API or auth model.** Their MCP server returns text not JSON; format could shift. Mitigation: paperclip.ts has small, well-isolated parser; one-file fix per change. Add a `paperclip-api-version-probe` test that runs against their live API in CI (gated by API key secret) to catch shifts early.

**R3 — markitdown unavailable** in user environments (already a risk). Mitigation: Paperclip path doesn't need markitdown, so biomedical papers continue to work; arXiv-only papers degrade as today. Logged loudly.

**R4 — Cache disk usage.** `<wiki-root>/raw/` and `converted/` grow unbounded. Mitigation: documented disk-cost; future TTL hook (§11.4).

**R5 — Wiki state-machine drift.** Adding a new fulltext source path is invasive on `agent.ts` flow. Mitigation: additive-only changes (no rewrites of existing branches), heavy test coverage on `hash-isolation.test.ts`.

## 13. Decision Log

| Date | Decision | Author | Rationale |
|---|---|---|---|
| 2026-05-02 | `source_tier` and `fulltextSource` kept orthogonal — provenance does NOT live inside `source_tier` | Captain (review-round-1) | Merging would break every existing parser/indexer/wiki filter that switches on `source_tier`. §5.5 split. |
| 2026-05-02 | `pmcId` added as first-class identifier on `PaperArtifact`; populated from S2 / OpenAlex / Paperclip lookup; propagated to siblings | Captain (review-round-1) | Without pmcId persistence, Paperclip's strongest matching path (`lookup pmc`) is unreachable from a wiki rescan. §3.9, §5.7.2. |
| 2026-05-02 | `abstract-fallback` semantics broaden from "arXiv retryable" to "any source retryable"; both initial classification (`generator.ts`) and retry trigger (`scanner.ts`) share `hasAnyFulltextSource` | Captain (review-round-1) | Otherwise DOI-only biomedical papers terminal-fail on first miss and never get Paperclip retry. §3.3, §5.6. |
| 2026-05-02 | `fetch-fulltext` defaults to `mode='metadata'`; body opt-in via `sections=[...]` or `mode='body'`; `max_chars` 80k → 40k | Captain (review-round-1) | Naive 80k-body default floods agent context for typical use cases; metadata + section list is far more useful as a first-pass response. §5.8, §11.7. |
| 2026-05-02 | `wiki_source` consults the new fulltext cache index; response gains `fulltextSource` and `sectionList` fields | Captain (review-round-1) | Without this, Paperclip-cached fulltext is invisible to the coordinator's "exact quotes / precise numbers" path, breaking the "wiki memory ≠ source evidence" closed loop. §5.10. |


## Appendix A — Paperclip MCP Probe Results (Verified 2026-05-02)

What we've actually tested against the live service:

```
POST https://paperclip.gxl.ai/mcp
Headers: X-API-Key: gxl_***   (NOT Authorization: Bearer)
         Content-Type: application/json
         Accept: application/json, text/event-stream

JSON-RPC:
  initialize        → 200, protocol 2025-03-26, name "paperclip" v1.0.0
  tools/list        → 1 tool: paperclip(command: string)
  tools/call        → returns content: [{ type:"text", text:"..." }]
```

**Verified shell-as-MCP commands that work:**

- `search "<q>" -n <N>` — hybrid search, returns formatted text
- `lookup pmc <PMC-ID>` — exact metadata lookup
- `lookup doi <DOI>` — exact metadata lookup (some DOIs not indexed)
- `ls /papers/<id>/sections/` — section file listing
- `cat /papers/<id>/meta.json` — clean JSON: doi, pmid, title, authors, abstract, journal, year, keywords
- `cat /papers/<id>/content.lines` — line-numbered full text
- `cat /papers/<id>/sections/<Name>.lines` — section-only full text

**Search output format (parser target):**

```
Found N papers  [s_<id>]

  <i>. <title>
       <authors>
       <source-id> · <source-name> · <date>
       https://doi.org/<doi>
       "<tldr>"
```

**Source IDs observed:** `bio_<hash>` (bioRxiv), `med_<hash>` (medRxiv), `PMC<id>` (PubMed Central), `arx_<id>` (arXiv).

**Sources confirmed:** PMC, bioRxiv, medRxiv, arXiv. (README claims biomedical-only but arXiv is included.)

**Negative results:**

- No `--json` or `--format` flag on `search`.
- No `arxiv` field on `lookup` (use `doi` or `title`).
- SQL queries split per source-table (bioRxiv, PMC, arxiv) with different columns.

## Appendix B — Files Surveyed

(Cited in §3 and §4; reproduced here for the reviewer's convenience.)

- `lib/types.ts` — PaperArtifact (§3.1, §4)
- `lib/commands/paper-artifact.ts` — upsertPaperArtifact (§4)
- `lib/wiki/types.ts` — FulltextStatus, ProcessedEntry, computeSemanticHash (§3.2, §3.3, §5.5)
- `lib/wiki/scanner.ts` — `fulltext-upgrade` predicate (§3.4, §5.6)
- `lib/wiki/agent.ts` — processPaper main loop (§5.9)
- `lib/wiki/downloader.ts` — `downloadAndConvertArxiv`, `resolveArxivIdByTitle` (§4, §5.1, §6 row 7)
- `lib/wiki/generator.ts` — `buildPaperUserContent` source-tier branching (§4, §5.5, §6 row 11)
- `lib/wiki/io.ts` — watermark persistence (§4)
- `lib/wiki/hash-isolation.test.ts` — V1/V2 invariants (§9 test 4)
- `lib/wiki/wiki-tools.ts` — 6 retrieval tools incl. `wiki_source` (§4)
- `lib/tools/literature-search.ts` — 4-source pipeline (§4)
- `lib/tools/index.ts` — `createResearchTools()` (§6 row 13)
- `lib/tools/types.ts` — ResolvedSettings (§5.7)
- `lib/tools/web-tools.ts` — `ProviderRateGate` (§11.8)
- `lib/tools/convert-document.ts` — markitdown CLI (§4 last bullet)
- `lib/mentions/resolver.ts` — paper mention shape (§4, §10.1)
- `lib/mentions/document-cache.ts` — separate cache (§4)
- `lib/agents/prompts/index.ts` — coordinator prompt, wiki prompts (§5.8, §6 row 15)
- `shared-electron/ipc-base.ts` — `API_KEY_NAMES` (§5.7, §6 row 16)
- `app/src/renderer/components/settings/ApiKeysSettings.tsx` — KEY_FIELDS UI (§5.7, §6 row 17)
