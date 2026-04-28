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
- Collect the relevant publications from the PI

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

**Guiding principle:** **objective facts only.** No preferences, no likes/dislikes, no inferred personality traits, no writing-style. If a human couldn't verify it from a CV, a website, or the user's own statement, it doesn't go here. This is a deliberate departure from how Claude.ai / ChatGPT memory work — those systems happily store "user prefers concise responses", and that drift is exactly what we want to avoid.

**What goes here:** facts that change at the timescale of *years*.

- Position history (current + past), with `start_date` / `end_date`
- Affiliations, education
- Personal sites, ORCID, social handles
- Collaborator network — names of people the user has worked with, **gradually accumulated from cross-project interactions** (see §4.2 for the trigger). Not derived from paper authorship lists.
- Stable research field at a **very high level only** (e.g., "HPC storage systems"). The agent decides at write-time whether a candidate is "high-level enough"; topic-level interests ("CXL memory pooling") are explicitly Layer 3.

**Explicitly NOT here:** writing-style preferences, tone preferences, "likes coffee", current focus, current papers being written, anything dynamic.

**Storage:** `~/.research-pilot/user-wiki/identity.jsonl` (append-only, one event per line, latest-wins on read). Plain JSONL so it's trivially exportable, inspectable, and deletable by the user.

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

### 4.2 Writes: When Is a Write Triggered, and How Is the Value Captured?

The previous draft conflated two questions. Separating them:

1. **Trigger** — what causes the agent to *propose* a write?
2. **Capture** — once proposed, how does the value (including details like dates) actually get filled in?

#### 4.2.1 Triggers — only three paths, never silent

a. **User explicitly says "remember this" / "save to my profile" / "add this to my bio".** The agent surfaces a lightweight confirm modal pre-filled with the extracted fields.

b. **Agent hits a missing-fact gap during a real task.** Example: user asks "draft my bio paragraph", agent has no `end_date` for a previous position. The agent does **not** guess and does **not** silently store. It asks the user inline ("when did you leave NCSU?"), and after the user answers, offers a one-tap save.

c. **Agent notices a recurring entity across projects.** Example: a collaborator name appears in two or more project memories. The agent surfaces a confirm modal: "Add 'Dr. K' to your collaborator network?" This is the gradual cross-project learning channel for the collaborator network. The threshold is a *prompt threshold*, not a *silent-write threshold* — every addition is still user-confirmed.

We **drop** the earlier "stable signal across ≥N sessions" rule from the previous draft. "Stable signal" is too vague to implement reliably and risks silent writes the user never approved. The current rule: **the agent never writes Layer 1 silently. Period.**

#### 4.2.2 Capture — agent never invents factual values

For Layer 1 entries, the agent's job is to *prompt for and structure* the value, not to infer it.

- **Dates.** `start_date` / `end_date` come from the user's reply, never from agent guesswork. If the user is vague ("a few years ago"), store the imprecise value verbatim with a `precision: "approximate"` flag rather than inventing a year.
- **Same form regardless of trigger.** Whether triggered by (a), (b), or (c), the user sees the same modal shape — extracted fields shown, editable, one-tap save or cancel. This is what makes "lightweight" tractable: one widget, predictable behavior.

#### 4.2.3 Relationship to the existing memory system

We already have project-scoped session summaries in `.research-pilot/memory-v2/session-summaries/`, plus the focus mechanism. The user-wiki is **not** a replacement and does **not** subsume them. The two stores coexist on purpose:

| | Existing project memory | User-wiki (Layer 1) |
|---|---|---|
| Scope | Per-project | Global, cross-project |
| Trigger | Automatic, session-driven | Explicit user confirmation only |
| Content | Free-form summaries, focus snapshots | Structured biographical facts |
| Lifecycle | Mutable, may rotate | Append-only with `as_of` |
| Consumer | This project's agent loop | Cross-project system-prompt summary |

A "remember this" command lands only in user-wiki. A session summary never auto-promotes to user-wiki. The same fact may legitimately appear in both (a session summary may mention the user's job; user-wiki holds the canonical structured version) — this is intentional duplication across stores with different consumers, not a bug to dedupe.

#### 4.2.4 No auto-GC

**No automatic deletion.** Append-only with `as_of` timestamps. "Was at NCSU 2018–2023" and "is at UNC Charlotte 2023–present" coexist; readers resolve "current" by latest non-ended entry.

**Editing UI.** A `/profile` view lets the user see, edit, export, or delete Layer 1 entries directly. The agent never edits without user-visible confirmation.

The crucial design move: **the agent never writes silently and never invents factual content.** Stale entries are the user's problem to clean up via `/profile`. This trades some staleness for a much lower pollution rate.

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
- Detailed UI design for the `/profile` editor (the *shape* — lightweight modal — is decided; pixel-level design is not)
- Migration path from existing focus/session-summary data
- Multi-user / shared profiles
- Cross-device sync of `~/.research-pilot/user-wiki/`

## 7. Open Questions

Several open questions from the prior draft have been resolved by feedback (writing-style → excluded; collaborator-network → cross-project gradual via confirm; export/delete → in scope; field-vs-topic → field-only, agent decides). Remaining:

1. **Granularity of the always-on summary.** Is 500 tokens the right budget? Should it adapt to the active intent (e.g., longer for writing tasks)?
2. **Confirmation modal UX details.** Decided: lightweight, one-tap confirm, single consistent shape across all three trigger paths. Open: should multiple pending writes batch into a single review prompt vs. interrupting per-fact?
3. **Cross-project recurrence threshold.** For trigger path (c), how many projects must mention the same entity before the agent surfaces a confirm? (Likely 2, but worth checking against false-positive rate.)
4. **Imprecise-date handling.** Is the `precision: "approximate"` flag enough, or should we allow date *ranges* as first-class values?

## 8. Decision Requested

Before drafting an implementation plan, I want agreement on:

- **(D1)** The three-layer model (Identity / Project Context / Forbidden Zone) is the right frame.
- **(D2)** Layer 1 stores **objective facts only** — no preferences, writing-style, or likes/dislikes. Append-only with `as_of` timestamps; no auto-GC.
- **(D3)** One-way injection from Layer 1 → project; promotion from project → Layer 1 requires explicit user action.
- **(D4)** Read trigger: always-on summary + intent-gated `user_profile_search` tool.
- **(D5)** Write trigger: only three paths — explicit "remember this", task-driven gap-filling with inline ask, and cross-project recurrence-as-prompt. **No silent writes ever.** Agent never invents factual values (especially dates).
- **(D6)** User-wiki is trivially exportable, inspectable, and deletable by the user via a `/profile` view.

If these six hold, the next PR will turn §3–§4 into concrete schemas, file layouts, and tool definitions.
