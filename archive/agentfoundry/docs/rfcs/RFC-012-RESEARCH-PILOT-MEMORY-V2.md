# RFC-012: Research Pilot Memory V2
## Artifact/Fact/Focus Core with Lightweight Task Anchors

Status: Deprecated (Research Pilot runtime)  
Author: AgentFoundry Team  
Created: 2026-02-06  
Updated: 2026-02-12  
Superseded by: RFC-015 (Framework Memory Minimal Core)

---

## Deprecation Notice

This RFC is kept as historical design context only.

For current and future implementation direction:

- Research Pilot memory semantics: `Artifacts + Session Summaries`
- Framework default runtime semantics: minimal core, heavy memory semantics moved to optional profiles/plugins
- See `docs/rfcs/RFC-015-FRAMEWORK-MEMORY-MINIMAL-CORE.md`

---

## 1. Executive Summary

Research Pilot will replace the legacy `Notes / Pin(ProjectCard) / WorkingSet` mental model with a unified V2 memory runtime:

1. `Artifact` for authoritative source material
2. `Fact` for durable structured memory
3. `Focus` for session-scoped attention control
4. `Task Anchor` for progress continuity only

This RFC is a full redesign for Research Pilot. No migration compatibility is required.

---

## 2. Motivation

Current behavior mixes old and new semantics:

- legacy entities still drive user mental model
- WorkingSet semantics are not fully aligned with Kernel V2 context assembly
- pin/project-card remains a binary abstraction for content that is not always binary in confidence
- explainability of why context was injected remains weak

Long-horizon research requires a clearer separation between:

- source truth
- durable memory
- short-lived attention
- execution progress

---

## 3. Design Principles

1. Files are truth (`Artifact` authoritative).
2. Durable memory must be explicit and auditable (`Fact` with provenance).
3. Short-term focus is separate from durable memory (`Focus` with TTL).
4. Task state is minimal and operational, not a knowledge store.
5. Context is assembled JIT with strict budget boundaries.
6. Every injected context unit should be explainable.

---

## 4. Data Model

## 4.1 Artifact

Canonical source units:

- `note`
- `paper` (BibTeX-oriented literature record)
- `data`
- `web-content`
- `tool-output`

All artifact types share a base shape:

- `id`, `type`, `title`
- `path|contentRef`
- `summary`
- `tags`
- `provenance`
- `createdAt`, `updatedAt`

`paper` must be implemented as a typed artifact subtype (`PaperArtifact`), not a loose generic blob.
Required paper fields:

- `citeKey`
- `bibtex`
- `doi`
- `authors`
- `abstract`
- `year`
- `venue`
- `url`
- `pdfUrl`

`Papers` tab and `paper` storage are first-class and must preserve these fields through create/update/dedupe flows.

## 4.2 Fact

Durable structured memory unit:

- `namespace`, `key`, `value`, `valueText`
- `status`: `proposed|active|superseded|deprecated`
- `confidence`
- `provenance` (source type/ref/trace/session)
- `derivedFromArtifactIds: string[]`
- timestamps

Facts are writable only through `MemoryWriteGateV2`.

Fact provenance is bidirectional:

1. Fact -> Artifact: `derivedFromArtifactIds`.
2. Artifact -> Fact: reverse index (`artifactId -> factIds[]`) maintained by store/index layer.

This supports:

- artifact retraction handling
- confidence/status propagation
- explainability traversal (`fact -> source artifact`)

## 4.3 Focus

Session attention unit:

- `sessionId`
- `refType`: `artifact|fact|task`
- `refId`
- `reason`
- `score`
- `source`: `manual|auto`
- `ttl`
- `expiresAt`

Focus is intentionally non-authoritative and allowed to decay automatically.

Focus lifecycle contract:

1. Scope: session-only (`sessionId` scoped, no cross-session persistence in RFC-012).
2. Expiry timing: eviction occurs at turn boundary only (never mid-assembly).
3. Re-promotion rule: expired auto-focus entries enter cooldown; they cannot be auto-repromoted until cooldown ends, but manual promotion is always allowed.
4. Suggested defaults:
   - `ttl`: `30m|2h|today`
   - `cooldown`: `15m` (configurable)

## 4.4 Task Anchor

Task state is constrained to four continuity questions:

1. `CurrentGoal`
2. `NowDoing`
3. `BlockedBy`
4. `NextAction`

Task anchor must not absorb large project knowledge.

---

## 5. Runtime Flow

For each turn:

1. Resolve active task anchor.
2. Build `Focus` candidates (manual boosts + auto candidates).
3. Retrieve Fact/Evidence candidates from Artifact/Fact stores.
4. Assemble context (`Protected recent turns + Focus digest + Tail task anchor`).
5. Execute tools/LLM.
6. Update task anchor and write durable facts via write gate.
7. Apply compaction/preflush policies if needed.

---

## 6. Retrieval Strategy

Primary order:

1. Focus refs
2. Fact candidates
3. Artifact evidence

Fallback chain:

1. hybrid
2. lexical
3. vector-only
4. raw-file-scan (bounded)

RFC-012 V1 retrieval uses a deterministic priority strategy (not a weighted scorer):

1. Focus hits
2. task-relevant active facts
3. artifact evidence

Tie-breakers:

- recency
- confidence
- diversity cap

No cross-feature weighted blending is required in the first implementation.

---

## 7. Write and Lifecycle

## 7.1 Write Gate

- Actions: `PUT|REPLACE|SUPERSEDE|IGNORE`
- Mandatory provenance
- Rate limits (per turn/per session + preflush reserve)

## 7.2 Lifecycle

- weekly consolidation
- decay to deprecated
- archive to cold storage (replayable)

## 7.3 Explainability

Each memory card/evidence card in context must expose:

- source
- reason selected
- confidence/score

---

## 8. Command and Tooling Changes (Breaking)

Replace legacy commands:

- `save-note` -> `artifact.create(type=note, ...)`
- `toggle-pin` -> `fact.promote|fact.demote`
- `select/workingset` -> `focus.add|focus.remove|focus.list|focus.clear`

Additions:

- `task.anchor.set`
- `task.anchor.update`
- `memory.explain turn`
- `memory.explain fact <id>`
- `memory.explain budget`

No backward compatibility layer is required for RFC-012 scope.

---

## 9. Context Contract with Kernel V2

RFC-012 reuses the existing Kernel V2 context assembler path. It does not introduce a second assembler.

Research Pilot zone mapping on top of existing assembler:

1. continuity summary
2. Fact cards
3. Evidence cards
4. non-protected history
5. Focus digest (rendered at the head of non-protected history block)
6. protected recent turns
7. tail task anchor

Constraints:

- protected turns are sacred except fail-safe
- tail task anchor always present
- Focus digest is budgeted inside the existing non-protected history budget bucket (no new budget bucket in V1)

Degradation order remains aligned with current Kernel V2 behavior:

1. optional expansion
2. evidence detail
3. fact/memory detail
4. non-protected history (including focus digest)

Protected recent turns and tail task anchor remain non-degradable except fail-safe.

---

## 10. UI and UX Redesign

## 10.1 Information Architecture

Primary navigation:

- Library (Artifacts except dedicated Papers view)
- Papers (BibTeX-oriented literature management)
- Knowledge (Facts)
- Focus (Session attention)
- Tasks (Anchors and progress)
- Runs (telemetry/debug)

`Papers` remains a dedicated tab and is not merged away into a generic list UI.

## 10.2 Interaction Model

Key actions:

- Add artifact to focus with TTL
- Promote fact to active
- Link evidence to task
- Inspect why-context explanations

Literature flow requirement:

- Results produced by literature research tools must continue to auto-create/update `paper` artifacts (dedupe by `doi` then `citeKey`, fallback title+year heuristic).
- Auto-added papers must appear in `Papers` tab without manual refresh steps.
- BibTeX metadata must be preserved on auto-add/update.

## 10.3 Context Debug View

Expose per-turn:

- injected Fact cards
- injected Evidence cards
- Focus entries selected/rejected
- token budget by zone

## 10.4 Left Panel File Explorer (Mandatory)

The left panel must reserve a fixed lower section for full workspace tree navigation.

Requirements:

1. Left panel split into two vertical regions:
   - upper: Memory V2 navigation (`Library/Papers/Knowledge/Focus/Tasks`)
   - lower: file explorer tree (fixed space; default 35% height, resizable)
2. File explorer root is current project workspace root.
3. Show full directory tree with expand/collapse behavior.
4. Support:
   - scrolling
   - filename search/filter
   - refresh
   - current file highlight
5. Respect `.gitignore` by default, with optional “show ignored files” toggle.
6. For large repositories:
   - lazy node loading
   - virtualized list rendering
7. Context actions from file tree:
   - Add to Focus
   - Create Artifact from File
   - Link as Evidence to Task
8. Expanded/collapsed state should persist per project session.

Rationale:

- provides standardized project navigation
- improves operational awareness in long-running research projects
- reduces friction between filesystem truth and memory operations

---

## 11. Observability

Required baseline events:

- `retrieval.stats`
- `focus.selection`
- `task.anchor.updated`
- `memory.writegate.*`
- `context.protected_zone.*`
- `compaction.*`

Required metrics:

- focus hit rate
- fact injection precision proxy
- task drift incidence
- token distribution by zone

---

## 12. Security and Data Policy

- sensitivity tagging for facts/artifacts
- redaction policy for UI previews
- deletion and audit trace policy
- backup/export boundaries

---

## 13. Performance Targets

- P95 context assembly latency
- P95 retrieval latency
- bounded raw scan tokens
- stable prompt token variance across long sessions

---

## 14. Acceptance Criteria

RFC-012 is accepted when all pass:

1. Legacy memory semantics are replaced by Artifact/Fact/Focus in Research Pilot.
2. Task anchor remains minimal and tail-injected every turn.
3. Focus affects retrieval and context composition deterministically.
4. Durable writes always pass through write gate with provenance.
5. Context injection is explainable in UI and logs.
6. Left panel mandatory file explorer is implemented as specified in 10.4.
7. `Papers` tab remains available as a dedicated BibTeX management surface.
8. Literature research auto-add/update pipeline for papers remains functional (with dedupe and metadata preservation).
9. Fact<->Artifact bidirectional provenance traversal is available.
10. Focus lifecycle behavior matches 4.3 (turn-boundary expiry + cooldown anti-oscillation).
11. `memory.explain` supports turn/fact/budget variants.

---

## 15. Rollout Plan (No Migration)

1. Implement new stores and command surface.
2. Ship new UI layout and file explorer integration.
3. Switch Research Pilot default runtime to RFC-012 memory model.
4. Remove old Notes/Pin/WorkingSet command surfaces from active UI paths.

---

## 16. Open Questions

1. Default Focus TTL presets (`30m/2h/today`).
2. Fact promotion policy (manual-first vs hybrid).
3. Task split heuristics for large multi-thread investigations.
