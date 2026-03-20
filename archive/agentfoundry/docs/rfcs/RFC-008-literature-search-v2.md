# RFC-008: Literature Search Agent v2

**Status:** Draft
**Author:** Captain + Claude
**Created:** 2026-01-30

## 1. Problem

The current literature search agent is **slow, expensive, and imprecise**. A single study request (comprehensive literature study on HPC/Cloud operational logs) takes 30 minutes, consumes 400K+ tokens in the outer coordinator loop alone, triggers 50+ internal LLM calls, 150+ external API calls, and produces 75 papers — many of which are marginally relevant.

### Observed pathologies from a real run

| Issue | Evidence from log | Root cause |
|-------|------------------|------------|
| Redundant searches | "Spell", "DeepLog", "MicroRCA" each searched 3-4 times across separate `literature-search` calls | Coordinator has no memory of what's already been found |
| Too many outer-loop rounds | 13 LLM rounds (coordinator) for one user message, each deciding "I need to search more" | No search plan; no stopping criteria; no cumulative coverage tracking |
| Expensive per-invocation cost | Each `literature-search` runs planner→searcher→reviewer→summarizer (3-4 LLM calls) | Full planning pipeline even when coordinator already knows the exact query |
| API cascade failures | arxiv timeouts, 15+ openalex "fetch failed", 15+ dblp "fetch failed" | 4 sources × 3 queries × 15 invocations = 180+ API calls, triggering rate limits |
| Low precision | Papers on "backfilling schedulers", "TCO-driven datacenter rearchitecting" saved for a log analysis study | Score threshold ≥7 too loose; reviewer LLM tends to be generous |
| Growing context | Prompt tokens: 15K → 19K → 21K → 43K → 56K → 60K per round | Tool results accumulate in conversation history without compression |
| Duplicate papers | "Loghub" saved twice, "TVDiag" saved twice | Deduplication by DOI/title misses variant titles |

### Cost breakdown (estimated)

```
Coordinator (outer loop):
  13 rounds × ~25K avg prompt tokens = 325K prompt tokens
  13 rounds × ~1.2K avg completion tokens = 16K completion tokens

literature-search internal (per invocation, ~15 invocations):
  Planner: 15 × ~5K = 75K prompt tokens
  Reviewer: 15 × ~10K = 150K prompt tokens  (including paper list)
  Summarizer: 15 × ~8K = 120K prompt tokens

Estimated total: ~700K+ prompt tokens, ~50K completion tokens
At gpt-5.4 pricing: significant cost for one literature study
```

### What works well (keep these)

- **Local-first paper lookup**: Jaccard similarity search on cached papers avoids redundant API calls on subsequent searches
- **Auto-save with metadata**: Papers saved with relevanceScore, searchKeywords, BibTeX, citationCount enable future reuse
- **Four-source diversity**: Semantic Scholar + arXiv + OpenAlex + DBLP covers different publication types well
- **Review-refine loop**: Reviewer identifies coverage gaps and suggests targeted follow-up queries

---

## 2. Root Causes

### 2.1 Architecture mismatch: the coordinator is the wrong planner

The coordinator is a general-purpose chat agent with 27 tools. It uses `literature-search` as one of many tools, calling it in a loop without a structured plan. Each call is independent — the coordinator doesn't track cumulative coverage, doesn't deduplicate across calls, and doesn't know when to stop.

Meanwhile, each `literature-search` call has its **own** planner agent that generates queries. This creates a two-level planning problem: the coordinator decides *what topic* to search, and the internal planner decides *what queries* to run. These two planners don't communicate, leading to overlapping searches.

### 2.2 No cumulative state

After each `literature-search` call, the tool returns a summary string. The coordinator sees "Found 8 papers on log parsing" but can't query the actual paper list, check for coverage gaps, or avoid duplicates. The next round, it generates a similar query and the whole pipeline runs again.

### 2.3 Per-invocation overhead is too high

The 4-agent pipeline (planner→searcher→reviewer→summarizer) costs 3-4 LLM calls per invocation. When the coordinator calls it 15 times, that's 45-60 internal LLM calls. The planner and summarizer are especially wasteful when the coordinator already knows the exact query.

### 2.4 No rate-limit awareness

The searcher hits all 4 sources for every query with no backoff or circuit-breaking. After the first few invocations, external APIs start failing, but the system keeps trying — generating more failures and wasting time on timeouts.

---

## 3. Design: Literature Search v2

### 3.1 Core principle: **One search session, not N independent calls**

Instead of the coordinator calling `literature-search` 15 times, it calls it **once** with a comprehensive research request. The literature team manages the entire search session internally — planning all queries upfront, executing them with rate-limit awareness, tracking cumulative coverage, and stopping when coverage is sufficient.

```
BEFORE (v1):
  Coordinator → literature-search("log parsing") → 4 LLM calls + 12 API calls
  Coordinator → literature-search("log anomaly detection") → 4 LLM calls + 12 API calls
  Coordinator → literature-search("DeepLog LSTM log anomaly") → 4 LLM calls + 12 API calls
  ... × 15 times

AFTER (v2):
  Coordinator → literature-search("comprehensive study on HPC operational logs") → 1 session
    Planner: generates 8-12 queries covering all sub-topics (1 LLM call)
    Searcher: executes all queries with rate limiting (0 LLM calls, N API calls)
    Reviewer: scores all papers, identifies gaps (1-2 LLM calls)
    [Optional refinement loop: 1 more searcher + reviewer round]
    Summarizer: produces final review (1 LLM call)
    Total: 3-5 LLM calls instead of 45-60
```

### 3.2 Architecture changes

#### 3.2a. Smarter planner: generate a full search plan upfront

The planner receives the research request and produces a **structured search plan** with:

```typescript
interface SearchPlan {
  // Research scope
  topic: string
  subTopics: SubTopic[]      // e.g., "log parsing", "anomaly detection", "root cause analysis"

  // All queries organized by sub-topic
  queryBatches: QueryBatch[]

  // Stopping criteria
  targetPaperCount: number           // e.g., 30-50 papers
  minimumCoveragePerSubTopic: number // e.g., 3 papers each
}

interface SubTopic {
  name: string
  description: string
  priority: 'high' | 'medium' | 'low'
  expectedPaperCount: number
}

interface QueryBatch {
  subTopic: string
  queries: string[]           // 2-3 queries per sub-topic
  dblpQueries?: string[]
  sources: string[]           // Which APIs to use for this batch
  priority: number            // Execute high-priority batches first
}
```

This replaces the current pattern where the coordinator generates queries one at a time across 13 rounds.

#### 3.2b. Planner context assembly: filtered conversation passthrough

The planner can only make a good plan if it knows what already exists. The key design decision: **pass a filtered slice of the coordinator's conversation history directly to the planner**, rather than relying on the coordinator to manually summarize context into a free-text string.

**Why filtered passthrough, not coordinator summary or full context:**

| Approach | Planner prompt tokens | Plan quality | Risk |
|----------|----------------------|-------------|------|
| Coordinator summarizes into `context` string | ~5K | Lossy — depends on coordinator LLM's summary quality | Coordinator may omit relevant details, lose nuance from earlier searches |
| Full coordinator context passthrough | ~60K+ | Marginal improvement, planner drowns in noise | High token cost; distracted by irrelevant tool calls (todo, memory, glob, etc.) |
| **Filtered passthrough: user messages + literature-search results only** | ~10-15K | **Best** — planner sees exact user intent + exact previous search coverage | Focused signal, no information loss on what matters |

**The filter is mechanical, not LLM-based:** keep only user messages and `literature-search` tool call/result pairs. Everything else (todo-add, memory-put, glob, read, write, edit, ctx-get, etc.) is irrelevant to search planning.

```typescript
interface PlannerContext {
  // User's current research request
  request: string

  // Filtered conversation history from coordinator
  // Includes: user messages + literature-search tool calls/results
  // Excludes: system prompt, todo-*, memory-*, glob, read, write, edit, ctx-get, etc.
  conversationHistory: FilteredMessage[]

  // Current local library state (fast disk scan, no LLM)
  localLibrary: {
    totalPapers: number
    topicClusters: { topic: string; count: number; sampleTitles: string[] }[]
  }
}

interface FilteredMessage {
  role: 'user' | 'assistant' | 'tool-result'
  content: string
  toolName?: string   // Only for tool-result: 'literature-search'
}

// Mechanical filter — no LLM, no summarization
function filterConversationForPlanner(
  messages: ConversationMessage[]
): FilteredMessage[] {
  return messages.filter(m =>
    m.role === 'user' ||
    (m.role === 'tool' && m.toolName === 'literature-search')
  )
}
```

**How this is built:**
1. `request` — the `query` parameter from the tool call
2. `conversationHistory` — the coordinator passes its full message history to `literature-search` via a new `messages` field on the tool execution context. The literature team runs `filterConversationForPlanner()` to extract only user messages and previous `literature-search` results (which contain coverage states, gaps, queries executed). This is a simple array filter, not an LLM call.
3. `localLibrary` — scan `.research-pilot/literature/*.json`, group by `searchKeywords` using simple keyword overlap, return topic clusters with counts. Fast disk read, no LLM.

**What the planner sees for an incremental search (turn 2):**
```
conversationHistory:
  [user] "comprehensive study on HPC operational logs"
  [tool-result: literature-search] {
    coverage: { score: 0.75, subTopics: [
      { name: "log parsing", paperCount: 12, covered: true },
      { name: "root cause analysis", paperCount: 3, covered: false,
        gaps: ["microservice RCA", "causal inference"] }
    ], queriesExecuted: ["log parsing Drain Spell...", ...] }
  }
  [user] "search more on root cause analysis"

localLibrary:
  { totalPapers: 45, topicClusters: [
    { topic: "log parsing", count: 15, sampleTitles: ["Drain: An Online...", "Spell: Streaming..."] },
    { topic: "anomaly detection", count: 18, sampleTitles: ["DeepLog...", "LogAnomaly..."] },
    { topic: "root cause analysis", count: 4, sampleTitles: ["MicroRCA...", "CloudRanger..."] }
  ]}
```

From this, the planner can make informed decisions:
- "root cause analysis has only 3 papers and gaps in microservice RCA and causal inference — prioritize those"
- "log parsing already has 12 papers and is covered — skip it entirely"
- "Queries 'MicroRCA root cause...' and 'CloudRanger...' were already executed — generate different ones"
- "User specifically asked for more on root cause analysis — focus plan on that sub-topic only"

**Implementation detail — how coordinator passes messages to the tool:**

The `literature-search` tool is created inside `subagent-tools.ts` via `defineTool()`. The tool's `execute()` function receives an execution context that includes the agent's message history. We add the coordinator's messages to the tool execution context:

```typescript
// In subagent-tools.ts, literatureSearchTool.execute():
const filteredHistory = filterConversationForPlanner(context.messages)
const plannerCtx: PlannerContext = {
  request: input.query,
  conversationHistory: filteredHistory,
  localLibrary: scanLocalLibrary(projectPath)
}
```

No new tool parameters needed. The messages flow through the existing tool execution context.

#### 3.2c. Rate-limited searcher with circuit breaking

The searcher executes query batches with:

```typescript
interface SearcherConfig {
  // Rate limiting per source
  rateLimits: {
    semantic_scholar: { requestsPerMinute: 10, concurrency: 2 }
    arxiv: { requestsPerMinute: 3, concurrency: 1 }   // arxiv is slow
    openalex: { requestsPerMinute: 10, concurrency: 3 }
    dblp: { requestsPerMinute: 5, concurrency: 2 }
  }

  // Circuit breaker: stop hitting a source after N consecutive failures
  circuitBreaker: {
    failureThreshold: 3      // After 3 failures, open circuit
    resetTimeMs: 60_000      // Try again after 60s
  }

  // Global limits
  maxTotalApiCalls: 60       // Hard cap on API calls per session
  maxTimeMs: 120_000         // 2 minute timeout for all searches
}
```

**Execution strategy:**
1. Execute all query batches in priority order
2. For each batch, query sources in parallel (respecting per-source concurrency)
3. If a source fails 3 times consecutively, skip it for remaining batches
4. Deduplicate results cumulatively (not per-batch)
5. Stop early if `targetPaperCount` reached before all batches complete

#### 3.2d. Metadata enrichment (non-LLM)

Different sources return different metadata quality. A paper from arXiv may have no DOI, no venue, no citation count. A paper from DBLP may have no abstract. The reviewer needs complete metadata to score accurately, and auto-saved papers should have high-quality records.

**This is fundamentally an identifier-resolution and record-reconciliation problem**, not a "query one API and trust it" problem. The approach: normalize inputs, generate candidate records from multiple sources, score and select the best match, merge fields with source priorities, and cache results.

```
Search all sources → Deduplicate → Enrich missing metadata → Reviewer scores
```

##### Canonical internal schema

All papers are normalized to one internal schema regardless of source. This makes the pipeline stable across API changes.

```typescript
interface EnrichedPaper {
  // Identifiers — multiple IDs enable cross-referencing
  ids: {
    doi?: string           // Normalized: lowercase, no "https://doi.org/" prefix
    arxivId?: string       // e.g., "2301.12345"
    dblpKey?: string       // e.g., "conf/sigcomm/SmithJ23"
    openalexId?: string    // e.g., "W1234567890"
    s2PaperId?: string     // Semantic Scholar corpus ID
  }

  // Bibliographic
  title: string            // Original casing preserved
  authors: string[]        // Ordered, original strings
  year?: number
  venue?: string           // Journal name or conference booktitle
  volume?: string
  pages?: string

  // Links
  doiUrl?: string          // https://doi.org/<doi>
  url?: string             // Best available landing page
  pdfUrl?: string          // Open-access PDF if available

  // Content
  abstract?: string
  citationCount?: number

  // Source tracking (per-paper, not per-field — pragmatic, not over-scoped)
  enrichmentSource?: string   // Which API filled the most gaps: 'crossref' | 'semantic_scholar' | 'dblp' | 'openalex'
  enrichedAt?: string         // ISO timestamp
}
```

**Why not per-field provenance:** Per-field source tracking (storing which API provided each individual field) is useful for a metadata service but over-scoped for our use case. We track which API was the primary enrichment source — enough to debug issues without the complexity.

##### Input normalization

Before matching, normalize inputs deterministically:

```typescript
function normalizeForMatching(paper: Paper): NormalizedPaper {
  return {
    // DOI: lowercase, strip URL prefix, validate pattern
    doi: paper.doi
      ? paper.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim()
      : undefined,

    // Title: Unicode NFC, collapse whitespace, strip punctuation, lowercase
    // Keep original for output
    normalizedTitle: paper.title
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),

    // Authors: extract family names for matching
    authorFamilyNames: paper.authors?.map(a => {
      // "John Smith" → "smith", "Smith, J." → "smith"
      const parts = a.includes(',') ? a.split(',')[0] : a.split(' ').pop() || a
      return parts.toLowerCase().trim()
    }) || [],

    // Cache key for deduplication
    cacheKey: paper.doi
      ? `doi:${paper.doi.toLowerCase()}`
      : hashKey(paper.title, paper.authors?.[0])
  }
}
```

##### Resolution flow

Two paths based on whether DOI is present, optimized for CS papers:

```typescript
async function enrichPapers(
  papers: Paper[],
  config: EnrichmentConfig
): Promise<EnrichmentResult> {
  const stats = { enriched: 0, skipped: 0, failed: 0, fieldsAdded: {} }
  const startTime = Date.now()

  // Skip papers that already have 5+ of 7 core fields
  const needsEnrichment = papers.filter(p => countCoreFields(p) < 5)
  const alreadyComplete = papers.length - needsEnrichment.length
  stats.skipped = alreadyComplete

  // Prioritize: papers missing DOI first (DOI unlocks the fast path)
  needsEnrichment.sort((a, b) => (a.doi ? 1 : 0) - (b.doi ? 1 : 0))

  for (const paper of needsEnrichment) {
    // Time budget check — stop enriching if running too long
    if (Date.now() - startTime > config.maxTimeMs) break

    // Check cache first
    const cached = config.cache.get(normalizeForMatching(paper).cacheKey)
    if (cached) { mergeMissing(paper, cached); stats.enriched++; continue }

    try {
      if (paper.doi) {
        // PATH A: DOI present — direct lookup (fast, high confidence)
        await enrichByDOI(paper, config)
      } else {
        // PATH B: DOI missing — search + title matching (slower, needs validation)
        await enrichByTitleAuthor(paper, config)
      }
      stats.enriched++
    } catch {
      stats.failed++
    }
  }

  return stats
}
```

**Path A — DOI present (fast, ~1-2 API calls):**

```typescript
async function enrichByDOI(paper: Paper, config: EnrichmentConfig): Promise<void> {
  const doi = normalizeDOI(paper.doi!)

  // 1. Crossref by DOI — canonical bibliographic metadata
  //    Use "mailto" header for polite pool (better rate limits)
  const cr = await fetchCrossrefByDOI(doi)
  if (cr) mergeMissing(paper, cr)

  // 2. Semantic Scholar by DOI — enriches venue, citations, OA links
  //    Only if still missing fields after Crossref
  if (countCoreFields(paper) < 7) {
    const ss = await fetchSemanticScholarByDOI(doi)
    if (ss) mergeMissing(paper, ss)
  }

  config.cache.set(`doi:${doi}`, paper)
}
```

**Path B — DOI missing (search + title matching, ~2-3 API calls):**

```typescript
async function enrichByTitleAuthor(paper: Paper, config: EnrichmentConfig): Promise<void> {
  const norm = normalizeForMatching(paper)

  // 1. DBLP search first — curated, CS-focused, strong for conference papers
  const dblpCandidates = await searchDblp(paper.title)
  const dblpMatch = findByNormalizedTitle(norm.normalizedTitle, dblpCandidates)

  if (dblpMatch) {
    mergeMissing(paper, dblpMatch)
    // If DBLP gave us a DOI, promote to Path A for remaining fields
    if (dblpMatch.doi && countCoreFields(paper) < 7) {
      await enrichByDOI(paper, config)
    }
    return
  }

  // 2. Semantic Scholar search — broader coverage, good for preprints
  const ssCandidates = await searchSemanticScholar(`${paper.title} ${norm.authorFamilyNames[0] || ''}`)
  const ssMatch = findByNormalizedTitle(norm.normalizedTitle, ssCandidates)

  if (ssMatch) {
    mergeMissing(paper, ssMatch)
    if (ssMatch.doi && countCoreFields(paper) < 7) {
      await enrichByDOI(paper, config)
    }
    return
  }

  // 3. If no title match, skip — don't merge unrelated data
}

function findByNormalizedTitle(
  normalizedTitle: string,
  candidates: Partial<EnrichedPaper>[]
): Partial<EnrichedPaper> | null {
  // Simple normalized title comparison — academic APIs already rank by relevance,
  // so the top result with a matching normalized title is almost always correct
  for (const c of candidates) {
    const candTitle = c.title
      ?.normalize('NFC').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (candTitle === normalizedTitle) return c
  }
  return null
}
```

**Why simple title matching instead of scored candidates:** Academic search APIs (DBLP, Semantic Scholar) already return relevance-ranked results. If the top result's normalized title matches exactly, it's the right paper. If not, the risk of merging wrong metadata outweighs the benefit. Incomplete metadata is better than wrong metadata.

##### Merge policy

Simple fill-missing-fields strategy — no source priority overrides:

```typescript
function mergeMissing(target: EnrichedPaper, source: Partial<EnrichedPaper>, sourceName?: string): void {
  for (const field of CORE_FIELDS) {
    if (!target[field] && source[field]) {
      target[field] = source[field]
    }
  }
  if (sourceName) target.enrichmentSource = sourceName
  target.enrichedAt = new Date().toISOString()
}
```

##### Enrichment config and time budget

```typescript
interface EnrichmentConfig {
  maxTimeMs: number              // Default: 30_000 (30 seconds total for all papers)
  maxPapersToEnrich: number      // Default: 30 (skip the rest)
  cache: Map<string, EnrichedPaper>  // In-memory cache, persisted to local library via auto-save
  rateLimiter: RateLimiter       // Shared with searcher

  // API configuration
  crossrefMailto?: string        // "mailto:you@example.com" for polite pool
  semanticScholarApiKey?: string // Optional, increases rate limits from 10 to 100 req/min
}
```

**Time budget is the key constraint.** With a 30-second budget and ~30 papers:
- Papers with DOI: ~2 API calls each → ~200ms each → fast
- Papers without DOI: ~3 API calls each → ~500ms each → moderate
- With rate limiting and 2-3 concurrent requests: 30 papers in 15-25 seconds is achievable

**What we intentionally skip** (from the comprehensive plan — valuable for a metadata service, over-scoped for us):
- Candidate scoring (Jaro-Winkler, multi-signal) → simple normalized title matching is sufficient; APIs return relevance-ranked results
- Field-level merge with source priorities → simple fill-missing strategy; first source wins, no overrides
- Per-field provenance tracking → replaced with per-paper `enrichmentSource`
- "Needs review" ambiguity state → skip if not confident
- Raw response storage for replay → not needed
- Local DBLP/OpenAlex snapshot mirrors → too heavy
- BibTeX generation via CSL renderer → existing `bibtex-utils.ts` is sufficient
- Unpaywall for OA PDF links → nice-to-have, not core

##### Caching strategy

Enrichment results are cached at two levels:

1. **In-memory during session:** The `cache` map in `EnrichmentConfig` avoids re-enriching papers seen in the current session
2. **Persisted via auto-save:** When papers are auto-saved to `.research-pilot/literature/`, enriched fields are included. On subsequent searches, local papers already have complete metadata — no re-enrichment needed. This is the existing auto-save mechanism, no new code.

Cache key is `doi:<normalized_doi>` if DOI exists, otherwise `hash(normalized_title + first_author_family)`.

##### Where it runs

Inside the searcher agent, after `deduplicatePapersPreferLocal()` and before returning results to the reviewer. The searcher is already a tool-agent (no LLM), so this fits naturally.

##### Expected coverage improvement

| Source | Before enrichment | After enrichment |
|--------|------------------|-----------------|
| arXiv paper | title, authors, year, abstract | + DOI, venue, citationCount (via Crossref/SS) |
| DBLP paper | title, authors, year, venue | + abstract, DOI, citationCount (via SS) |
| OpenAlex paper | title, authors, year, DOI, venue, citationCount | + abstract (via SS, replaces inverted index reconstruction) |
| Semantic Scholar paper | title, authors, year, abstract, citationCount | + DOI, venue, pages (via Crossref/DBLP) |

#### 3.2e. Cumulative coverage tracker

The reviewer tracks coverage across all batches instead of reviewing each search independently:

```typescript
interface CoverageTracker {
  subTopics: Map<string, {
    papersFound: number
    targetMet: boolean
    bestPaperScore: number
    gaps: string[]           // Missing aspects within this sub-topic
  }>

  // Overall metrics
  totalRelevantPapers: number  // Score ≥ 8
  totalMarginalPapers: number  // Score 7
  coverageScore: number        // 0-1, fraction of sub-topics adequately covered
}
```

The reviewer runs **once** after all search batches complete (not per-batch), scoring all papers and computing coverage. If coverage < 0.8, it generates **targeted refinement queries** for the specific missing sub-topics — not broad re-searches.

#### 3.2f. Higher quality bar: score ≥ 8 for auto-save

Change the auto-save threshold from 7 to **8**. Papers scoring 7 are "somewhat relevant" — not worth polluting the library with. This alone would have cut the 75 papers down to ~30-40 more focused ones.

Additionally, add a **relevance justification** requirement to the reviewer:

```typescript
interface ScoredPaper {
  // ... existing fields
  relevanceScore: number       // 0-10
  relevanceJustification: string  // WHY this score (forces reviewer to think)
}
```

#### 3.2g. Compressed tool result with coverage state

Instead of returning a long summary that inflates the coordinator's context, return a **structured compact result** that includes coverage state. This coverage state becomes part of the coordinator's conversation history and enables incremental searches without any new tools or parameters (see section 8.2).

```typescript
interface LiteratureSearchResult {
  success: boolean
  data: {
    // Short summary for coordinator context (< 500 tokens)
    briefSummary: string

    // Coverage state — compact enough to stay in context (~200-300 tokens)
    // This is the key to incremental sessions: the coordinator sees this in its
    // conversation history and forwards it to the planner on the next search
    coverage: {
      score: number   // 0-1
      subTopics: {
        name: string
        paperCount: number
        covered: boolean
        gaps: string[]              // Missing aspects within this sub-topic
      }[]
      queriesExecuted: string[]     // So planner can avoid re-running same queries
    }

    // Counts
    totalPapersFound: number
    papersAutoSaved: number

    // Written to disk, not in context
    fullReviewPath: string   // Path to .research-pilot/reviews/<id>.md
    paperListPath: string    // Path to .research-pilot/reviews/<id>-papers.json

    // Performance
    durationMs: number
    llmCallCount: number
    apiCallCount: number
    apiFailureCount: number
  }
}
```

The full literature review markdown and paper list are saved to disk. The coordinator only sees a brief summary + counts. If the user or coordinator needs details, they can `read` the review file.

### 3.3 Eliminating the double-planner problem

The planner is the ONLY planner. The coordinator calls `literature-search` once with a broad research request. The internal planner generates ALL queries. The coordinator never calls `literature-search` more than 1-2 times per user message.

Enforce this with a **per-turn invocation limit**: after 2 `literature-search` calls in one turn, the tool returns a warning instead of executing:

```typescript
if (invocationCount >= 2) {
  return {
    success: false,
    error: 'Already ran 2 literature searches this turn. Review existing results first. Use a single comprehensive query instead of multiple narrow ones.'
  }
}
```

No new tool parameters are needed. The planner gets its context through the **filtered conversation passthrough** (section 3.2b) — the coordinator's message history is mechanically filtered to extract user messages and previous `literature-search` results. The coordinator doesn't need to manually summarize anything; the information flows automatically.

### 3.4 Smarter reviewer prompt

The current reviewer tends to give generous scores. Improve the prompt with:

1. **Explicit scoring rubric**:
   - 10: Directly addresses the core research question; seminal/foundational paper
   - 8-9: Highly relevant; addresses a key sub-topic with significant contribution
   - 6-7: Tangentially related; useful for background but not core
   - 1-5: Not relevant or only peripherally connected

2. **Negative examples**: "A paper on 'backfill scheduling for HPC' scores 4 for a study on 'log analysis for HPC' — scheduling is a different domain even though both involve HPC"

3. **Forced ranking**: After scoring, the reviewer must rank papers and cut the bottom 30%

---

## 4. Implementation Plan

### Phase 1: Quick wins (high impact, low effort)

1. **Raise auto-save threshold to ≥8** — Single constant change
2. **Add per-turn invocation limit (max 2)** — Prevents the coordinator from calling `literature-search` 15 times
3. **Add circuit breaker to searcher** — Stop hitting failed APIs after 3 consecutive failures
4. **Compress tool result** — Return brief summary + disk paths instead of full review in context

### Phase 2: Planner overhaul

5. **Restructure planner to generate full search plan** (sub-topics + query batches + stopping criteria)
6. **Execute all queries in one session** with rate limiting and priority ordering
7. **Cumulative coverage tracking** — Reviewer scores all papers once, not per-batch

### Phase 3: Searcher robustness

8. **Per-source rate limiting** with configurable limits
9. **Global API call cap** (max 60 per session)
10. **Session timeout** (2 minutes max for all searches)
11. **Better deduplication** — Fuzzy title matching (Levenshtein distance < 10% of title length)

### Phase 4: Quality improvements

12. **Improved reviewer prompt** with explicit rubric, negative examples, forced ranking
13. **Relevance justification** required for each scored paper
14. **Save full review to disk** instead of passing through context

---

## 5. File Changes

| File | Changes |
|------|---------|
| `examples/research-pilot/agents/literature-team.ts` | Filtered conversation passthrough + local library scan for planner context, `filterConversationForPlanner()`, new search plan model, cumulative coverage, rate limiting, circuit breaker, compressed result with coverage state, disk-based review output, search plan broadcasting to UI |
| `examples/research-pilot/agents/subagent-tools.ts` | Pass coordinator's message history to tool execution context, add per-turn invocation counter (max 2), broadcast sub-topic progress items |
| `examples/research-pilot/agents/local-paper-lookup.ts` | Fuzzy title matching for better deduplication |
| `examples/research-pilot/agents/metadata-enrichment.ts` | **New file.** Non-LLM metadata enrichment: query Semantic Scholar / CrossRef to fill missing DOI, abstract, venue, citationCount. Shares searcher's rate limiter and circuit breaker. |
| `examples/research-pilot/agents/prompts/index.ts` | New planner prompt (accepts structured context with local library state + previous coverage; generates full search plan with sub-topics), improved reviewer prompt (rubric + negative examples + forced ranking) |
| `examples/research-pilot/types.ts` | Add `PATHS.reviews` for disk-based review output, `SearchPlan`, `CoverageTracker`, `PlannerContext` types |

---

## 6. Expected Impact

| Metric | Current (v1) | Target (v2) |
|--------|-------------|-------------|
| `literature-search` calls per user message | 10-15 | 1-2 |
| Internal LLM calls per user message | 45-60 | 4-8 |
| External API calls per user message | 150+ | 30-60 |
| API failure rate | ~30% (cascade failures) | <5% (circuit breaker) |
| Total prompt tokens (coordinator + internal) | ~700K | ~100-150K |
| Wall clock time | 30 minutes | 3-5 minutes |
| Papers auto-saved | 75 (many marginal) | 25-40 (focused) |
| Precision (% of saved papers truly relevant) | ~50% | ~80%+ |

---

## 7. Non-Goals

- **Semantic search on full paper text** — We search titles/abstracts/keywords. Full-text search requires PDF download and indexing, which is a separate feature.
- **Citation graph traversal** — "Find papers cited by X" or "Find papers that cite X" is valuable but separate from search.
- **Real-time collaboration** — The search session is single-user, single-turn.
- **Custom source plugins** — The 4 built-in sources (Semantic Scholar, arXiv, OpenAlex, DBLP) are sufficient for now.
- **Brave web search as a fallback source** — Too noisy, hard to extract structured metadata. Academic APIs are sufficient.

---

## 8. Decisions (Resolved)

### 8.1 Search plan visible to the user — YES

The planner's output (sub-topics, query batches, expected paper counts) is broadcast to the UI via the existing `todo-update` / `agent:activity` IPC channels. This gives users:

- **Confidence**: "The agent has a plan, it's searching 4 sub-topics with 12 queries"
- **Early intervention**: If the plan looks wrong ("why is it searching for scheduling?"), the user can stop and redirect
- **Progress tracking**: Each sub-topic shows as a progress item (pending → in_progress → done)

Implementation: After the planner completes, emit one `todo-add` per sub-topic:
```typescript
for (const subTopic of plan.subTopics) {
  emitTodo({
    id: `lit-subtopic-${subTopic.name}`,
    title: `Search: ${subTopic.name} (${subTopic.queries.length} queries)`,
    status: 'pending'
  })
}
```

As the searcher completes each batch, mark the corresponding sub-topic as done with a paper count.

### 8.2 Incremental search sessions — YES (via filtered conversation passthrough, no new tools)

Incremental sessions work automatically through the **filtered conversation passthrough** design (section 3.2b). No new parameters, no disk-based state management for coverage.

#### How it works

1. The `literature-search` tool result includes a compact `coverage` block (section 3.2g) — this becomes part of the coordinator's conversation history as a tool output.
2. On the next `literature-search` call, the coordinator's full message history flows into the tool execution context.
3. The literature team runs `filterConversationForPlanner()` — this mechanically extracts user messages + all previous `literature-search` results (including their coverage blocks).
4. The planner sees the exact previous coverage and generates a targeted plan.

**No lossy summarization by the coordinator.** The planner sees the raw coverage data from all previous searches, not a coordinator-written summary that might omit details.

```
Turn 1:
  User: "comprehensive study on HPC operational logs"
  Coordinator → literature-search(query="comprehensive study on HPC operational logs")
  Tool result (now in coordinator's message history):
    {
      briefSummary: "Found 35 papers across 4 sub-topics...",
      coverage: {
        score: 0.75,
        subTopics: [
          { name: "log parsing", paperCount: 12, covered: true, gaps: [] },
          { name: "anomaly detection", paperCount: 10, covered: true, gaps: [] },
          { name: "root cause analysis", paperCount: 3, covered: false,
            gaps: ["microservice RCA", "causal inference methods"] },
          { name: "HPC system logs", paperCount: 10, covered: true, gaps: [] }
        ],
        queriesExecuted: ["log parsing Drain Spell...", "DeepLog anomaly...", ...]
      }
    }

Turn 2:
  User: "search more on root cause analysis"
  Coordinator → literature-search(query="root cause analysis in distributed systems")

  Inside literature-search:
    filteredHistory = filterConversationForPlanner(context.messages)
    // filteredHistory contains:
    //   [user] "comprehensive study on HPC operational logs"
    //   [tool-result: literature-search] { coverage: { ... root cause: 3 papers, gaps: [...] } }
    //   [user] "search more on root cause analysis"

  Planner sees ALL of this directly:
    - Previous coverage: root cause analysis has 3 papers, gaps in microservice RCA + causal inference
    - Queries already executed → generates different ones
    - User specifically asked for root cause analysis → focus plan on that sub-topic only
    - Log parsing already has 12 papers → skip entirely
```

**Why this is robust:**
- Works for any number of previous searches — all `literature-search` results are in the history
- No state management, no disk persistence for coverage state
- The planner sees the exact data, not a lossy coordinator summary
- If the user corrected the agent mid-conversation ("no, I meant cloud logs not HPC logs"), the planner sees that correction in the user messages

**Disk persistence is still useful** for the full review (`.research-pilot/reviews/<id>.md` and `<id>-papers.json`) so the user can `read` the full literature review. But coverage state travels through the conversation history, not through disk.

---

## 9. Updated Implementation Plan

### Phase 1: Quick wins (high impact, low effort)

1. **Raise auto-save threshold to ≥8** — Single constant change
2. **Add per-turn invocation limit (max 2)** — Prevents the coordinator from calling `literature-search` 15 times
3. **Add circuit breaker to searcher** — Stop hitting failed APIs after 3 consecutive failures
4. **Compress tool result with coverage state** — Return brief summary + coverage + disk paths. Coverage in tool output enables incremental sessions via coordinator context (no new tools)

### Phase 2: Planner overhaul + context assembly

5. **Planner context assembly** — Before calling planner LLM, scan local library for topic clusters and parse coordinator-provided context for previous coverage state (section 3.2b)
6. **Restructure planner to generate full search plan** (sub-topics + query batches + stopping criteria)
7. **Execute all queries in one session** with rate limiting and priority ordering
8. **Cumulative coverage tracking** — Reviewer scores all papers once, not per-batch
9. **Broadcast search plan to UI** — Emit todo items per sub-topic for progress visibility

### Phase 3: Searcher robustness + metadata enrichment

10. **Metadata enrichment step** — After deduplication, query Semantic Scholar / CrossRef to fill missing DOI, abstract, venue, citationCount (section 3.2d). No LLM, pure API lookups.
11. **Per-source rate limiting** with configurable limits (shared between search and enrichment)
12. **Global API call cap** (max 60 per session, including enrichment calls)
13. **Session timeout** (2 minutes max for all searches)
14. **Better deduplication** — Fuzzy title matching (Levenshtein distance < 10% of title length)

### Phase 4: Quality improvements

15. **Improved reviewer prompt** with explicit rubric, negative examples, forced ranking
16. **Relevance justification** required for each scored paper
17. **Save full review to disk** instead of passing through context
