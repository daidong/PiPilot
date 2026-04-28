---
rfc: 002
title: User Wiki — A Personal Knowledge Base About the User
status: Draft
author: Dong Dai
created: 2026-04-28
---

# RFC-002: User Wiki

> **Status:** Draft for discussion. Nothing in this document is implemented yet. The goal of this PR is to align on the design before writing any code.

## 1. Motivation

We already have the notion of a **paper-wiki** — a knowledge base built from external literature so the agent can ground its answers in citations. This RFC asks: what if we apply the same idea to **the user themselves**?

Concretely, when the agent is asked to:
- Draft a self-introduction, bio, or CV
- Write a grant proposal section about the PI
- Compose an email mentioning the user's background or collaborators
- Decide whether a recommendation matches the user's research area / writing style

…it currently has no structured way to know who the user is. It either guesses, asks, or relies on whatever happens to be in the current session's context.

A **user-wiki** would give the agent a stable, queryable representation of the user, analogous to how the paper-wiki gives it a stable representation of the literature.

## 2. Why This Is Harder Than Paper-Wiki

Three asymmetries make this non-trivial:

| Aspect | Paper-Wiki | User-Wiki |
|---|---|---|
| Trigger | Obvious (user asks about a topic → search) | Unclear (when does the agent decide to look up the user?) |
| Volatility | Papers are immutable facts | User state changes constantly (job, interests, focus) |
| Scope | Always global | Has both global ("who I am") and per-project ("what I'm working on") components |

Each row corresponds to one of the open challenges below.

## 3. Proposed Frame: A Three-Layer Model

The central design claim of this RFC is that **user information should be split into three layers, not two**, and the boundaries should be drawn by *volatility* rather than by topic.

### Layer 1 — Identity (Global, Append-Only)

**What goes here:** facts that change at the timescale of *years*.

- Position history (current + past), with `start_date` / `end_date`
- Affiliations, education
- Personal sites, ORCID, social handles
- Long-term collaborator network ("has co-authored with X, Y, Z")
- Stable research area at the **field** level (e.g., "HPC storage systems")
- Writing-style signals collected over many sessions (e.g., "prefers active voice", "writes in en-US")

**Storage:** `~/.research-pilot/user-wiki/identity.jsonl` (append-only, one event per line, latest-wins on read).

**Key property:** entries are never deleted by the agent. Old jobs get an `end_date` added; they don't disappear. Users can manually edit via a UI.

### Layer 2 — Project Context (Per-Project, Mutable)

**What goes here:** facts that change at the timescale of *days/weeks*, scoped to a single project.

- Current task / focus (already exists: `.research-pilot/memory-v2/focus/`)
- In-progress drafts, decisions made in this project
- Project-specific collaborators ("on this paper I'm working with K")
- Local style overrides ("this venue requires passive voice")

**Storage:** existing `.research-pilot/` per-project metadata. Already implemented; this RFC does not change it.

### Layer 3 — The Forbidden Zone (Don't Collect)

**What we explicitly refuse to put in either layer:**

- "Currently researching CXL memory pooling" — sounds like identity, but is actually project-level and will rot.
- "Likes coffee", "lives in Charlotte" — true but irrelevant to the agent's job; high noise / low value.
- Any inference the agent makes from a single conversation without the user confirming.

The cost of polluting Layer 1 is high (it leaks into every future project), so the bar for entry must be deliberately high.

## 4. The Three Challenges

### 4.1 Trigger: When Does the Agent Read User Info?

**Problem:** Unlike paper search ("user asked about a topic, look it up"), it's not obvious when the agent should consult the user-wiki. If we let the LLM decide via a tool, it will under- or over-trigger unpredictably.

**Proposed approach — two paths, used together:**

1. **Always-on summary injection.** A compact summary (<500 tokens) of Layer 1 is injected into the system prompt at session start. The agent doesn't need to "decide to look it up" — it just sees it. This is what Claude.ai and ChatGPT memory do.

2. **Explicit `user_profile_search` tool**, exposed only when intent detection routes to writing/grants/citation/self-introduction-flavored requests. For other intents (data analysis, debugging, general coding) the tool is hidden so the agent doesn't waste calls.

The summary covers the common case; the tool covers depth-on-demand.

### 4.2 Volatility: How Does It Stay Fresh Without Becoming Garbage?

**Problem:** If we let the agent automatically write/update/GC entries, we get garbage-in-garbage-out. If we never update, the wiki becomes stale.

**Proposed approach — high write bar, no auto-GC, human-in-the-loop:**

- **Writing into Layer 1 requires one of:**
  - User explicitly says "remember this" / "save to my profile"
  - The same fact appears as a stable signal across ≥N (e.g., 3) sessions
  - User runs a `/profile-promote <fact>` command to lift something from a session into Layer 1

- **No automatic deletion.** Append-only with `as_of` timestamps. "Was at NCSU 2018–2023" and "is at UNC Charlotte 2023–present" coexist; readers resolve "current" by latest non-ended entry.

- **Editing UI.** A `/profile` view in the app lets the user see and edit Layer 1 directly. Agent never edits without user-visible confirmation.

The crucial design move: **don't ask the agent to garbage-collect.** Stale entries are the user's problem to clean up, not the agent's. This trades some staleness for a much lower pollution rate.

### 4.3 Scope: Global vs. Project-Local Isolation

**Problem:** How do we keep project-specific context from polluting the global identity layer when projects open and close?

**Proposed rule — one-way injection, never reflux:**

- On project open: Layer 1 summary is injected into the project's session context. Read-only.
- Inside a project: writes go to Layer 2 (project memory). They **never** flow back to Layer 1 automatically.
- Promotion is explicit: the user (or agent, with explicit user confirmation) can `/profile-promote` a Layer 2 fact into Layer 1. This is the *only* path from project → global.

Simple, blunt, and prevents the most common failure mode (project-specific transient becomes a "fact" about you forever).

## 5. Reference Patterns

Both Claude.ai and ChatGPT implement memory as roughly:

1. A user-visible, user-editable list of memory entries.
2. A summary blob injected into the system prompt.
3. Writes triggered by explicit signals or repeated reinforcement, not by every utterance.

This RFC is consciously a variant of that pattern, with the addition of the **three-layer split** to handle the project-vs-global tension that desktop research workflows surface (and that consumer chat products can ignore because they have no project concept).

## 6. Out of Scope (For This RFC)

- Schema details for individual identity fields (will follow once the frame is approved)
- UI design for the `/profile` editor
- Migration path from existing focus/session-summary data
- Multi-user / shared profiles
- Cross-device sync of `~/.research-pilot/user-wiki/`

## 7. Open Questions

1. **Granularity of the always-on summary.** Is 500 tokens the right budget? Should it adapt to the active intent (e.g., longer for writing tasks)?
2. **Confirmation UX.** What does the "agent wants to remember X" prompt look like — modal, inline toast, deferred batch review?
3. **Style signals.** Should writing-style preferences live in Layer 1 (identity) or be a separate Layer 1.5? They're stable but qualitatively different from biographical facts.
4. **Collaborator network.** Auto-derivable from past papers in the paper-wiki vs. manually curated — which source of truth wins on conflict?
5. **Privacy & export.** Should the user-wiki be trivially exportable / deletable as a single artifact? (Probably yes.)
6. **Field-level vs. topic-level research interests.** Where exactly is the boundary, and who decides — user or agent?

## 8. Decision Requested

Before drafting an implementation plan, I want agreement on:

- **(D1)** The three-layer model (Identity / Project Context / Forbidden Zone) is the right frame.
- **(D2)** Layer 1 is append-only with `as_of` timestamps; no auto-GC.
- **(D3)** One-way injection from Layer 1 → project; promotion from project → Layer 1 requires explicit user action.
- **(D4)** Trigger strategy: always-on summary + intent-gated `user_profile_search` tool.

If these four hold, the next PR will turn §3–§4 into concrete schemas, file layouts, and tool definitions.
