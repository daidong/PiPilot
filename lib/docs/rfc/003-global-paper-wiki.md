# RFC-003: Global Paper Wiki

**Status:** Proposed
**Author:** Captain + Claude
**Date:** 2026-04-11

## 1. Motivation

The Research Copilot currently stores paper knowledge per-project (`.research-pilot/artifacts/papers/`). Literature search results are siloed — project B cannot leverage papers discovered in project A. A user researching RAG in one project and multi-agent systems in another ends up with two disconnected knowledge stores, with no cross-referencing, no shared concept synthesis, and no accumulated understanding.

This RFC proposes a **global paper wiki** at `~/.research-pilot/paper-wiki/` that:
- Accumulates cross-project knowledge as LLM-generated, interlinked Markdown pages
- Is maintained by a background wiki sub-agent, fully async and decoupled from the coordinator
- Provides the coordinator read-only access to pre-synthesized knowledge via a `wiki_lookup` tool
- Supports two content tiers: full-text (arXiv PDFs auto-downloaded) and abstract-only
- Is configured and monitored from a dedicated tab in the global Settings modal

Inspired by the [LLM Wiki](https://github.com/nickchua/llm-wiki) pattern: the LLM incrementally builds and maintains a persistent wiki rather than re-deriving knowledge from raw sources on every query.

### Design Axiom

> The system does not pursue complex architecture to guarantee quality. Instead, it pursues minimum discipline to guarantee survival + evidence-driven incremental improvement.

The wiki is a pure enhancement. Every failure path degrades to "wiki doesn't exist" behavior. The coordinator must function identically without it. **The wiki agent does not run by default** — it must be explicitly enabled and configured by the user in Settings.

## 2. Architecture Overview

Three layers:

1. **Deterministic code layer**: scanning project directories for paper artifacts, watermark management, arXiv PDF download, index/log maintenance, file I/O
2. **LLM generation layer**: paper page generation, concept identification, concept page synthesis, cross-reference creation
3. **Integration layer**: coordinator reads wiki via `wiki_lookup` tool (read-only)

The wiki sub-agent is the **single writer**. The coordinator never writes to the wiki. This is enforced by an in-process serial queue + cross-process lock file.

## 3. Wiki Directory Structure

```
~/.research-pilot/paper-wiki/
├── SCHEMA.md              # Wiki conventions (LLM reference doc)
├── index.md               # Content catalog organized by section
├── log.md                 # Chronological operation log (append-only)
├── papers/                # One .md per paper (keyed by canonical slug, see §4.3)
├── concepts/              # Cross-paper synthesis pages (keyed by LLM-assigned slug, see §4.3)
├── raw/arxiv/             # Downloaded arXiv PDFs (cached)
├── converted/             # PDF → Markdown (cached)
└── .state/
    ├── processed.jsonl    # Page-generation watermark (keyed by canonicalKey)
    ├── provenance.jsonl   # Provenance tracking (separate from generation decisions)
    └── wiki.lock          # Lock file for cross-process single-writer
```

## 4. Canonical Paper Identity

### Divergence from Project-Level Dedup

The existing `findExistingPaperArtifact()` (`store.ts:511`) uses **DOI > citeKey > title+year** for within-project dedup. The wiki uses a different priority for **cross-project global identity**:

**DOI > arxivId > normalized(title+year)**

Rationale: `citeKey` is generated from author+year (e.g., `smith2024`) and is not globally unique — different projects might generate different citeKeys for the same paper. `arxivId` is a stable external identifier that uniquely identifies a paper across all projects. This is a deliberate divergence, not a reuse of the project-level logic.

```typescript
import { normalizeDoi } from '../memory-v2/store.js'  // reuse existing

export function computeCanonicalKey(artifact: PaperArtifact): CanonicalPaperIdentity {
  // Priority 1: DOI (most authoritative)
  if (artifact.doi && !artifact.doi.startsWith('unknown:')) {
    return { canonicalKey: `doi:${normalizeDoi(artifact.doi)}`, keySource: 'doi' }
  }
  // Priority 2: arXiv ID (stable external identifier — NOT in project-level dedup)
  if (artifact.arxivId) {
    const bareId = artifact.arxivId
      .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      .replace(/v\d+$/, '')
    return { canonicalKey: `arxiv:${bareId}`, keySource: 'arxivId' }
  }
  // Priority 3: normalized title + year (fallback)
  const title = artifact.title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { canonicalKey: `title:${title}:${artifact.year ?? 'nd'}`, keySource: 'title+year' }
}
```

### Semantic Hash

Only hashes fields that affect wiki content quality. Excluded: `id`, `createdAt`, `updatedAt`, `provenance`, `addedInRound`, `addedByTask`, `tags`, `summary`, `contentRef`, `searchKeywords`, `enrichmentSource`, `enrichedAt`, `identityConfidence`, `bibtex`, `citeKey`, `pdfUrl`, `pubmedId`, `semanticScholarId`.

```typescript
export function computeSemanticHash(artifact: PaperArtifact): string {
  const projection = {
    title: artifact.title,
    authors: artifact.authors,
    abstract: artifact.abstract,
    year: artifact.year,
    venue: artifact.venue,
    doi: artifact.doi,
    arxivId: artifact.arxivId,
    keyFindings: artifact.keyFindings,
    relevanceJustification: artifact.relevanceJustification,
    subTopic: artifact.subTopic,
    fulltextPath: artifact.fulltextPath,
  }
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex').slice(0, 16)
}
```

### Watermark & Provenance (Separated)

Generation decisions and provenance are tracked in **separate files**:

- `processed.jsonl`: keyed by `canonicalKey`. Tracks `semanticHash`, `fulltextStatus`, `generatorVersion`. Determines whether a page needs (re-)generation.
- `provenance.jsonl`: keyed by `canonicalKey`. Tracks which `(projectPath, paperId)` pairs contributed each paper. Updated independently — a new project contributing an existing paper is a provenance-only update with no LLM cost.

**Fulltext status has three states**:
- `fulltext`: arXiv PDF successfully downloaded and converted
- `abstract-only`: paper has no arXiv ID, abstract is the only source
- `abstract-fallback`: paper has arXiv ID but download/conversion failed. **Automatically re-promoted** on subsequent scans when markitdown becomes available or download succeeds.

**`generatorVersion`**: bumped when wiki prompts change. All pages with older version are re-processed at paced rate.

### Slug Rules (File Naming)

Paper page filenames are derived deterministically from the canonical key:

```typescript
export function canonicalKeyToSlug(canonicalKey: string): string {
  // 'doi:10.1234/foo.bar' → 'doi-10-1234-foo-bar'
  // 'arxiv:2301.12345'    → 'arxiv-2301-12345'
  // 'title:attention is all you need:2017' → 'title-attention-is-all-you-need-2017'
  return canonicalKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
    .slice(0, 120)                  // hard length limit
}
```

- **Max 120 chars** (safe for all filesystems; 80 was too short for DOIs with long suffixes)
- **Collision handling**: not expected for DOI and arXiv keys (globally unique by definition). For `title+year` fallback: if `papers/{slug}.md` already exists with a different canonical key, append `-2`, `-3`, etc. This is checked at write time by `writePaperPage()`.
- **Concept slugs**: assigned by the LLM in the `wiki-concept-identify` step. Validated by code: lowercased, non-alphanumeric replaced, max 60 chars. Collisions resolved the same way.
- **Slug stability**: once a page is written, its slug is recorded in the watermark. Subsequent updates use the same slug even if the canonical key format changes.

## 5. Wiki Agent Configuration (Settings UI)

The wiki agent is configured through a dedicated **"Paper Wiki"** tab in the global Settings modal (`SettingsModal.tsx`). The agent **does not run by default** — the user must select a model to enable it.

### Settings Tab Design

A new `'paper-wiki'` tab added to `SettingsModal`, using the existing tab pattern (sidebar nav with icon + label). Icon: `BookMarked` from lucide-react.

**Tab content has two sections:**

#### Section 1: Configuration

**Model selection** — a dropdown listing all models from `SUPPORTED_MODELS` (same list as the main model selector), grouped by provider. Default: `'none'` (disabled). When set to `'none'`, the wiki agent does not run.

```
Wiki Agent Model
[Dropdown: None (disabled) ▾]
  ── OpenAI ──
  GPT-5.4
  GPT-5.4 Mini
  GPT-5.4 Nano
  ...
  ── Anthropic ──
  Claude Opus 4.6
  Claude Sonnet 4.5
  Claude Haiku 4.5
  ...
```

A note below the dropdown: *"Changes take effect after app restart."*

**Processing speed** — a `SegmentedControl` with three presets (same component as Research settings):

| Preset | Label | papersPerCycle | cycleCooldown | interCallDelay |
|--------|-------|----------------|---------------|----------------|
| `'slow'` | Slow | 1 | 10 min | 8s |
| `'medium'` | Medium | 2 | 5 min | 5s |
| `'fast'` | Fast | 3 | 2 min | 3s |

Default: `'medium'`. Description text updates per selection:
- Slow: "Minimal resource usage. Best for subscription plans with tight limits."
- Medium: "Balanced processing. Suitable for most users."
- Fast: "Processes papers quickly when idle. Uses more API calls."

#### Section 2: Status Dashboard

Below the configuration, a status section showing wiki agent runtime info. This replaces the StatusBar indicator — the Settings tab has ample space for detailed information.

```
── Status ──────────────────────────────────

State:    ● Processing (2 of 8 pending)     ← or "Idle", "Paused", "Disabled"
Papers:   47 in wiki (12 fulltext, 35 abstract)
Concepts: 23 pages
Last run: 2 minutes ago (processed 2 papers)

── Recent Activity ─────────────────────────

Apr 11 14:32  Processed "Attention Is All You Need" (fulltext)
Apr 11 14:31  Processed "BERT: Pre-training..." (abstract)
Apr 11 14:25  Processed "GPT-4 Technical Report" (fulltext)
Apr 11 14:20  Started cycle — 5 papers pending
...
```

Implementation:
- **State**: derived from wiki agent's `onStatus` callback, pushed to renderer via IPC (`wiki:status` event). **Not persisted to settings** — this is transient runtime state, not configuration. On settings tab open, the renderer requests current status via a one-shot IPC invoke (`wiki:get-status`).
- **Paper/concept counts**: computed by reading wiki directory on settings tab open (lightweight FS scan via IPC invoke `wiki:get-stats`, not on every render).
- **Recent activity**: last 20 entries from `log.md`, read via IPC invoke `wiki:get-log` on tab open.
- **Styling**: uses existing patterns — `text-xs t-text` for labels, `text-[11px] t-text-muted` for values, `rounded-lg border t-border t-bg-surface/50 p-3` for section containers

### Settings Type Changes

```typescript
// In shared-ui/settings-types.ts

export type WikiAgentSpeed = 'slow' | 'medium' | 'fast'

export interface WikiAgentSettings {
  /** Model ID (e.g., 'anthropic:claude-haiku-4-5-20251001'). 'none' = disabled. */
  model: string
  /** Processing speed preset */
  speed: WikiAgentSpeed
}

export interface AppSettings {
  research: ResearchSettings
  dataAnalysis: DataAnalysisSettings
  wikiAgent: WikiAgentSettings          // NEW
}

export const DEFAULT_SETTINGS: AppSettings = {
  research: { ... },
  dataAnalysis: { ... },
  wikiAgent: {
    model: 'none',                      // disabled by default
    speed: 'medium',
  },
}
```

Resolver:
```typescript
export function resolveWikiPacing(speed: WikiAgentSpeed): WikiPacingConfig {
  switch (speed) {
    case 'slow':   return { papersPerCycle: 1, cycleCooldownMs: 600_000, interCallDelayMs: 8_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
    case 'medium': return { papersPerCycle: 2, cycleCooldownMs: 300_000, interCallDelayMs: 5_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
    case 'fast':   return { papersPerCycle: 3, cycleCooldownMs: 120_000, interCallDelayMs: 3_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
  }
}
```

### Model and Speed Changes Require Restart

When the user changes the wiki model or speed:
- Settings are auto-saved (existing 300ms debounce pattern)
- A note is displayed: *"Changes take effect after app restart."*
- On next app launch, `ipc.ts` reads the saved config and creates the wiki agent with the new model/speed
- This avoids the complexity of hot-reloading the wiki agent mid-session

## 6. Pacing & Rate Control

The wiki agent is a **low-priority, long-horizon background task**. It must never compete with the user's foreground LLM calls or exhaust subscription quotas.

### Pacing Model

```
User does 2 literature searches → 25 papers saved
User stops chatting → 30s idle → wiki agent resumes

Cycle 1: scan → pick 2 papers → process (~40s active) → sleep 5 min
Cycle 2: scan → pick 2 papers → process (~40s active) → sleep 5 min
... (25 papers ÷ 2/cycle = ~13 cycles ≈ 70 minutes total) ...
All done → idle scan every 2 min (no LLM calls)

If user starts chatting at ANY point → immediate pause
Wiki resumes only after ALL windows idle for 30s again
```

(Numbers above are for `'medium'` speed preset.)

### Cost Analysis

Per paper: ~4 LLM calls (1 page + 1 concept identify + ~2 concept updates). At 5s gaps: ~20s active per paper. Per cycle (2 papers): ~40s active + 5min cooldown. For 25 papers: ~70 minutes, ~100 LLM calls, only during user idle time.

### Interruption Safety

`shouldContinue()` is checked before each paper, before each LLM call, and after each delay. Mid-batch interruption is safe because:
- Concept page updates are idempotent (marker-based replace, not append)
- Unfinished papers are not marked in watermark → retried next cycle
- The minimum interruption unit is one paper (completes current paper before pausing)

### New Papers During Processing

Each cycle does a fresh scan. Papers added during cycle N are discovered at cycle N+1. No event queue needed — the scan + watermark design inherently prevents missed papers. Maximum discovery latency = `cycleCooldownMs`.

### Processing Order

Newest-first (by artifact `createdAt`). The user most likely cares about papers from their most recent search.

## 7. Wiki Sub-Agent

### Interface

```typescript
export interface WikiAgent {
  start(): void       // begin background loop (after startupDelay)
  pause(): void       // coordinator became active
  resume(): void      // all coordinators idle for 30s
  destroy(): void     // permanent cleanup
  runOnce(): Promise<{ processed: number; errors: number }>  // testable single pass
  readonly isActive: boolean
}

export function createWikiAgent(config: WikiAgentConfig): WikiAgent
```

### WikiAgentConfig

```typescript
export interface WikiAgentConfig {
  /** callLlm function configured for the wiki model (from settings) */
  callLlm: (systemPrompt: string, userContent: string) => Promise<string>
  /** Returns current active project paths */
  projectPaths: () => string[]
  /** Pacing from resolved speed preset */
  pacing: WikiPacingConfig
  /** Status callback for Settings dashboard */
  onStatus?: (status: WikiStatus) => void
  debug?: boolean
}

export interface WikiStatus {
  state: 'processing' | 'idle' | 'paused' | 'disabled'
  processed: number     // papers processed this session
  pending: number       // papers pending in current scan
  totalInWiki: number   // total paper pages in wiki
  lastRunAt?: string    // ISO timestamp
}
```

Key difference from previous versions: `callLlm` is a direct function (not a thunk), configured at app startup from the wiki model setting. Since model changes require restart, there's no need for dynamic resolution.

### Lifecycle State Machine

```
                   start()
[Created] ──────────────────► [Idle Scanning]
                                  │
                        scan finds work
                                  │
                                  ▼
                           [Processing]  ◄── resume()
                            │         │
                  batch done │         │ pause() or user active
                            ▼         ▼
                       [Cooldown]   [Paused]
                            │         │
                  timer fires│         │ resume() after all idle 30s
                            ▼         ▼
                       [Idle Scanning] ◄──┘
                                  │
                        destroy()
                                  ▼
                            [Destroyed]
```

### Core: `processSinglePass()`

The testable core function (exposed via `runOnce()`):

1. `acquireProcessLock()` → held by another process? skip
2. `withWikiLock()` for in-process serialization
3. `ensureWikiStructure()`
4. `scanForNewContent()` → sorted newest-first
5. Handle `provenance-only` entries immediately (no LLM)
6. Take at most `pacing.papersPerCycle` papers from remaining
7. For each paper:
   - `shouldContinue()` → break if paused/destroyed
   - Download + convert arXiv PDF (if applicable, with 3s arXiv rate limit)
   - Generate paper page (`interCallDelayMs` between LLM calls)
   - `shouldContinue()` check
   - Identify concepts (+ delay)
   - `shouldContinue()` check
   - Generate/update concept pages (+ delay between each, idempotent markers)
   - Write paper page + concept pages (all atomic writes)
   - `markPaperProcessed()` + `addProvenance()`
   - `appendLog()`
   - Emit `onStatus` with updated counts
8. `rebuildIndex()` (atomic write)
9. Release locks
10. Return `{ processed, errors, pendingRemaining }`

### Scheduling

```typescript
function scheduleNext(result: PassResult) {
  if (destroyed) return
  if (result.pendingRemaining > 0) {
    timer = setTimeout(tick, pacing.cycleCooldownMs)
  } else {
    timer = setTimeout(tick, pacing.idleScanIntervalMs)
  }
}
```

## 8. LLM Integration

### Model Selection

The wiki agent uses its **own dedicated model**, configured by the user in the Paper Wiki settings tab. This is independent of the main coordinator's model.

At app startup, `ipc.ts` reads `settings.wikiAgent.model` from `~/.research-copilot/config.json`. If `'none'`, no wiki agent is created. Otherwise, auth is resolved via `resolveCoordinatorAuth()` (the same function the coordinator uses, `shared-electron/ipc-base.ts:264`). This correctly handles all three auth paths:

- **`openai:*`** → reads `OPENAI_API_KEY` from env (loaded from config.json)
- **`anthropic:*`** → reads `ANTHROPIC_API_KEY` from env
- **`openai-codex:*`** → loads Codex OAuth credentials via `loadCodexCredentials()`, including token refresh

The model is then resolved via `getPiModel()` and a `callLlm` closure constructed with `completeSimple()`. For `openai-codex` models, the `callLlm` closure must use the same `getApiKeyOverride` pattern as the coordinator (async getter that refreshes expired tokens).

```typescript
// In ipc.ts, during registerIpcHandlers() (app startup, before any coordinator exists):
const wikiSettings = loadedSettings.wikiAgent
if (wikiSettings.model !== 'none') {
  const auth = resolveCoordinatorAuth(wikiSettings.model)  // handles all providers + codex OAuth
  const [provider, modelId] = wikiSettings.model.split(':')
  const model = getPiModel(provider, modelId)

  // For subscription auth, build an async key getter that refreshes expired tokens
  const resolveApiKey = auth.authMode === 'subscription'
    ? async () => {
        const creds = loadCodexCredentials()
        if (!creds) throw new Error('Codex credentials not found')
        if (creds.expires < Date.now() + 60_000) {
          const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
          const newCreds = await refreshOpenAICodexToken(creds)
          saveCodexCredentials(newCreds)
          return newCreds.access
        }
        return creds.access
      }
    : async () => auth.apiKey

  const callLlm = async (system: string, user: string) => {
    const currentKey = await resolveApiKey()
    const result = await completeSimple(model, {
      systemPrompt: system,
      messages: [{ role: 'user', content: user, timestamp: Date.now() }]
    }, { maxTokens: 4096, apiKey: currentKey })
    return result.content.find(c => c.type === 'text')?.text ?? ''
  }
  wikiAgent = createWikiAgent({
    callLlm,
    projectPaths: () => ...,
    pacing: resolveWikiPacing(wikiSettings.speed),
    onStatus: (status) => broadcastWikiStatus(status),
  })
  wikiAgent.start()
}
```

### Prompts (4 new entries in `lib/agents/prompts/index.ts`)

| Prompt Key | Purpose |
|------------|---------|
| `wiki-paper-abstract` | Structured paper page from metadata (summary, contributions, methodology, relevance, `[[concept-slug]]` wiki-links) |
| `wiki-paper-fulltext` | Same + deeper analysis from full text (specific results, limitations) |
| `wiki-concept-identify` | Given paper page + existing concepts → JSON array of 2-5 concepts |
| `wiki-concept-generate` | Generate concept contribution section wrapped in `<!-- paper:slug -->` markers |

All prompts <500 tokens. The concept-generate prompt outputs a **section** (not a full page) — page structure is managed by code.

### Idempotent Concept Updates

Each paper's contribution to a concept page is wrapped in HTML comment markers:

```markdown
<!-- paper:arxiv-2301-12345 -->
### From "Attention Is All You Need"
This paper introduces the self-attention mechanism...
<!-- /paper:arxiv-2301-12345 -->
```

On update: if markers for this paper exist → **replace** the section. If not → append. This makes concept updates safe against retry (no duplicate sections if `markPaperProcessed()` fails after concept write).

## 9. Coordinator Integration (Read-Only)

### `wiki_lookup` Tool

```typescript
export function createWikiLookupTool(): AgentTool
// name: 'wiki_lookup'
// params: { query: string, page?: string }
// Returns "Wiki not available" if wiki root doesn't exist
// All reads via safeReadFile (safe against concurrent wiki writes)
```

Registered in `createResearchTools()` alongside existing tools.

### System Prompt Addition (~50 tokens)

```
Paper Wiki:
- Use wiki_lookup to check the global paper wiki before launching new literature searches.
- The wiki contains pre-synthesized paper summaries and research concept pages.
- If wiki_lookup returns "Wiki not available", proceed normally.
```

## 10. IPC Layer: Activity Broker

### Multi-Window Coordination

The wiki agent is a **global singleton** (shared across all Electron windows). A refcount-based activity broker ensures it only runs when ALL windows are idle:

```typescript
let activeCoordinatorCount = 0

function onAnyCoordinatorActive() {
  activeCoordinatorCount++
  wikiAgent?.pause()
}

function onAnyCoordinatorIdle() {
  activeCoordinatorCount = Math.max(0, activeCoordinatorCount - 1)
  if (activeCoordinatorCount === 0) {
    wikiIdleTimer = setTimeout(() => wikiAgent?.resume(), 30_000)
  }
}
```

Wired in `agent:send` handler (brackets the `chat()` call). Scope: guards against competing with foreground turns.

### Wiki Status Broadcasting

The wiki agent's `onStatus` callback broadcasts status to all open windows via `safeSend(win, 'wiki:status', status)`. The Settings tab listens for this event to update its dashboard in real time.

### Lifecycle

- **App startup** (in `registerIpcHandlers()`): read `settings.wikiAgent.model` from config. If not `'none'`, resolve model via `getPiModel()`, construct `callLlm`, create and start wiki agent. This happens **before any coordinator exists** — the wiki agent is fully independent.
- **macOS window-all-closed** (app doesn't quit): wiki agent survives. `projectPaths()` → `[]`, sleeps.
- **`before-quit`**: wiki agent destroyed in `destroyAllCoordinators()`.
- **Settings change** (model or speed): saved to config, displayed note "Changes take effect after app restart."

## 11. Concurrency & Safety

| Mechanism | Purpose |
|-----------|---------|
| In-process serial queue (`withWikiLock`) | Prevents concurrent `processSinglePass()` calls within one app instance |
| Cross-process lock file (`wiki.lock` + PID) | Prevents concurrent writes from multiple app instances |
| Atomic file writes (tmp + rename) | Readers (wiki_lookup) never see partial files |
| Idempotent concept markers | Retry-safe concept page updates |
| Separate processed/provenance files | Provenance updates don't trigger page regeneration |
| Refcount activity broker | Wiki runs only when ALL coordinator windows are idle |

## 12. arXiv PDF Download

For papers with `arxivId`, the wiki agent downloads and converts the PDF:

1. Derive PDF URL: `http://arxiv.org/abs/XXXX` → `https://arxiv.org/pdf/XXXX.pdf`
2. Download to `raw/arxiv/` (skip if cached)
3. Convert via `markitdown` CLI to `converted/` (skip if cached)
4. On failure: fall back to abstract-only tier, mark as `abstract-fallback` (retried next cycle)

Rate limit: 3s between arXiv requests.

## 13. Files

### New Files (10)

| File | Description |
|------|-------------|
| `lib/wiki/types.ts` | Types, canonical identity, pacing config, `GENERATOR_VERSION` |
| `lib/wiki/scanner.ts` | Scanning, watermark, provenance, index, `getWikiRoot()` |
| `lib/wiki/lock.ts` | In-process queue + cross-process lock file |
| `lib/wiki/io.ts` | Atomic writes (tmp + rename), safe reads |
| `lib/wiki/downloader.ts` | arXiv PDF download + markitdown conversion |
| `lib/wiki/generator.ts` | LLM page generation, idempotent concept sections |
| `lib/wiki/agent.ts` | Background orchestrator with pacing, `runOnce()`, `onStatus` |
| `lib/wiki/tool.ts` | `wiki_lookup` AgentTool |
| `lib/wiki/index.ts` | Public API re-exports |
| `app/src/renderer/components/settings/WikiAgentSettings.tsx` | Settings tab: model dropdown, speed control, status dashboard |

### Modified Files (7)

| File | Change |
|------|--------|
| `shared-ui/settings-types.ts` | Add `WikiAgentSettings`, `WikiAgentSpeed`, resolver; extend `AppSettings` |
| `shared-electron/ipc-base.ts` | Extend `loadSettingsFromConfig()` merge to include `wikiAgent` key (currently only merges `research` + `dataAnalysis`); add `wiki:get-status`, `wiki:get-stats`, `wiki:get-log` IPC handlers |
| `lib/agents/prompts/index.ts` | 4 wiki prompts + wiki hint in `coordinator-system` |
| `lib/tools/index.ts` | Register `wiki_lookup` in `createResearchTools()` |
| `app/src/main/ipc.ts` | Wiki agent creation from settings (with `resolveCoordinatorAuth`), activity broker, `wiki:status` broadcast, lifecycle |
| `app/src/renderer/components/settings/SettingsModal.tsx` | Add `'paper-wiki'` tab to `TABS` and render `WikiAgentSettings` |
| `app/src/preload/index.ts` | Expose `wiki:status` listener + `wiki:get-status/stats/log` invokes in context bridge |

### Not Modified

| File | Reason |
|------|--------|
| `lib/types.ts` | PATHS stays project-relative. `getWikiRoot()` is sole wiki path entry point. |
| `lib/agents/coordinator.ts` | No longer needs to expose `callLlm`. Wiki has its own model. |
| `app/src/renderer/components/layout/StatusBar.tsx` | No wiki indicator in StatusBar; dashboard is in Settings tab. |

## 14. Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| No wiki model configured (default) | Wiki agent not created; `wiki_lookup` → "Wiki not available"; zero impact |
| No wiki dir | `wiki_lookup` → "Wiki not available" |
| Wiki agent fails to start | Caught; null; coordinator unchanged |
| LLM call fails | Paper skipped, retried next cycle |
| arXiv download fails | `abstract-fallback`, auto-promotes on retry |
| markitdown missing | All arXiv papers `abstract-fallback` |
| Same paper in 2 projects | Single wiki page; provenance tracks both |
| New paper during processing | Discovered at next cycle scan |
| 25 papers queued at once | Processed at configured speed over time |
| User starts chatting | Immediate pause, current paper finishes |
| Subscription quota concern | User chooses 'slow' speed; 1 paper/10min |
| Model change in settings | Takes effect after app restart |
| All windows closed (macOS) | Agent survives, sleeps |
| Concept write then crash | Retry: idempotent markers, no duplication |
| `GENERATOR_VERSION` bump | All pages re-processed at paced rate |
| Existing settings without `wikiAgent` key | `DEFAULT_SETTINGS` fills in `{ model: 'none', speed: 'medium' }` |

## 15. Verification Plan

1. `computeCanonicalKey()`: DOI normalization, arXiv URL/bare/version, title+year
2. `computeSemanticHash()`: excluded fields don't change hash
3. `scanForNewContent()`: all 5 reasons + newest-first ordering
4. Cross-project dedup: same paper → single canonical entry
5. `deriveArxivPdfUrl()` URL format variants
6. Lock: queue serialization, PID check
7. Atomic writes: concurrent read during write sees complete file
8. Idempotent concept markers: duplicate run doesn't duplicate sections
9. Pacing: `runOnce()` with 5 papers, `papersPerCycle=2` → processes exactly 2, reports 3 pending
10. Pause mid-batch: completes current paper, stops, reports pending
11. `shouldContinue()` checks: mock pause → no LLM call after pause
12. `wiki_lookup`: graceful fallback when empty/missing
13. Settings: default `model: 'none'` → no wiki agent created
14. Settings: select model → restart → wiki agent starts processing
15. Settings: speed change → restart → pacing matches preset
16. Settings tab: status dashboard shows correct counts from `onStatus` + `log.md`
17. Manual: app start with configured model (no chat needed) → first cycle after 60s → papers processed
18. Manual: chat during processing → pause → resume after idle
19. Build: `npx electron-vite build` passes

## 16. Decisions on Open Questions

### UI Indicator

Status dashboard is in the **Paper Wiki settings tab**, not in the StatusBar. The settings tab has ample space for detailed information: current state, paper/concept counts, fulltext vs abstract breakdown, and a scrollable recent activity log from `log.md`.

### Manual Trigger / Force Regeneration: Not now

Deferred. The paced background processing is sufficient for the initial release.

### User Annotations: Not now

Deferred. All wiki content is fully LLM-generated and may be regenerated on `GENERATOR_VERSION` bump.

## 17. Future Considerations

- **Manual trigger**: command palette action to process a specific paper or force full re-scan
- **User annotations**: `<!-- user -->...<!-- /user -->` protected sections that survive regeneration
- **Wiki search tool**: as wiki grows beyond ~200 pages, `index.md` scanning may become insufficient. Consider integrating a local search engine (e.g., `qmd`) at that scale.
- **Non-paper knowledge**: extending the wiki to user-generated notes and analyses. Requires an explicit "publish to global wiki" mechanism to prevent WIP content leaking across projects.
