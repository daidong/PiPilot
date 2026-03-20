# RFC-013: Personal Assistant Memory V2
## Full Rewrite with Kernel V2 Alignment and UI Integration

Status: Draft  
Author: AgentFoundry Team  
Created: 2026-02-06  
Updated: 2026-02-06

---

## 1. Executive Summary

Personal Assistant will fully adopt Kernel V2 memory runtime and remove legacy app-local memory semantics.

This RFC defines a full rewrite (no migration, no backward compatibility) built on:

1. `Artifact` (authoritative source records)
2. `Fact` (durable structured memory via write gate)
3. `Focus` (session-scoped attention)
4. `Task Anchor` (minimal execution continuity)

UI and IPC surfaces will be redesigned to match this model directly.

---

## 2. Scope

In scope:

1. Full replacement of `ProjectCard/WorkingSet/MEMORY.md bootstrap` memory model.
2. Kernel V2 as the single memory runtime.
3. Email/calendar/scheduler integration into Artifact/Fact/Focus/Task Anchor.
4. Renderer, main IPC, preload API, and coordinator rewrites aligned to V2 semantics.

Out of scope:

1. Migration from old `.personal-assistant` storage.
2. Backward compatibility for old commands and renderer pathways.
3. Cross-app unification with Research Pilot in this RFC.

---

## 3. Motivation and Current Gaps

Current implementation still has major legacy coupling:

1. `projectCard` + `workingSet` semantics drive memory behavior in app layer.
2. Manual memory bootstrap (`USER.md`/`MEMORY.md`/daily logs) duplicates Kernel V2 continuity.
3. Context assembly logic is partially app-managed, partially framework-managed.
4. Communication data (email/calendar) risks memory pollution without explicit privacy write policy.
5. Explainability for context injection is weak in normal UI.

---

## 4. Design Principles

1. Kernel V2 is the sole authority for long-horizon memory/runtime decisions.
2. Files are truth for artifacts; index is acceleration only.
3. Durable memory writes must be explicit, auditable, and gated.
4. Session attention (Focus) must be separate from durable memory.
5. Task anchor is for execution continuity only, not knowledge storage.
6. Communication actions (send/reply/calendar writes) require stricter safety than retrieval.
7. Context injection must be explainable in logs and UI.

---

## 5. Architecture Overview

1. `KernelV2`  
Context assembly, budget planning, compaction, lifecycle, telemetry, and durable memory semantics.

2. `PA Domain Layer`  
Maps personal-assistant domain outputs (email/calendar/todo/doc/scheduler) into Artifact/Fact/Focus events.

3. `UI Layer`  
Directly exposes Focus, Task Anchor, Explain, and communication-aware memory views.

4. `Policy Layer`  
Enforces communication safety and sensitive-memory write constraints.

---

## 6. Data Model

## 6.1 Artifact Types

Personal Assistant V2 artifacts:

1. `note`
2. `todo`
3. `doc`
4. `email-message`
5. `email-thread`
6. `calendar-event`
7. `scheduler-run`
8. `tool-output`

All artifacts include:

1. `id`, `type`, `title`
2. payload fields by type
3. `tags`, `summary`
4. provenance and timestamps

## 6.2 Fact Domains

Durable facts (write-gated) are constrained to high-signal domains:

1. `profile.*` (user identity/preferences/timezone)
2. `commitment.*` (promises/deadlines/obligations)
3. `routine.*` (recurring patterns)
4. `contact.*` (stable relationship context)
5. `work-context.*` (ongoing constraints)

Raw communication bodies are not durable facts by default.

## 6.3 Focus

Session-scoped attention entries:

1. `refType`: `artifact|fact|task`
2. `refId`, `reason`, `score`, `ttl`, `expiresAt`
3. source: `manual|auto`

Lifecycle:

1. expire only at turn boundary
2. auto-focus cooldown to prevent oscillation
3. TTL presets: `30m`, `2h`, `today`

## 6.4 Task Anchor

Task anchor stays minimal with four fields:

1. `CurrentGoal`
2. `NowDoing`
3. `BlockedBy`
4. `NextAction`

Tail-injected every turn.

---

## 7. Storage Layout

New root:

```
.personal-assistant-v2/
  artifacts/
    notes/
    todos/
    docs/
    email-messages/
    email-threads/
    calendar-events/
    scheduler-runs/
    tool-outputs/
  memory-v2/
    focus/
    tasks/
    continuity/
    explain/
    index/
  sessions/
  notifications/
  cache/
```

Old `.personal-assistant/` is ignored in V2 mode.

---

## 8. Runtime Flows

## 8.1 Interactive Turn

1. resolve project/task via Kernel V2
2. prune expired focus
3. retrieve Fact/Evidence candidates
4. assemble context (protected zone + tail anchor)
5. run tools/LLM
6. write durable candidates via MemoryWriteGateV2
7. persist explain snapshot and telemetry

## 8.2 Email Flow

1. query/read operations generate `email-message`/`email-thread` artifacts
2. send/reply/mark operations remain explicit and policy-controlled
3. only high-signal outcomes may become facts
4. full body persistence requires explicit user intent

## 8.3 Calendar Flow

1. calendar queries produce `calendar-event` artifacts
2. commitments may produce `commitment.*` facts
3. sensitive notes are tagged and redacted before durable write

## 8.4 Scheduler Flow

1. each trigger creates `scheduler-run` artifact
2. optional facts update only when durable value is inferred
3. task anchor can be updated for continuity
4. notification record links to scheduler-run artifact

---

## 9. Context Assembly Contract

Personal Assistant reuses Kernel V2 assembler and budget planner directly.

Zone mapping:

1. continuity summary
2. fact cards
3. evidence cards
4. non-protected history (with focus digest)
5. protected recent turns
6. tail task anchor

Constraints:

1. protected zone is sacred except fail-safe
2. tail task anchor always present
3. communication artifacts obey stricter injection quotas/sensitivity filters

---

## 10. Memory Write Policy

All durable memory writes go through `MemoryWriteGateV2`.

Write actions:

1. `PUT`
2. `REPLACE`
3. `SUPERSEDE`
4. `IGNORE`

Policy requirements:

1. mandatory provenance
2. per-turn and per-session write limits
3. sensitivity-aware redaction before durable write
4. Artifact<->Fact bidirectional linkage maintained

---

## 11. Privacy and Action Safety

Default sensitivity:

1. `email-message`: `private`
2. `email-thread`: `private`
3. `calendar-event`: `private`
4. `profile.*` facts: `private`

Rules:

1. no full email body durable write without explicit user intent
2. no token/credential/secret payload in artifacts or facts
3. send/reply/calendar-modify actions require explicit confirmation
4. memory state cannot bypass action confirmation policies

---

## 12. Skills and Tooling Integration

1. keep lazy-loaded communication skills (`gmail-skill`, `calendar-skill`)
2. tool outputs should emit structured data for artifact creation
3. canonical command/tool surface:
   1. `artifact.create/update/get/list/search/delete`
   2. `focus.add/remove/list/clear/prune`
   3. `task.anchor.get/set/update`
   4. `memory.explain turn|fact|budget`
4. legacy commands removed from active UI paths:
   1. `save-note/save-doc` as primary persistence API
   2. `select/pin/project` as memory controls

---

## 13. UI Redesign and Integration

## 13.1 Information Architecture

Left-top primary tabs:

1. `Todos`
2. `Notes`
3. `Docs`
4. `Mail`
5. `Calendar`

Left-bottom:

1. fixed workspace file tree (resizable)
2. lazy tree loading
3. virtualized rendering

Right panel:

1. `Focus`
2. `Task Anchor`
3. `Context Explain`
4. `Notifications`

## 13.2 Left Panel Behavior

1. artifact views replace projectCard/workingset mental model
2. row actions:
   1. add to focus
   2. create artifact from file
   3. link as evidence to task
3. drag/drop remains for docs/notes with artifact creation

## 13.3 Right Panel Behavior

Replace old chips with:

1. Focus chips (session attention)
2. Task anchor block (four fields)
3. explain snapshot block (turn/fact/budget)
4. notification list linked to scheduler-run artifacts

## 13.4 Composer and Commands

Primary command surface:

1. `/focus <id>`
2. `/anchor`
3. `/explain`
4. `/todo ...` (user-facing tasks)

Legacy `/pin` and `/select` removed from visible command help.

## 13.5 Explainability UI

Expose per turn:

1. injected facts/evidence
2. why-selected reason/score
3. zone budget usage
4. provenance chain for selected fact

---

## 14. Main/Preload/IPC Contract Changes

1. add canonical IPC endpoints for artifact/focus/task-anchor/explain
2. add workspace tree endpoints with show-ignored toggle
3. add task evidence linking endpoint
4. remove old pin/select endpoints from renderer primary usage
5. optional temporary aliases allowed only during development rollout

---

## 15. Observability and Telemetry

Baseline telemetry stays on in non-debug mode.

Required events:

1. `focus.selection`
2. `task.anchor.updated`
3. `memory.writegate.*`
4. `context.protected_zone.*`
5. `compaction.*`
6. `retrieval.stats`

UI must surface latest explain snapshot and budget summary.

---

## 16. Performance Targets

1. bounded context assembly P95
2. bounded retrieval P95
3. bounded raw scan token usage
4. stable token variance across long sessions
5. large-workspace file tree stays responsive through virtualization

---

## 17. Rollout Plan (No Migration)

1. implement V2 domain model and storage layout
2. rewrite command/tool surface to canonical APIs
3. rewrite coordinator to remove app-managed memory assembly
4. rewrite main IPC + preload
5. rewrite renderer stores and panels (Focus/Anchor/Explain)
6. integrate scheduler artifacts/notifications into V2 flows
7. remove dead legacy code paths

---

## 18. Testing Strategy

1. unit tests:
   1. artifact/focus/task-anchor state behavior
   2. communication write-gate privacy rules
2. integration tests:
   1. context assembly with focus and task anchor
   2. scheduler-triggered artifact/fact flow
3. UI tests:
   1. focus operations
   2. explain panel correctness
   3. file-tree interaction performance sanity
4. long-session tests:
   1. compaction and continuity quality
   2. lifecycle maintenance stability

---

## 19. Acceptance Criteria

RFC-013 is accepted when:

1. Personal Assistant uses Kernel V2 as the sole memory runtime.
2. No active runtime path depends on `ProjectCard/WorkingSet` semantics.
3. Email/calendar memory behavior is policy-compliant and explainable.
4. Task anchor is tail-injected on every turn.
5. Focus lifecycle works with TTL + turn-boundary expiry + cooldown.
6. UI shows Focus + Task Anchor + Explain in normal operation.
7. Scheduler outputs are traceable to artifacts and notifications.
8. Non-debug telemetry provides memory runtime visibility.

---

## 20. Open Questions

1. default TTL strategy for communication-derived focus items
2. fact promotion policy strictness for email/calendar summaries
3. temporary internal alias retention window for legacy IPC endpoints
4. sensitivity defaults for shared/family calendars

