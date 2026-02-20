# PHD Research Assistant Mode (RAM) v0.2 MVP

This example implements a review-gated, event-driven research assistant workflow described in `docs/001-design.md`.

It uses AgentFoundry `createAgent` for the Explore Loop and provides a CLI-based MVP UI for:

- Review Inbox
- Packet View
- Artifact Viewer
- Decision Bar (`approve`, `request_changes`, `reject`)

Now it also includes an interactive local web UI (Express + WebSocket + Vanilla SPA).

## Quick Start

From repo root:

```bash
export OPENAI_API_KEY=your_key_here
npm run example:phd -- serve --port 3000
```

Then open:

- `http://127.0.0.1:3000`

The UI supports:

- Agent start/message
- Review inbox
- Packet details
- Artifact preview
- Approve / Request Changes / Reject
- Multi-panel linkage (Inbox -> Packet -> Artifact auto-link)
- Keyboard shortcuts: `J/K` select inbox, `O` open packet, `A/C/X` decision, `R` refresh, `T/M//` focus
- Memory ledger panel (facts/constraints/decisions/artifacts continuity)
- Stronger preflight checks (existence, non-empty files, JSON/YAML/CSV structural checks, hashes, reproduce command resolvability)

Default workspace:

- `examples/phd/demo-project`

## Runtime Model

This example always uses:

- Provider: OpenAI API
- Model: `gpt-5.2`
- Agent engine: AgentFoundry `createAgent`

`OPENAI_API_KEY` is required.

## Smoke Test

Run end-to-end validation:

```bash
npm run example:phd:smoke
```

This creates an isolated `smoke-*` project, runs one explore turn, enqueues a packet, approves it, and validates task closure.

## CLI Commands

You can still use the direct commands:

```bash
npm run example:phd -- help
npm run example:phd -- init
npm run example:phd -- run
npm run example:phd -- inbox
npm run example:phd -- packet CP-0001
npm run example:phd -- review CP-0001 approve --comment "ok"
npm run example:phd -- artifact notes/cp-0001-summary.md
npm run example:phd -- status
```

## Ledger Files

The runtime persists the three mandatory ledgers plus review packets:

- `taskboard.yaml`
- `decisions.md` and `decisions.jsonl`
- `evidence/registry.json`
- `review_packets/CP-*.json`

And supporting state:

- `review_queue.json`
- `state/runtime.json`
- `events/events.jsonl`
- `memory/entries.json`
- `memory/state.json`
- `MEMORY.md`
