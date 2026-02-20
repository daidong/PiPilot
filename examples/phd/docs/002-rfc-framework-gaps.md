# RFC-PHD-002: AgentFoundry Gaps for RAM Native Support

Status: Proposed  
Owner: examples/phd  
Date: 2026-02-20

## Summary

`examples/phd` can run RAM v0.2 end-to-end today, but several capabilities are implemented in example-layer code because the framework does not provide native primitives yet.

This RFC documents the gaps and proposes framework-level features so RAM can be first-class instead of custom glue.

## Gap 1: No Native Review Packet Primitive

Current workaround:

- Store `review_packets/CP-*.json` in project files.
- Maintain `review_queue.json` manually.

Proposal:

- Add framework object model:
  - `ReviewPacket`
  - `ReviewInbox`
  - `DecisionAction`
- Add runtime APIs:
  - `runtime.review.enqueue(packet)`
  - `runtime.review.listPending()`
  - `runtime.review.applyDecision(...)`

## Gap 2: No Built-in User Acceptance Gate

Current workaround:

- Example code enforces `IN_REVIEW -> Approve -> DONE`.

Proposal:

- Add optional task-state guard policy in core:
  - deny direct transition to `DONE` unless linked decision exists.
- Provide generic `task_state_guard` policy template for project-level workflows.

## Gap 3: Structured Output Contract Is Best-Effort

Current workaround:

- Prompt asks for strict JSON.
- Runtime parses text and falls back when parsing fails.

Proposal:

- Add `agent.runStructured(...)` for `createAgent` with:
  - explicit JSON schema validation
  - auto retry on schema mismatch
  - deterministic error type for contract violation

## Gap 4: Event-Driven Inbox Is Not Durable in Core Runtime

Current workaround:

- Example app writes `events/events.jsonl`.
- Event semantics are custom.

Proposal:

- Add durable event stream API in runtime core:
  - append/query with typed categories
  - event cursor for UI consumers
  - replay support across restarts

## Gap 5: Multi-Ledger Helpers Missing

Current workaround:

- Example app maintains YAML + JSON + JSONL files manually.

Proposal:

- Add optional `research-ledger` pack with standardized helpers:
  - taskboard read/write/update
  - evidence registry append with EID generation
  - decision log append with markdown/jsonl dual output

## Impact

If implemented, RAM-like systems can be built with less custom code, stronger correctness, and less output parsing fragility.
