# No-Code Researcher Agent

This example shows how to build a multi-step autonomous researcher with no TypeScript code:

- configuration only (`agent.yaml`)
- project-local skills (`.agentfoundry/skills/*`)
- CLI runner (`agent-foundry run`)

It targets a practical subset of Research Pilot capabilities for headless/local workflows.

## Feasibility

High. This pattern can cover most day-to-day research tasks:

- multi-step planning and execution (autonomous loop)
- file-based workspace operations (`read/write/edit/glob/grep`)
- shell execution (`bash`) for scripts and local tooling
- persistent memory (`kv-memory`) and markdown memory search (`memory-search`)
- project-local reusable skills with scripts (`skill-script-run`)

Compared to full Research Pilot, the main differences are:

- no desktop UI (entities panel, mentions UX, activity panel)
- no app-specific artifact domain model out of the box
- no built-in literature/data subagent orchestration layer

For capacity-first local automation, this is a strong baseline.

## One-Command Start

From repository root:

```bash
npm run example:no-code-researcher
```

This builds framework artifacts and starts the autonomous PDF review task (`tasks/pdf-to-review.md`).

## Directory Layout

```text
examples/no-code-researcher/
├── agent.yaml
├── agent.md
├── tasks/
│   ├── literature-review.md
│   └── grant-draft.md
├── workspace/
├── notes/
├── outputs/
└── .agentfoundry/
    └── skills/
        ├── citation-management/
        ├── markitdown/
        ├── research-grants/
        └── matplotlib/
```

## Prerequisites

From repository root:

```bash
npm run build
```

Set one provider key:

```bash
export OPENAI_API_KEY=...
# or ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / GOOGLE_API_KEY
```

## Run

Validate config:

```bash
cd examples/no-code-researcher
node ../../dist/cli/bin.js validate
```

Or:

```bash
npm --prefix examples/no-code-researcher run validate
```

Single-run:

```bash
node ../../dist/cli/bin.js run "Read tasks/literature-review.md and execute it." --mode single
```

Autonomous multi-turn run (default mode from `agent.yaml`):

```bash
node ../../dist/cli/bin.js run "Read tasks/literature-review.md and execute it end-to-end."
```

Example presets:

```bash
npm --prefix examples/no-code-researcher run start:pdf
npm --prefix examples/no-code-researcher run start:lit
npm --prefix examples/no-code-researcher run start:grant
```

## End-to-End PDF Template

Use `tasks/pdf-to-review.md` for "real paper PDF -> review":

1. Put your PDF at `workspace/papers/paper.pdf` (or anywhere under `workspace/`).
2. Run:

```bash
npm --prefix examples/no-code-researcher run start:pdf
```

3. Check outputs:
   - `outputs/paper.extracted.md`
   - `outputs/paper-review.md`
   - `outputs/sources.md`

## Optional Web Search (Brave MCP)

`agent.yaml` includes a commented `mcp:` section template.  
Enable it and set:

```bash
export BRAVE_API_KEY=...
```

This gives the agent `brave_web_search` in a no-code way.

## Notes

- Place project-specific guidance in `agent.md`.
- Put inputs under `workspace/`; write deliverables to `outputs/`.
- Add more skills by dropping folders under `.agentfoundry/skills/<skill-id>/`.
