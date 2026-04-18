Quick definitions for the terms you'll see across the app and docs. Listed alphabetically.

## Agent / Coordinator

The main LLM-driven loop that reads your messages, picks tools, and composes responses. Built on [pi-mono](https://github.com/badlogic/pi-mono). The **coordinator** is the specific agent configuration Research Copilot ships with — it wires in the research tools and skill registry. Source: `lib/agents/coordinator.ts`.

## Artifact

A structured piece of knowledge the agent can create, edit, and reference. Five types:

| Type | What it holds |
|---|---|
| `note` | Freeform Markdown notes |
| `paper` | Bibliographic records with DOI, bibtex, citeKey, relevance |
| `data` | Tabular or structured data |
| `web-content` | Snapshots of web pages the agent fetched |
| `tool-output` | Raw output from tool calls, preserved for reference |

Artifacts live under `<workspace>/.research-pilot/artifacts/<type>/` as files. They're searchable and citable via `@-mentions`.

## BM25

A classic ranking function used by the Paper Wiki's search. Matches documents to queries by term frequency and inverse document frequency — no embeddings, no vector DB, no network calls. Fast and offline.

## Canonical identity

The rule Paper Wiki uses to decide if two paper records refer to the same work: **DOI > arxivId > normalized(title+year)**. Prevents the same paper from being reprocessed under different keys across projects. See [Paper Wiki → Canonical identity](Paper-Wiki#canonical-identity-why-papers-dont-get-reprocessed).

## Coordinator

See [Agent / Coordinator](#agent--coordinator).

## Intent

A rule-based (and optionally LLM-confirmed) classification of what the user is asking for — one of `literature`, `data`, `writing`, `critique`, `web`, `citation`, `grants`, `docx`, or `general`. Drives which skills get surfaced to the agent. Source: `lib/agents/coordinator.ts`.

## @-mention

An inline reference to an artifact inside a chat message. Typing `@` opens a picker; the agent resolves the mention and the referenced content is attached to the message. Parser and resolver live in `lib/mentions/`.

## Paper Wiki

A global, cross-project knowledge base of papers you've touched. See [Paper Wiki](Paper-Wiki) for the deep dive.

## pi-mono

The agent runtime Research Copilot is built on — [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono). Handles LLM integration, session management, tool invocation, and the built-in coding toolkit (read, write, edit, bash, grep, find).

## Session summary

A condensed Markdown summary of a chat session, generated automatically as sessions grow. Enables the agent to recall earlier context without re-loading every message. Stored at `<workspace>/.research-pilot/memory-v2/session-summaries/`.

## Skill

A lazy-loaded knowledge module in `SKILL.md` format that gives the agent domain expertise. Only the `shortDescription` is loaded at startup; the body loads on demand when the skill is activated. Discovered from three locations (later overrides earlier): builtin → `~/.research-pilot/skills/` → `<workspace>/.pi/skills/`. See the [Skills Catalog](Skills-Catalog).

## Subscription auth

Signing in with ChatGPT Pro / Plus or Claude Pro / Max via OAuth, instead of using an API key. No per-token billing. Tokens are stored in the OS keychain. Research Copilot prefers subscription auth when available — see [Getting Started → Sign in](Getting-Started#2-sign-in).

## Tool

A typed function the agent can call mid-conversation. Research Copilot ships with research-specific tools (literature search, web fetch, data analysis, document conversion, artifact CRUD, wiki search) plus pi-mono's general-purpose coding tools (read, write, edit, bash, grep, find). Source: `lib/tools/`.

## Workspace

The folder you opened in Research Copilot. All project-local state — artifacts, session summaries, custom skills — lives under `<workspace>/.research-pilot/` or `<workspace>/.pi/`. Global state (API keys, Paper Wiki) lives under `~/.research-pilot/` and `~/.research-copilot/`.
