# RFC-015: Thin Core Plugin Runtime Gaps (MVP -> Production)

## Context

Current branch implements a working thin-core runtime with hot-pluggable plugins, worker+vm sandboxing, and next-turn activation.

This document tracks deliberate gaps for the next iteration.

## Implemented in MVP

- Thin core primitives: AgentLoop, ToolRunner, StateStore, HookBus, createAgent
- Unified plugin model for tools/prompts/guards/context/hooks/routes/ui metadata
- Dynamic plugin lifecycle: plugin.test/install/reload/invoke
- Runtime activation model: install/reload become active on next turn
- Worker + vm isolation with permission-gated host operations
- Audit event logging for plugin lifecycle and host operations

## Gaps

### 1) MCP host operation bridge

- Status: Not implemented in thin-core host-op layer (`mcp.call` returns explicit error)
- Impact: Dynamic plugins cannot call MCP servers yet
- Proposal: Add `MCPBridge` adapter plugin package with server allowlist + per-plugin budgets

### 2) routes/ui execution binding

- Status: Plugin can declare `routes/ui` metadata, but no server/runtime mounts them
- Impact: UI panel extensions are declarative only
- Proposal: Add thin-core HTTP/WebSocket adapter that consumes plugin route/ui descriptors

### 3) Stronger sandbox hardening

- Status: Worker + vm boundary and host-op permission checks exist
- Residual risk: Node worker process still has broad runtime capability at process level
- Proposal:
  - Per-plugin process isolation mode (child process/container)
  - optional seccomp/container profile
  - stricter denied globals and serialized API contract checks

### 4) Plugin package ergonomics

- Status: `plugin.json + index.ts` works, scaffold helper exists
- Gap: No standalone CLI packaging command yet
- Proposal: `agent-foundry plugin init/build/test` command set

### 5) Derived views standardization

- Status: Event log + memory KV available; review packets implemented as plugin-level derived state
- Gap: Taskboard/decisions/evidence canonical derived-view plugin pack not yet extracted
- Proposal: Publish official `@agent-foundry/plugin-review-workspace` pack

## Prioritized Next Steps

1. MCP bridge plugin package (high)
2. Route/UI adapter for plugin descriptors (high)
3. Sandbox hardening mode switch (medium)
4. Plugin packaging CLI (medium)
5. Official derived-view packs (medium)
