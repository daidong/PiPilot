# RFC-009: Memory System Architecture Redesign

**Status**: Draft
**Author**: AI Agent Design Team
**Created**: 2026-02-04
**Target**: AgentFoundry Framework + Research Pilot

---

## Abstract

This RFC proposes a comprehensive redesign of the memory system to address semantic explosion, boundary confusion, and budget bypass issues. The solution introduces a three-layer entity model (Canonical → View → Index), separates UI pinning from AI context inclusion, and integrates session memory into the budget-controlled StateSummary phase.

---

## Problem Summary

Current memory system has several critical issues:

1. **Semantic Explosion**: `save-note` auto-pins everything, flooding Pinned Phase with irrelevant content
2. **Boundary Confusion**: No separation between UI pinning (display) and AI pinning (context inclusion)
3. **Session Memory Bypass**: Injected as message prefix, bypassing budget system
4. **No Content Shape Control**: `formatEntityForContext()` generates uncontrolled long text
5. **No Admission Control**: No limits on what enters AI context
6. **No Dedup Mechanism**: Duplicate entities accumulate without detection

---

## Design Principles (Invariants)

1. **Canonical Authority**: Disk JSON files are the only source of truth
2. **Context = Views**: Everything in LLM context is a "view" with traceable pointers
3. **Pinned = Stable Anchors**: Small, curated set of project essentials (max 5)
4. **Selected = Task-Relevant**: Driven by current query + retrieval + explicit selection
5. **Session Memory = Control Plane**: Short-term state only, not knowledge storage
6. **Explainable Inclusion**: Every context item must have a reason for inclusion

---

## Solution Overview

### Three-Layer Entity Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Memory System Architecture                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Layer 1: Canonical (Disk Authority)                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  .research-pilot/                                                    │    │
│  │  ├── notes/*.json        (NoteEntity)                               │    │
│  │  ├── literature/*.json   (PaperEntity)                              │    │
│  │  ├── data/*.json         (DataEntity)                               │    │
│  │  └── dashboard.json      (ProjectDashboard)                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  Layer 2: Derived Views (Rebuildable Cache)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  memoryStorage (pinned views)                                        │    │
│  │  StateSummary (session memory + todos + tool pointers)               │    │
│  │  HistoryIndex (compressed conversation segments)                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                               │
│                              ▼                                               │
│  Layer 3: Context Assembly (Per-Request)                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  SelectionPlanner → ShapeFitter → Context Pipeline                   │    │
│  │  (relevance ranking)  (budget fitting)  (5-phase assembly)          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Entity Schema Upgrade

### 1.1 New PinPolicy Structure

```typescript
// src/types/memory-entity.ts
export interface PinPolicy {
  uiPinned: boolean       // UI display fixed (user experience)
  aiPinned: boolean       // AI context anchor candidate
  selectedForAI: boolean  // Task-relevant selection candidate
  aiPinnedReason?: string // Required when aiPinned=true
  aiPinnedAt?: string     // Timestamp of AI pin
  aiPinnedUntil?: string  // Optional TTL for temporary elevation
}
```

### 1.2 Enhanced MemoryEntity Base Interface

```typescript
export interface MemoryEntity {
  id: string
  type: 'note' | 'literature' | 'data' | 'task'
  revision: number                    // Monotonic, for conflict resolution
  createdAt: string
  updatedAt: string

  // Metadata
  title: string
  tags: string[]

  // Pin policy (NEW)
  pinPolicy: PinPolicy

  // Content layering (NEW)
  summaryCard: string                 // Strict limit: ≤300 tokens
  summaryCardMethod: 'deterministic' | 'llm' | 'user'
  summaryCardHash?: string            // For change detection
  canonicalPath: string               // Entity JSON path
  payloadRef?: string                 // Long content file path

  // Tracking
  provenance: Provenance
  contentHash?: string                // For dedup

  // Relations
  links?: EntityLink[]
}
```

### 1.3 Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/types/memory-entity.ts` | CREATE | New unified entity types |
| `examples/research-pilot/types.ts` | MODIFY | Extend existing types with pinPolicy, summaryCard |

---

## Phase 2: SummaryCard Generator

### 2.1 Generation Strategy (Hybrid)

**Decision**: Deterministic first, LLM only when needed

```typescript
// src/core/summary-card.ts
export interface SummaryCardConfig {
  maxTokens: number          // Default: 300
  llmThreshold: number       // Default: 800 tokens (trigger LLM above this)
  llmMaxOutput: number       // Default: 200 tokens
}

export class SummaryCardGenerator {
  generate(input: SummaryCardInput): SummaryCardResult {
    // Step A: Deterministic card generation
    const deterministicCard = this.generateDeterministic(input)

    // Step B: Check if LLM needed
    if (this.shouldUseLLM(input, deterministicCard)) {
      const llmCard = await this.generateWithLLM(input)
      if (llmCard.success) {
        return { card: llmCard.content, method: 'llm' }
      }
    }

    // Step C: Fallback to deterministic
    return { card: deterministicCard, method: 'deterministic' }
  }

  private generateDeterministic(input: SummaryCardInput): string {
    // Structure: Title + Tags + Key points + Signals
    // Key point extraction: prioritize sentences with:
    // - Numbers, percentages, units
    // - Comparison words (vs, baseline, improve)
    // - Conclusion words (found, conclusion, decision, recommend)
  }

  private shouldUseLLM(input: SummaryCardInput, deterministic: string): boolean {
    return (
      input.contentTokens > this.config.llmThreshold ||
      this.hasLowInfoDensity(deterministic) ||
      ['decision', 'literature-review', 'meeting-minutes'].includes(input.noteType)
    )
  }
}
```

### 2.2 Thresholds

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `NoteCardMaxTokens` | 300 | Balance between info density and context budget |
| `LongNoteThreshold` | 800 | Trigger LLM summarization above this |
| `LLM Max Output` | 200 | Leave room for title/tags in card |
| `LLM Trigger Rate` | 10-25% | Control cost |

---

## Phase 3: Pin Semantics Separation

### 3.1 Default Behaviors

| Tool | uiPinned | aiPinned | selectedForAI |
|------|----------|----------|---------------|
| `save-note` | `true` | `false` | `true` |
| `save-paper` | `false` | `false` | `true` |
| `save-data` | `false` | `false` | `true` |

### 3.2 aiPinned Admission Control

**Decision**: Hard limit of 5 with category quotas

```typescript
// Category quotas (soft guidance)
const AI_PINNED_QUOTAS = {
  dashboard: 1,      // Project Dashboard (required)
  constraint: 1,     // Project Constraints / Research Goal
  schema: 1,         // Current Dataset Schema
  decision: 2,       // Key Decisions / Canonical Methods
}
const AI_PINNED_MAX = 5
```

### 3.3 New pin-to-ai Tool

```typescript
// tools/pin-to-ai.ts
export const pinToAI = defineTool({
  name: 'pin-to-ai',
  description: 'Promote an entity to AI context anchor (max 5 allowed)',
  parameters: {
    entityId: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    category: {
      type: 'string',
      enum: ['dashboard', 'constraint', 'schema', 'decision', 'other'],
      required: true
    },
    ttlHours: { type: 'number', required: false }  // Optional temporary elevation
  },
  execute: async (input, ctx) => {
    const currentCount = await countAiPinnedEntities(ctx)
    if (currentCount >= AI_PINNED_MAX) {
      return {
        success: false,
        error: `AI pinned limit reached (max ${AI_PINNED_MAX}). Unpin something first.`,
        suggestions: await getUnpinSuggestions(ctx)  // Least recently used
      }
    }
    // Update entity pinPolicy
  }
})
```

---

## Phase 4: SelectionPlanner + ShapeFitter

### 4.1 SelectionPlanner

```typescript
// src/context/selection-planner.ts
export interface SelectionItem {
  entityId: string
  entityType: string
  source: 'pinned-anchor' | 'pinned-pool' | 'selected' | 'mention' | 'retrieval'
  relevanceScore: number
  requestedShape: ContentShape  // 'card' | 'excerpt' | 'full'
  actualShape?: ContentShape
  tokens: number
  reason: string
}

export interface SelectionPlan {
  pinnedAnchors: SelectionItem[]    // aiPinned entities (all loaded, no ranking)
  selected: SelectionItem[]         // Task-relevant (ranked by relevance)
  excludedItems: Array<{ entityId: string; reason: string }>
}

export class SelectionPlanner {
  plan(options: PlanOptions): SelectionPlan {
    // 1. Collect Pinned Anchors (all aiPinned=true, ≤5)
    const anchors = this.collectPinnedAnchors()

    // 2. Collect Selected candidates (mentions + explicit + retrieval)
    const candidates = this.collectSelectedCandidates(options)

    // 3. Rank by relevance (pluggable strategy)
    const ranked = this.relevanceScorer.rank(candidates, options.query)

    // 4. Dedup (same entity shouldn't appear in both)
    return this.dedup(anchors, ranked)
  }
}
```

### 4.2 RelevanceScorer (Pluggable)

**Decision**: Pluggable strategy, default hybrid (keyword coarse + embedding fine)

```typescript
// src/context/relevance-scorer.ts
export interface RelevanceScorer {
  rank(items: SelectionItem[], query: string): SelectionItem[]
}

// Default implementation: Hybrid
export class HybridRelevanceScorer implements RelevanceScorer {
  rank(items: SelectionItem[], query: string): SelectionItem[] {
    // Step 1: Keyword-based coarse ranking (top-N)
    const keywordRanked = this.keywordRank(items, query, topN: 20)

    // Step 2: Embedding-based fine ranking (if provider configured)
    if (this.embeddingProvider) {
      return this.embeddingRank(keywordRanked, query)
    }

    return keywordRanked
  }
}
```

### 4.3 ShapeFitter (Budget-Aware)

```typescript
// src/context/shape-fitter.ts
export class ShapeFitter {
  fit(plan: SelectionPlan, budgets: BudgetSlots, level: DegradationLevel): FittedPlan {
    // Shape degradation order: full → excerpt → card → drop
    const maxShape = this.getMaxShapeForLevel(level)
    // L0: full allowed
    // L1: excerpt max
    // L2/L3: card only

    // Fit each item within budget
    for (const item of plan.selected) {
      const fittedItem = this.fitItem(item, remainingBudget, maxShape)
      // Record degradation for debugging
    }
  }
}
```

### 4.4 Excerpt Generation (Per-Type)

**Decision**: Per-type customization

| Entity Type | Excerpt Strategy |
|-------------|------------------|
| `note` | conclusion/decision paragraphs → query-matched paragraphs → head |
| `literature` | title + contribution + abstract subset |
| `data` | schema + quality summary |
| `fallback` | head 15% + middle top relevance + tail 15% |

---

## Phase 5: StateSummary Phase (Session Memory Integration)

### 5.1 Remove Message Prefix Injection

```typescript
// coordinator.ts - REMOVE this pattern:
// const sessionMemoryCtx = await buildSessionMemoryContext()
// const augmentedMessage = `${sessionMemoryCtx}\n\n---\n\n${message}`

// INSTEAD: Session memory enters via StateSummary Phase
```

### 5.2 Session Memory Constraints

**Decision**: 2 hours sliding TTL

```typescript
const SESSION_MEMORY_CONFIG = {
  ttl: 2 * 60 * 60 * 1000,  // 2 hours (sliding)
  maxItems: 8,
  maxTokens: 600,
  refreshOnRead: true,      // Touch on read/reference
}
```

### 5.3 StateSummary Phase Implementation

**Decision**: Incremental update with short TTL cache (15s debounce)

```typescript
// src/context/phases/state-summary-phase.ts
export function createStateSummaryPhase(config: StateSummaryConfig): ContextPhase {
  let cache: { content: string; tokens: number; timestamp: number } | null = null
  const CACHE_TTL = 15000  // 15 seconds debounce

  return {
    id: 'state-summary',
    priority: 60,
    budget: { type: 'fixed', tokens: 800, minTokens: 400 },

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      // Check cache validity
      if (cache && Date.now() - cache.timestamp < CACHE_TTL && !this.hasChanges(ctx)) {
        return [{ source: 'state-summary', content: cache.content, tokens: cache.tokens }]
      }

      // Rebuild: session memory + todos + recent tool pointers
      const sessionItems = await this.collectSessionMemory(ctx, config)
      const todoItems = await this.collectTodoStatus(ctx)
      const recentToolPointers = await this.collectRecentToolPointers(ctx)

      const content = this.formatStateSummary({ sessionItems, todoItems, recentToolPointers })
      const cappedContent = this.capToTokens(content, config.maxTokens)

      cache = { content: cappedContent, tokens: estimateTokens(cappedContent), timestamp: Date.now() }
      return [{ source: 'state-summary', content: `## Current State\n${cappedContent}`, tokens: cache.tokens }]
    }
  }
}
```

---

## Phase 6: Project Dashboard

### 6.1 Auto-Creation

**Decision**: Structured overview (auto-created on first agent.run())

```typescript
export interface ProjectDashboard {
  projectName: string
  createdAt: string
  currentPhase?: string
  researchGoal?: string
  keyDecisions: string[]      // Links to key decision notes
  entityStats: {
    notes: number
    papers: number
    data: number
  }
  lastUpdated: string
}
```

- Always `aiPinned`, cannot be unpinned
- Updated automatically when entities change

---

## Phase 7: Dedup Mechanism

### 7.1 Dedup Behavior

**Decision**: Warn but allow

```typescript
// src/core/entity-dedup.ts
export class EntityDeduplicator {
  async checkDuplicate(newEntity: Partial<MemoryEntity>): Promise<DuplicateCheckResult> {
    // 1. Exact hash dedup
    if (newEntity.contentHash) {
      const existing = await this.findByContentHash(newEntity.type, newEntity.contentHash)
      if (existing) {
        return { isDuplicate: true, type: 'exact', existingId: existing.id, action: 'touch' }
      }
    }

    // 2. Title similarity (threshold: 0.85)
    const similar = await this.findSimilarByTitle(newEntity.type, newEntity.title, 0.85)
    if (similar) {
      return { isDuplicate: true, type: 'similar', existingId: similar.id, action: 'warn' }
    }

    return { isDuplicate: false }
  }
}
```

---

## Phase 8: Data Migration

### 8.1 Migration Strategy

**Decision**: Auto migration with deterministic summaryCard (no LLM dependency)

```typescript
// src/core/entity-migration.ts
export class EntityMigrator {
  async migrateIfNeeded(entityPath: string): Promise<MemoryEntity> {
    const raw = JSON.parse(await fs.readFile(entityPath, 'utf-8'))

    // Check if migration needed
    if (raw.pinPolicy && raw.summaryCard) {
      return raw  // Already migrated
    }

    // Migrate
    const migrated: MemoryEntity = {
      ...raw,
      revision: raw.revision ?? 1,
      pinPolicy: {
        uiPinned: raw.pinned ?? false,
        aiPinned: false,  // Default to false for existing entities
        selectedForAI: raw.selectedForAI ?? true,
      },
      summaryCard: this.generateDeterministicCard(raw),
      summaryCardMethod: 'deterministic',
      canonicalPath: entityPath,
    }

    // Write back
    await fs.writeFile(entityPath, JSON.stringify(migrated, null, 2))
    return migrated
  }
}
```

---

## Phase 9: Degradation Ladder Enhancement

### 9.1 Updated Ladder (Shape-Aware)

| Level | Trigger | Shape Max | Actions |
|-------|---------|-----------|---------|
| L0 (Normal) | usage < 70% | `full` | Normal operation |
| L1 (Reduced) | ≥ 80% | `excerpt` | `downgrade_shapes`, `compress_tool_output` |
| L2 (Minimal) | ≥ 95% | `card` | `drop_selected`, `trim_session` |
| L3 (Emergency) | overflow | `card` | Only Dashboard + last message + core tools |

### 9.2 Profile Adjustments

```typescript
// Modify research profile
research: {
  pinned: { min: 500, max: 4000, weight: 3 },     // Was: max=Infinity, weight=5
  selected: { min: 0, maxPct: 0.30, weight: 4 },  // Unchanged
  session: { min: 10000, max: 50000, weight: 4 }, // Was: max=40000
  historyIndex: { min: 500, max: 2000, weight: 1 },
  stateSummary: { min: 800, max: 2000, weight: 2 }, // NEW: includes session memory
}
```

---

## Files Summary

### New Files to Create (11)

| File | Description |
|------|-------------|
| `src/types/memory-entity.ts` | Unified entity types with pinPolicy |
| `src/core/summary-card.ts` | SummaryCard generation |
| `src/core/project-dashboard.ts` | Dashboard auto-creation |
| `src/core/entity-dedup.ts` | Deduplication logic |
| `src/core/entity-migration.ts` | Schema migration |
| `src/context/selection-planner.ts` | Selection planning |
| `src/context/relevance-scorer.ts` | Pluggable relevance scoring |
| `src/context/shape-fitter.ts` | Budget-aware shape fitting |
| `src/context/excerpt-generator.ts` | Per-type excerpt generation |
| `src/context/phases/state-summary-phase.ts` | StateSummary phase |
| `examples/research-pilot/tools/pin-tools.ts` | pin-to-ai, unpin-from-ai |

### Files to Modify (6)

| File | Changes |
|------|---------|
| `examples/research-pilot/types.ts` | Add pinPolicy, summaryCard fields |
| `examples/research-pilot/tools/entity-tools.ts` | Update save-note defaults, add dedup |
| `examples/research-pilot/agents/coordinator.ts` | Remove prefix injection, add migration |
| `src/core/budget-coordinator.ts` | Add shape-aware degradation, adjust profiles |
| `src/context/phases/pinned-phase.ts` | Only load aiPinned entities |
| `src/context/pipeline.ts` | Integrate SelectionPlanner, ShapeFitter |

---

## Verification

### Unit Tests

1. **SummaryCard generation**: Deterministic for short content, LLM triggers for long
2. **Pin admission control**: Reject when >5 aiPinned
3. **Dedup detection**: Exact hash match, title similarity
4. **Session memory TTL**: Items expire after 2 hours, refresh on read
5. **Shape fitting**: Correct degradation order (full→excerpt→card→drop)

### Integration Tests

1. **30x save-note**: aiPinned count stays 0 (unless explicitly pinned)
2. **literature-search multi-round**: Papers enter Selected, not Pinned
3. **data-analyze 50 outputs**: Only schema cards in Pinned Anchors
4. **Long session ctx-expand**: Index retrieves correct segments into Selected
5. **L1/L2 degradation**: Shape degradation logged, form before drop
6. **Same topic repeated writes**: Dedup warning shown

### Manual Verification

1. Start research-pilot-desktop
2. Create multiple notes → Verify UI pinned but not AI pinned
3. Use pin-to-ai on 6th entity → Verify rejection with suggestions
4. Check Pinned Phase content → Only Dashboard + explicitly pinned
5. Check StateSummary → Contains session memory, todos, recent tools
6. Trigger budget pressure → Verify shape degradation in logs

---

## Decision Summary

| Dimension | Decision |
|-----------|----------|
| SummaryCard generation | Hybrid: deterministic first, LLM for >800 tokens |
| aiPinned limit | 5 max, with category quotas and optional TTL |
| Session Memory TTL | 2 hours sliding window, refresh on read |
| Relevance ranking | Pluggable strategy, default hybrid (keyword + embedding) |
| Data migration | Auto-migrate on first load, deterministic summaryCard |
| Dedup behavior | Warn but allow creation |
| Project Dashboard | Structured overview, auto-created, always aiPinned |
| Excerpt generation | Per-type customization |
| StateSummary update | Incremental with 15s cache debounce |
| Pinned Pool sorting | No sorting (≤5 items, load all) |

---

## References

- [RFC-003: Context Assembly Pipeline](./RFC-003-context-assembly-pipeline.md)
- [Budget Coordinator Implementation](../../src/core/budget-coordinator.ts)
- [External Review: Memory System Design Analysis](internal)
