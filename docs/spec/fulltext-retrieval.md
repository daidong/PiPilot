# Full-Text Retrieval: Unified Service for Paper Wiki + Agent Tools

> Spec version: 0.3 (DRAFT — review-round-2: cuts and decisions) | Last updated: 2026-05-02 | Author: dialogue with Captain

## 1. Summary

Add a single, shared full-text retrieval service that backs both:

1. The **Paper Wiki** background indexer (currently arXiv-only via local PDF download + `markitdown`).
2. A **new agent-facing tool `fetch-fulltext`** the LLM can call in foreground conversations.

The service unifies two sources:

| Source | Coverage | Output |
|---|---|---|
| **Paperclip** (new, hosted MCP) | bioRxiv + medRxiv + PubMed Central + arXiv | network call → section-aware markdown |
| **arXiv** (existing, kept) | arXiv papers | local PDF → `markitdown` → markdown |

The motivating gap: **the Paper Wiki currently has no full-text path for any non-arXiv paper.** Roughly half of biomedical work never appears on arXiv, so for those papers the wiki produces summaries from the abstract alone — visibly worse pages, and the user has no way to upgrade them.

A third "open-access generic DOI" source (Unpaywall) was considered and **explicitly cut** for v0.1: we have no measured data on how many papers Paperclip + arXiv would miss but Unpaywall would catch. Phase 2 of this RFC reconsiders it with real `abstract-only` corpus measurements after the two-source service has been running.

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
├── index.ts            public API: resolveFulltext({...}) → FulltextResult | null
├── paperclip.ts        Paperclip MCP fetcher (lookup + cat sections + parse text)
├── arxiv.ts            arXiv PDF fetch + markitdown convert + title-resolve
│                       (logic moved from lib/wiki/downloader.ts, now reachable
│                        only through resolveFulltext)
├── cache.ts            local cache (pure path convention, no index file)
└── types.ts            FulltextRequest, FulltextResult, FulltextSource

lib/wiki/downloader.ts                 (DELETED)

lib/tools/fetch-fulltext.ts            (NEW) agent-facing tool
```

### 5.2 Public API

```typescript
// lib/fulltext/types.ts
export type FulltextSource = 'paperclip' | 'arxiv'

export interface FulltextRequest {
  doi?: string                  // canonical key when available
  arxivId?: string              // bare id (e.g. "2301.12345"), no version
  pmcId?: string                // e.g. "PMC6130889"
  pubmedId?: string             // e.g. "29969439"
  title?: string                // last-resort: arXiv title-resolve
  year?: number                 // disambiguates title-resolve
  sections?: string[]           // optional: only fetch named sections (Paperclip)
  preferSource?: FulltextSource // optional priority hint ('paperclip' | 'arxiv'); defaults to dispatch order
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
  resolveFulltext(req)
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ 1. cache.lookup(req)                        │
  │    → if hit, return immediately             │
  └─────────────────────────┬───────────────────┘
                            │ miss
                            ▼
  ┌─────────────────────────────────────────────┐
  │ 2. PAPERCLIP                                 │
  │    eligibility: PAPERCLIP_API_KEY set        │
  │                AND (pmcId OR doi OR arxivId) │
  │    success: cache + return                   │
  │    fail/miss: continue                       │
  └─────────────────────────┬───────────────────┘
                            │ miss
                            ▼
  ┌─────────────────────────────────────────────┐
  │ 3. ARXIV (existing path)                     │
  │    eligibility: arxivId valid                │
  │                OR (title resolve succeeds)   │
  │    success: cache + return                   │
  │    fail: return null                         │
  └─────────────────────────────────────────────┘
```

**Why Paperclip first?** Returns clean section-aware markdown without `markitdown` overhead and covers four upstream sources at once. When unavailable (no API key, paper not in corpus), the existing arXiv path runs unchanged.

`preferSource` overrides the order — useful for the `fetch-fulltext` tool when the agent has a specific reason (e.g., paper is on arXiv and the agent wants the formal version, not a Paperclip preprint copy).

### 5.4 Cache Layout — Pure Path Convention

```
<wiki-root>/                                (= ~/.research-pilot/paper-wiki)
├── raw/
│   ├── arxiv/<safeArxivId>.pdf            (existing)
│   └── paperclip/<paperclipId>.json       (new — raw MCP response, for debugging)
├── converted/
│   ├── arxiv/<safeArxivId>.md             (existing layout, now nested)
│   └── paperclip/<paperclipId>.md         (new)
└── pages/                                  (existing — wiki page bodies)
```

`<paperclipId>` is whatever ID Paperclip returned for that paper (typically `PMC<id>`, `bio_<hash>`, `med_<hash>`, or `arx_<id>`). The cache file name is the source's own canonical ID — no separate index file needed.

#### 5.4.1 Cache lookup is a path probe, not a database query

Given a `FulltextRequest` with whatever IDs the caller has, the lookup tries known paths in source-priority order:

```typescript
async function cacheLookup(req: FulltextRequest): Promise<CacheHit | null> {
  // Paperclip path tried first (matches dispatch order)
  if (req.pmcId) {
    const p = paperclipPath(req.pmcId)              // e.g. converted/paperclip/PMC6130889.md
    if (await exists(p)) return { path: p, source: 'paperclip' }
  }
  // Note: we do NOT try arbitrary doi -> paperclipId mapping here. If a caller
  // only has a DOI, dispatch falls through to Paperclip's lookup-by-doi
  // online; if it succeeds, the response includes the paperclipId and we
  // cache under that ID. Next call with the same DOI but with pmcId now
  // populated on the artifact will hit the cache.

  if (req.arxivId) {
    const p = arxivPath(stripVersion(req.arxivId))  // e.g. converted/arxiv/2404.18021.md
    if (await exists(p)) return { path: p, source: 'arxiv' }
  }

  return null
}
```

**Trade-off accepted**: a caller who has only a DOI will not get a cache hit for a Paperclip-cached paper on the first call (they'll go online, get the paperclipId back, then subsequent calls hit the cache). This is fine because in practice the upstream `PaperArtifact` accumulates IDs as it gets enriched — by the time a paper is in the wiki, it usually has its strongest ID populated. The alternative (a reverse-lookup index file that has to be written-on-cache and read-on-lookup) solves a problem we don't have.

**Existing `<wiki-root>/converted/<id>.md` files** (current flat layout) — `cacheLookup` also probes the legacy flat path as a fallback. Old files are not moved.

**Cache invalidation:** none in v0.1. No TTL, no purge API. (See §12 decision row 15.)

### 5.5 State Machine Extension — Provenance vs. Evidence Tier

**No new states. Crucially: `source_tier` and `fulltextSource` are kept orthogonal.**

The two fields answer different questions and must not be conflated:

| Field | Question it answers | Domain |
|---|---|---|
| `source_tier` | *How strong is the evidence backing this wiki page?* | `'metadata-only' \| 'abstract-only' \| 'fulltext'` — **unchanged from today** |
| `fulltextSource` | *Which provider supplied the fulltext (when present)?* | `'paperclip' \| 'arxiv' \| undefined` — **NEW** |

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
- Backfill / observability: count `arxiv` vs `paperclip` coverage.
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
  if (s.paperclipApiKey && (a.doi || a.pmcId || a.pubmedId)) return true
  if (a.arxivId && isValidArxivId(a.arxivId)) return true
  return false
}
```

#### 5.6.4 Backoff coordination

Backoff state (`fulltextFailures`, `lastFulltextTryAt`) remains **per-canonical-key, not per-source** (constraint 3.6). A retry tries Paperclip → arXiv in dispatch order; an all-fail bumps the counter once. See §12 decision row 17 ("1 budget consumed per tick").

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

A naive default of "return up to 80 000 chars of body" floods the agent's context with material it usually doesn't need. Default behavior is **metadata + section list + cache path**; body is opt-in via two orthogonal levers (no enum, no implicit mode rules):

```typescript
// lib/tools/fetch-fulltext.ts
{
  name: 'fetch-fulltext',
  label: 'Fetch Full Text',
  description:
    'Retrieve metadata, section listing, and (optionally) body of a paper. ' +
    'Tries Paperclip (section-aware biomedical/arXiv) first, then arXiv ' +
    'direct. Default returns metadata + section list + cache path so the ' +
    'agent can decide what to read next. Pass `sections=[...]` for specific ' +
    'sections or `include_body=true` for the entire body.',
  parameters: Type.Object({
    doi:      Type.Optional(Type.String()),
    arxiv_id: Type.Optional(Type.String()),
    pmc_id:   Type.Optional(Type.String()),
    title:    Type.Optional(Type.String()),
    year:     Type.Optional(Type.Integer()),

    sections: Type.Optional(Type.Array(Type.String(), {
      description: 'Section names (Paperclip only, fuzzy-matched). Returns just these sections in `sections_returned`.'
    })),

    include_body: Type.Optional(Type.Boolean({
      default: false,
      description: 'When true, returns the entire body (capped by max_chars).'
    })),

    max_chars: Type.Optional(Type.Integer({
      default: 40_000,
      description: 'Cap on returned body/section bytes. Applies when `sections` or `include_body` is set.'
    })),

    prefer_source: Type.Optional(Type.Union([
      Type.Literal('paperclip'), Type.Literal('arxiv')
    ]))
  }),
}
```

**Default return shape** (`sections` empty, `include_body` false):

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
    "fulltext_available": true
  },
  "sections": ["Title", "Abstract", "Online Methods", "Cell culture, ...", "Statistics", ...],
  "cache_path": "<wiki-root>/converted/paperclip/PMC6130889.md",
  "source": "paperclip",
  "fetched_at": "2026-05-02T20:15:00Z"
}
```

**Body return shape** (when `sections=[...]` or `include_body=true`):

```jsonc
{
  "metadata": { ... },
  "sections": [...],
  "cache_path": "...",
  "source": "paperclip",
  "fetched_at": "...",

  // Present when sections=[...] was passed:
  "sections_returned": { "Methods": "...markdown..." },
  "sections_unmatched": ["typo-name"],

  // Present when include_body=true:
  "body": "...markdown...",

  "truncated": false                         // true when max_chars hit
}
```

**Coordinator prompt addition** (after the existing wiki guidance, around line 132 of `lib/agents/prompts/index.ts`):

```
After literature-search, when an abstract is not sufficient (extracting
methods, comparing baselines, quoting specific results):

  1. Call fetch-fulltext (default) to learn which sections are available
     and confirm fulltext exists. Returns metadata + section list + cache
     path — small, cheap to call speculatively.
  2. Then call fetch-fulltext again with sections=['Methods', ...] for
     just the sections you need.

Avoid include_body=true unless you genuinely need the whole paper.
Results are cached and shared with the paper wiki, so the wiki entry
will upgrade on next scan.
```

### 5.9 Wiki Agent Integration — Single Entry Point

`lib/wiki/agent.ts:304-308` becomes a single `resolveFulltext` call:

```typescript
const result = await resolveFulltext({
  doi:      artifact.doi,
  arxivId:  resolvedArxivId ?? undefined,
  pmcId:    artifact.pmcId,
  pubmedId: artifact.pubmedId,
  title:    artifact.title,                 // last-resort for arXiv title-resolve
  year:     artifact.year,
})

const fulltext: string | null = result?.markdown ?? null
const fulltextSource: FulltextSource | undefined = result?.source

// Existing fulltext-retry-failed branch is unchanged — still keys off `!fulltext`.
```

The old `downloadAndConvertArxiv` and `resolveArxivIdByTitle` exports are **deleted, not wrapped**. `lib/wiki/downloader.ts` is removed; its arXiv logic now lives in `lib/fulltext/arxiv.ts` and is reachable only through `resolveFulltext`. There are no external callers — `wiki/agent.ts` is the only consumer — so a back-compat wrapper would be code with no purpose. (See §12 decision row 8.)

### 5.10 `wiki_source` Tool — Cache Index Integration (review-round-1 issue 5)

`wiki_source(slug)` is the existing tool the coordinator is told to use *"when you need exact quotes, precise numbers, or cross-paper comparisons"* (`lib/agents/prompts/index.ts:130`). It returns paths to underlying paper artifacts including any cached fulltext. The whole "wiki memory is derived summary, not source evidence" closed-loop in the prompt rests on this tool surfacing the same fulltext the agent could have fetched directly.

**Without this section, the closed loop breaks.** An arXiv paper surfaces via `<wiki-root>/converted/arxiv/<id>.md`. A Paperclip-sourced paper lands in `<wiki-root>/converted/paperclip/<paperclipId>.md` — a path `wiki_source` doesn't currently know how to resolve.

**Required change to `lib/wiki/wiki-tools.ts`:**

`wiki_source` must call `fulltextCache.lookup()` (§5.4) to resolve fulltext paths regardless of which source produced them:

```typescript
// pseudocode for the relevant branch in wiki_source
const hit = await fulltextCache.lookup({
  doi: artifact.doi,
  arxivId: artifact.arxivId,
  pmcId: artifact.pmcId,
  pubmedId: artifact.pubmedId,
})

return {
  artifactPath: ...,
  pdfPath: ...,                                 // unchanged — only arXiv path has PDF
  fulltextPath: hit?.path ?? null,              // now finds Paperclip too
  fulltextSource: hit?.source ?? null,          // NEW: 'paperclip' | 'arxiv' | null
  sectionList: hit?.sectionList ?? null,        // Paperclip only
}
```

The response schema gains `fulltextSource` and `sectionList` fields; existing `fulltextPath` field semantics widen but signature is unchanged for back-compat.

**Implication for §6 component change list**: `lib/wiki/wiki-tools.ts` must be added to the modify list (~+25 lines). See the updated table.

## 6. Component-Level Change List

(Concrete diffs — line counts approximate, intended for review.)

| # | File | Action | Lines | Risk |
|---|---|---|---|---|
| 1 | `lib/fulltext/index.ts` | NEW — public `resolveFulltext()` + dispatch + `hasAnyFulltextSource` | ~90 | new |
| 2 | `lib/fulltext/paperclip.ts` | NEW — MCP HTTP client, text-output parser, section fetch | ~150 | new |
| 3 | `lib/fulltext/arxiv.ts` | MOVE — verbatim relocation from `lib/wiki/downloader.ts` | ~100 | semantics-preserving move |
| 4 | `lib/fulltext/cache.ts` | NEW — pure path-convention probe + legacy fallback | ~50 | new |
| 5 | `lib/fulltext/types.ts` | NEW — `FulltextRequest`, `FulltextResult`, `FulltextSource` | ~30 | new |
| 6 | `lib/wiki/downloader.ts` | **DELETE** | -155 | low |
| 7 | `lib/wiki/agent.ts` | REPLACE arXiv block with single `resolveFulltext` call (line 304-308) + propagate `pmcId` to siblings (line 277-288) | -10 / +30 | medium (touches main flow) |
| 8 | `lib/wiki/scanner.ts` | EXTEND — retry predicate uses `hasAnyFulltextSource` | +10 | medium (touches scan logic) |
| 9 | `lib/wiki/generator.ts` | EXTEND — `fulltextStatus` initial decision uses `hasAnyFulltextSource`; sidecar adds `fulltext_source` field | +10 | low |
| 10 | `lib/wiki/types.ts` | EXTEND — `ProcessedEntry.fulltextSource?: FulltextSource` | +2 | low |
| 11 | `lib/wiki/wiki-tools.ts` | EXTEND — `wiki_source` consults fulltext cache, returns `fulltextSource` + `sectionList` | +25 | medium (touches retrieval contract) |
| 12 | `lib/tools/fetch-fulltext.ts` | NEW — agent tool, metadata-default | ~160 | new |
| 13 | `lib/tools/index.ts` | REGISTER — add to `createResearchTools()` | +3 | trivial |
| 14 | `lib/tools/types.ts` | EXTEND — `ResolvedSettings.paperclipApiKey?` | +1 | trivial |
| 15 | `lib/agents/prompts/index.ts` | EXTEND — coordinator prompt: metadata-first guidance | +10 | low |
| 16 | `shared-electron/ipc-base.ts` | EXTEND — `API_KEY_NAMES` adds `PAPERCLIP_API_KEY` | +1 | trivial |
| 17 | `app/src/renderer/components/settings/ApiKeysSettings.tsx` | EXTEND — `KEY_FIELDS` adds Paperclip entry | +6 | trivial |
| 18 | `lib/types.ts` | EXTEND — `PaperArtifact.pmcId?: string` | +1 | low |
| 19 | `lib/commands/paper-artifact.ts` | EXTEND — `pmcId` in `opts`, persistence, dedup unchanged | +10 | low |
| 20 | `lib/tools/literature-search.ts` | EXTEND — extract `pmcId` from S2 (`externalIds.PubMedCentral`) and OpenAlex (`ids.pmcid`) and pass to upsert | +20 | low |
| 21 | `lib/wiki/hash-isolation.test.ts` | EXTEND — `pmcId` not in hash; `fulltextSource` change doesn't trigger semantic-change | +40 | low (test-only) |
| 22 | `lib/fulltext/index.test.ts` | NEW — dispatch, cache hit, all-fail, section fuzzy, `hasAnyFulltextSource` matrix | ~150 | new (test-only) |
| 23 | `README.md` + `docs/wiki/Paper-Wiki.md` | UPDATE — describe Paperclip integration, pmcId field | ~30 | docs |

**Total**: ~770 lines added, ~165 lines deleted, 12 modified files, 5 new files, 1 deleted file.

**v0.2 → v0.3 delta** (review-round-2 cuts):
- Unpaywall removed → -60 lines code, -1 file, -1 dispatch branch, -1 open question.
- `index.json` removed → -70 lines code in `cache.ts`, -1 maintenance burden.
- Wiki `downloader.ts` thin wrapper deleted instead of retained → -30 lines, no parallel API surface.
- `mode` enum collapsed to `include_body` boolean + `sections` array → -20 lines tool definition, no implicit-mode rules.
- `next_actions` field deleted from tool output → -10 lines, no duplicated coordinator guidance at runtime.
- CI live-probe removed → -1 secret, -1 flaky test surface.

**Files we're explicitly NOT touching:** `lib/mentions/resolver.ts`, `lib/tools/convert-document.ts`, `lib/mentions/document-cache.ts`, `app/src/main/ipc.ts`, `lib/memory-v2/*`, all skill markdown files. Future RFCs can extend mentions to surface fulltext (§10.1) and skills to recommend `fetch-fulltext` (§10.2).

## 7. Behavioral Specifications

### 7.1 Cache hit semantics

`cache.lookup` is a sequential path probe (§5.4): given whatever IDs the `FulltextRequest` carries, it tries `paperclipPath(pmcId)` first, then `arxivPath(arxivId)`. First-existing-file wins. No reverse-lookup index. `arxivId` matching strips version suffix (`v2`). `pmcId` matching is case-insensitive on the `PMC` prefix.

Trade-off: a request that has only a `doi` (no `pmcId`, no `arxivId`) does not hit the cache locally; it will go online, get the canonical ID back, and cache under that. Subsequent calls that *do* carry the source-typed ID will hit the cache. In practice, by the time a paper is in the wiki, it has usually accumulated its strongest ID via enrichment.

### 7.2 Network failure handling

| Failure | Source | Action |
|---|---|---|
| 401/403 | Paperclip | Log "PAPERCLIP_API_KEY invalid"; skip source for entire process lifetime; surface to user via wiki status |
| 404 / "No papers found" | Paperclip | Log; continue to next source |
| 429 | Paperclip | Wait, retry once with exponential backoff (1s, 4s); then continue to next source |
| 5xx | Paperclip | Log; continue to next source (do not retry; let backoff handle next pass) |
| Network timeout (>15s) | any | Log; continue to next source |
| Markitdown missing | arXiv | Log "markitdown not installed"; arXiv source unavailable. Paperclip path remains usable. |

### 7.3 Section fuzzy match (Paperclip)

User passes `sections: ['methods']`. Paperclip's section names vary: `'Methods'`, `'Online Methods'`, `'Materials and Methods'`. Strategy:

1. List sections via `ls /papers/<id>/sections/`.
2. Match each requested name against actual section names: lowercase-token-overlap, longest-match-wins.
3. Return only matched sections in `result.sections[name]`. Unmatched names returned in `result.unmatchedSections[]` for the caller's benefit.
4. If `sections` is omitted, return `content.lines` as the body.

### 7.4 Wiki retry coordination

When the wiki processes a `fulltext-upgrade` for a paper:

1. Call `resolveFulltext` (cache lookup → Paperclip → arXiv).
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
   - cache hit short-circuits dispatch (probes paperclip path, then arxiv path, in that order)
   - dispatch order respected (Paperclip → arXiv) when cache misses
   - `preferSource` overrides dispatch order
   - all sources fail → returns null
   - PAPERCLIP_API_KEY absent → Paperclip silently skipped
   - `hasAnyFulltextSource` matrix: arxivId-only, doi-only-with-key, doi-only-no-key, pmcId-only, none
   - section fuzzy matching produces expected pairs (`['methods']` → `Online Methods`, `Methods`)
   - legacy `<wiki-root>/converted/<id>.md` flat path still hits cache
2. `lib/fulltext/paperclip.test.ts`
   - text response parser extracts title / authors / source-id / date / DOI / abstract
   - error responses (401/404/429) classified correctly

**Regression (extend existing):**

3. `lib/wiki/hash-isolation.test.ts`
   - same paper, `fulltextSource` flips arXiv ↔ Paperclip: semantic hash unchanged, `processedAt` updates, `fulltextStatus` may change but no `semantic-change` reason fires
   - `processedEntry.fulltextSource` round-trips through serialization
   - `pmcId` not in semantic hash (constraint 3.2)

**Integration (manual, with live token):**

4. End-to-end via `fetch-fulltext` tool — search a known paper (PMC6130889), call tool, verify cache file written under `<wiki-root>/converted/paperclip/`, verify next wiki scan picks up the cached file as `fulltext-upgrade` and transitions the wiki page from `abstract-only`/`abstract-fallback` to `fulltext`.

## 10. Migration & Rollout

**Phase 0 — RFC review & sign-off** (this document).

**Phase 1 — Implementation.** Single PR. Ship `lib/fulltext/` (Paperclip + arXiv + cache + types), delete `lib/wiki/downloader.ts`, switch `wiki/agent.ts` to `resolveFulltext`, add `pmcId` to artifact + literature search + sibling propagation, wire `PAPERCLIP_API_KEY` settings, ship `fetch-fulltext` tool, update `wiki_source` to consult cache, update tests.

**Phase 2 — Backfill (optional CLI).** `npm run wiki:backfill-fulltext` walks all `abstract-only` and `abstract-fallback` wiki entries with DOI / PMC ID / arxivId and triggers a `fulltext-upgrade` rescan, bypassing backoff timer once. Idempotent. Off by default. (See §12 decision row 16.)

**Phase 3 — Reconsider Unpaywall (data-driven).** After Phase 1 has run for ~2 weeks, query `processed.json` for the `abstract-only` set. If a meaningful fraction has DOIs and Unpaywall would have caught them, write a follow-up RFC to add it. Without that data, do not add it.

**Phase 4 (later RFC) — Mentions integration, skills updates.**

## 11. Risks

**R1 — Paperclip outage.** Hosted dependency. Mitigation: graceful degradation to arXiv path; Paperclip-only papers stay `abstract-fallback` until service returns. Documented in operator runbook.

**R2 — Paperclip changes API or auth model.** Their MCP server returns text not JSON; format could shift. Mitigation: `paperclip.ts` has a small, well-isolated parser. If they ship a breaking change, it's a one-file fix on first user report. No CI live-probe needed (it would be flaky and would consume secrets for a low-probability event).

**R3 — markitdown unavailable** in user environments (already a risk). Mitigation: Paperclip path doesn't need markitdown, so biomedical and arXiv-via-Paperclip papers continue to work. Pure arXiv-only papers degrade exactly as today.

**R4 — Cache disk usage.** `<wiki-root>/raw/` and `converted/` grow unbounded. Mitigation: documented disk cost; no automated eviction in v0.1 (decision row 6). If reports come in, revisit with a manual `wiki:cache-prune --older-than 90d` script in a follow-up.

**R5 — Wiki state-machine drift.** Touching `agent.ts` flow is the riskiest part of this change. Mitigation: a single `resolveFulltext` call replaces the existing `downloadAndConvertArxiv` block (§5.9 — same surface area, not parallel paths). Heavy regression coverage on `hash-isolation.test.ts` to prove `fulltextSource` flips don't trigger `semantic-change` rescans.

## 12. Decision Log

| Date | Decision | Author | Rationale |
|---|---|---|---|
| 2026-05-02 | `source_tier` and `fulltextSource` kept orthogonal — provenance does NOT live inside `source_tier` | Captain (review-round-1) | Merging would break every existing parser/indexer/wiki filter that switches on `source_tier`. §5.5 split. |
| 2026-05-02 | `pmcId` added as first-class identifier on `PaperArtifact`; populated from S2 / OpenAlex / Paperclip lookup; propagated to siblings | Captain (review-round-1) | Without pmcId persistence, Paperclip's strongest matching path (`lookup pmc`) is unreachable from a wiki rescan. §3.9, §5.7.2. |
| 2026-05-02 | `abstract-fallback` semantics broaden from "arXiv retryable" to "any source retryable"; both initial classification (`generator.ts`) and retry trigger (`scanner.ts`) share `hasAnyFulltextSource` | Captain (review-round-1) | Otherwise DOI-only biomedical papers terminal-fail on first miss and never get Paperclip retry. §3.3, §5.6. |
| 2026-05-02 | `fetch-fulltext` defaults to returning metadata + section list + cache_path only; body opt-in via `sections=[...]` or `include_body=true`; `max_chars` default 80k → 40k | Captain (review-round-1; parameter shape further refined in review-round-2 — see row 9) | Naive 80k-body default floods agent context for typical use cases; metadata + section list is far more useful as a first-pass response. §5.8. |
| 2026-05-02 | `wiki_source` consults the new fulltext cache index; response gains `fulltextSource` and `sectionList` fields | Captain (review-round-1) | Without this, Paperclip-cached fulltext is invisible to the coordinator's "exact quotes / precise numbers" path, breaking the "wiki memory ≠ source evidence" closed loop. §5.10. |
| 2026-05-02 | **Drop Unpaywall from v0.1.** Two sources: Paperclip + arXiv. | Captain (review-round-2) | No measured evidence Unpaywall would meaningfully extend coverage. Reconsider in Phase 3 (§10) using actual `abstract-only` corpus measurements. Delete one file, one dispatch branch, one source enum variant. |
| 2026-05-02 | **Drop `index.json` reverse-lookup file.** Cache lookup is a path probe with the source's canonical ID. | Captain (review-round-2) | The "I have an ID but don't know which source's it is" problem doesn't exist — `FulltextRequest` carries the source-typed IDs. Index file solves a non-problem at the cost of write/read maintenance and a "lazy migration" path. §5.4. |
| 2026-05-02 | **Delete `lib/wiki/downloader.ts` outright; no thin wrapper retained.** | Captain (review-round-2) | The only caller is `wiki/agent.ts`, which we're updating. A back-compat wrapper would be code with no future caller — pre-promised cleanup that never happens. §5.9. |
| 2026-05-02 | **`fetch-fulltext` parameters: `include_body: boolean` + `sections: string[]`** instead of `mode: 'metadata' \| 'sections' \| 'body'` enum. | Captain (review-round-2) | The enum had an implicit "sections is implied by sections=[...]" rule — a third state that was never explicitly settable. Two orthogonal levers are clearer than a three-state enum with implicit transitions. §5.8. |
| 2026-05-02 | **Drop `next_actions` field from tool output.** | Captain (review-round-2) | Coordinator usage guidance lives entirely in the system prompt. Repeating it in tool runtime output is duplicated source of truth. §5.8. |
| 2026-05-02 | **No CI live-probe against Paperclip.** | Captain (review-round-2) | Flaky, consumes secrets, exists for an isolated parser. Failure mode is "user reports, we patch one file." Off-axiom. §11 R2. |
| 2026-05-02 | **Phase 1 + Phase 2 merged into one shipping PR.** | Captain (review-round-2) | The "verbatim arXiv move" phase exists for PR hygiene; the diff is the same whether shipped alone or with Paperclip. §10. |
| 2026-05-02 | **Source priority: Paperclip first when API key present, arXiv otherwise.** | Captain (review-round-2 — promoted from open question 11.1) | Paperclip's section-aware output is consistently more useful for LLM consumption than markitdown'd PDF; cleaner format outweighs "official" provenance for our use case. `preferSource` overrides per-call. |
| 2026-05-02 | **Backoff timer resets when artifact gains a new identifier.** | Captain (review-round-2 — promoted from 11.2) | A paper acquiring a DOI changes the eligibility set for `hasAnyFulltextSource`, so prior failures (which had no DOI to try) are no longer evidence of a permanent miss. Scanner detects new identifiers via `semantic-change`-adjacent hash on the identifier set; one-line clear of `fulltextFailures`/`lastFulltextTryAt`. |
| 2026-05-02 | **Cache: no TTL, no purge API in v0.1.** | Captain (review-round-2 — promoted from 11.4) | YAGNI. Manual prune script ships only when first user reports excessive disk usage. |
| 2026-05-02 | **Backfill Phase 2: explicit `npm run wiki:backfill-fulltext` CLI; no auto-run.** | Captain (review-round-2 — promoted from 11.5) | Auto-run on first launch is intrusive — it would silently spend Paperclip quota and LLM tokens. CLI keeps the user in control. |
| 2026-05-02 | **Retry budget: 1 per tick regardless of how many sources tried.** | Captain (review-round-2 — promoted from 11.6) | Counter is per-canonical-key, not per-source (constraint 3.6). All-source-fail-in-one-tick = 1 budget consumed. |
| 2026-05-02 | **Paperclip rate limit: 1 req/s via existing `ProviderRateGate`.** | Captain (review-round-2 — promoted from 11.8) | Reuse `lib/tools/web-tools.ts:ProviderRateGate`. Tighten only if Paperclip team specifies. |


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
- `lib/tools/web-tools.ts` — `ProviderRateGate` (§12 decision row 18)
- `lib/tools/convert-document.ts` — markitdown CLI (§4 last bullet)
- `lib/mentions/resolver.ts` — paper mention shape (§4, §10.1)
- `lib/mentions/document-cache.ts` — separate cache (§4)
- `lib/agents/prompts/index.ts` — coordinator prompt, wiki prompts (§5.8, §6 row 15)
- `shared-electron/ipc-base.ts` — `API_KEY_NAMES` (§5.7, §6 row 16)
- `app/src/renderer/components/settings/ApiKeysSettings.tsx` — KEY_FIELDS UI (§5.7, §6 row 17)
