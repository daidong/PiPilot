# Research Pilot (Current Design)

This README documents the current runtime architecture in `examples/research-pilot` after simplifying memory management.

## 1. Design Direction

The project has moved away from complex in-prompt memory objects (`Fact`, `Focus`, `TaskAnchor`) and now uses:

- durable **Artifacts** on disk as the source of truth
- lightweight **Session Summary** for cross-turn continuity

In short: persist only what matters, keep chat context lean, and recover continuity via periodic summaries.

## 2. Memory Model

### 2.1 Durable memory: Artifact only

Primary persistence is the artifact surface:

- `artifact-create`
- `artifact-update`
- `artifact-search`

Legacy `save-paper` / `save-data` wrappers have been removed from the runtime path.

Implemented in:

- `examples/research-pilot/tools/entity-tools.ts`
- `examples/research-pilot/memory-v2/store.ts`

Artifact files are stored under:

- `.research-pilot/artifacts/notes`
- `.research-pilot/artifacts/papers`
- `.research-pilot/artifacts/data`
- `.research-pilot/artifacts/web-content`
- `.research-pilot/artifacts/tool-output`

### 2.2 Cross-turn continuity: Session Summary

Session summaries are stored under:

- `.research-pilot/memory-v2/session-summaries/<sessionId>/<timestamp>.json`

Type definition:

- `SessionSummary` in `examples/research-pilot/types.ts`

Store/load functions:

- `writeSessionSummary(...)`
- `readLatestSessionSummary(...)`

Both in `examples/research-pilot/memory-v2/store.ts`.

### 2.4 Legacy artifact migration

On project init / coordinator startup, legacy artifact payloads are migrated in place:

- `type: "literature"` -> `type: "paper"`
- `data.name` -> `data.title` (then remove `data.name`)

Implemented in `migrateLegacyArtifacts(...)` in `examples/research-pilot/memory-v2/store.ts`.

### 2.3 Debug explain snapshots

Per-turn explain snapshots are written to:

- `.research-pilot/memory-v2/explain/*.turn.json`

Used by command/UI debugging (`memoryExplainTurn`).

## 3. Coordinator Flow

Main entry:

- `createCoordinator(...)` in `examples/research-pilot/agents/coordinator.ts`

Per user message:

1. Detect intent (rules first, then lightweight router model fallback).
2. Preload relevant non-script skills for the detected intent.
3. Build selected context from:
   - mention selections
   - latest session summary (if any)
4. Run agent with additional intent module instructions.
5. Write turn explain snapshot.
6. Append turn history and trigger `maybeGenerateSummary()`.

## 4. Session Summary Generation Strategy

`maybeGenerateSummary()` runs only when trigger conditions are met:

- every 5 turns, or
- heavy tool usage in recent turns, or
- large recent response volume

It asks a small model for JSON:

```json
{"summary":"...","topicsDiscussed":["..."],"openQuestions":["..."]}
```

Then persists a `SessionSummary` record to disk.

## 5. Persistence Policy

Coordinator prompt and routing logic bias toward **ephemeral responses by default**.
Artifacts are created/updated only when persistence is justified (user asks, reusable output, traceability, etc.).

Relevant files:

- `examples/research-pilot/agents/prompts/index.ts`
- `examples/research-pilot/agents/coordinator.ts` (`classifyPersistenceDecision`)

## 6. Document Conversion + Skills

`convert_to_markdown` is now a wrapper that dynamically discovers conversion scripts from installed skills and executes them via:

- `skill-script-run`

It records which skill/script was used in the tool result (`converterSkill`, `converterScript`) for UI transparency.

## 7. Public API Surface

Library exports are centralized in:

- `examples/research-pilot/index.ts`

Important commands:

- artifact CRUD/search commands
- `sessionSummaryGet`
- `memoryExplainTurn`

## 8. Notes / Known Gaps

- Legacy comments/docs may still mention `Fact/Focus/TaskAnchor`; current behavior is Artifact + Session Summary.
