Paper Wiki is a background agent that turns every paper you touch into a **local, concept-organized knowledge base** — shared across all your projects. It runs offline, is disabled by default, and is a pure enhancement: the coordinator functions identically without it.

This page is the deep-dive. For the quick version, see the [README feature summary](https://github.com/daidong/PiPilot/blob/main/README.md#cross-project-paper-wiki).

## What it does

When you search literature, open a paper, or let the agent fetch one, Paper Wiki asynchronously:

1. **Canonicalizes identity** — deduplicates across DOI, arXiv ID, and normalized `title+year` so the same paper isn't reprocessed under different keys.
2. **Downloads full text when available** — arXiv PDFs are fetched and cached; otherwise it works from the abstract.
3. **Generates a paper page** — a summary Markdown page with key claims, methodology, and extracted concepts.
4. **Synthesizes concept pages** — recurring concepts get their own cross-paper synthesis page, with back-references to every paper that mentions them.
5. **Indexes for retrieval** — BM25 search over paper and concept pages so the coordinator can recall earlier work via tools.

The wiki sub-agent is the **single writer**. The coordinator never writes to it — a cross-process lock file enforces this.

## Where it lives

```
~/.research-pilot/paper-wiki/
├── SCHEMA.md              # Wiki conventions (LLM reference)
├── index.md               # Content catalog
├── log.md                 # Append-only operation log
├── papers/                # One .md per paper (canonical-slug keyed)
├── concepts/              # Cross-paper synthesis pages
├── raw/arxiv/             # Downloaded arXiv PDFs (cached)
├── converted/             # PDF → Markdown (cached)
└── .state/
    ├── processed.jsonl    # Page-generation watermark
    ├── provenance.jsonl   # Provenance tracking
    └── wiki.lock          # Single-writer lock
```

It's **global**, not per-workspace — the whole point is cross-project memory. Artifacts for the current project still live under `<workspace>/.research-pilot/`.

## Enabling it

1. Open Settings (**Cmd + .**) → **Paper Wiki** tab.
2. Pick a model (see [cost](#cost-expectations) below). `Auto` follows the system-wide priority (subscription first).
3. Pick a speed preset (controls parallelism and how aggressively it indexes).

That's it. The agent starts indexing in the background the next time you interact with papers.

## Cost expectations

Roughly per paper:

| Tier | Input | Output |
|---|---|---|
| Abstract-only | ~8K tokens | ~2K tokens |
| Full-text (PDFs) | ~25K tokens | ~4K tokens |

**Recommendations:**
- **Subscription-backed models** (ChatGPT Pro / Claude Max) are cheapest — no per-token billing.
- **If using API keys:** pick a fast/cheap model (e.g. Haiku, GPT-5.4 mini). The wiki doesn't need frontier reasoning.
- **Start narrow.** If you're unsure, set the model to `none` until you've tested the app without it, then turn it on.

## How the coordinator uses it

The wiki is accessed through read-only tools the agent calls automatically when relevant:

| Tool | Purpose |
|---|---|
| `wiki_search` | BM25 search over paper and concept pages |
| `wiki_get` | Fetch a specific page by slug |
| `wiki_lookup` | Resolve a paper reference to its wiki page |
| `wiki_coverage` | Report which of a set of papers are indexed |
| `wiki_facets` | Query by tag / concept / venue facets |
| `wiki_neighbors` | Find related papers via shared concepts |
| `wiki_source` | Retrieve the raw source (PDF / abstract) |

You don't call these yourself — the coordinator picks the right one based on context.

## Canonical identity (why papers don't get reprocessed)

Within a project, papers are deduped by **DOI > citeKey > title+year**. The wiki uses a different priority for *cross-project* identity:

**DOI > arxivId > normalized(title+year)**

This means a paper you saved via arXiv in project A and via DOI in project B collapses to one wiki page. Identity drift is reconciled automatically; see `lib/wiki/reconcile-identity.ts` if you want the gory details.

## Troubleshooting

### Papers aren't being indexed

- Confirm the wiki is enabled in Settings → Paper Wiki (model is not `none`).
- Check `~/.research-pilot/paper-wiki/log.md` — it's append-only and usually has the reason.
- Make sure the chosen model has auth configured (see [FAQ → Authentication](FAQ#authentication)).

### Costs are higher than expected

- Lower the speed preset — it controls parallelism.
- Switch to a cheaper model. The wiki doesn't need frontier reasoning.
- Consider abstract-only mode if most of your corpus isn't on arXiv anyway.

### I want to start over

Delete `~/.research-pilot/paper-wiki/` entirely. The wiki is pure cache — your artifacts and session summaries live elsewhere and are untouched.

## Design notes

Paper Wiki follows the project's design axiom:

> The system does not pursue complex architecture to guarantee quality. Instead, it pursues minimum discipline to guarantee survival + evidence-driven incremental improvement.

Every failure path degrades to "wiki doesn't exist" behavior. That's why it's disabled by default and isolated from the coordinator's critical path.

For the full design, see [RFC-003: Global Paper Wiki](https://github.com/daidong/PiPilot/blob/main/lib/docs/rfc/003-global-paper-wiki.md) and [RFC-005: Wiki Sidecar and Retrieval](https://github.com/daidong/PiPilot/blob/main/lib/docs/rfc/005-wiki-sidecar-and-retrieval.md).
