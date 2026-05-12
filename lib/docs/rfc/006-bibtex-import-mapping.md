# Design Note 006: BibTeX Importer — Field Mapping

**Status:** Draft v2 — most decisions locked, two minor questions remain (§11)
**Author:** Captain + Claude
**Date:** 2026-05-11 (v1), 2026-05-11 (v2)
**Scope:** Only the field mapping from a parsed BibTeX entry to a
`upsertPaperArtifact()` call. The wizard UI, Zotero `.bib` export
specifics, PDF folder importer, and "Research Memory Report" surface
are out of scope for this note — they reuse this mapping as a building
block.

## 0. Critical Pre-Requisite: PR-0 (`upsertPaperArtifact` Fill-Only)

While drafting this note, an existing bug in `upsertPaperArtifact`
surfaced that **must be fixed before any importer ships**, otherwise
re-imports and dedup collisions will destroy data. This PR-0 is split
out and tracked separately, but is the hard prerequisite for PR-1+.

### The bug

`lib/commands/paper-artifact.ts:93–120` — when an upsert hits dedup,
several fields are passed to `artifactUpdate` **unconditionally**:

```ts
const updated = artifactUpdate(context.projectPath, dedup.id, {
  title,            // ← overwrite, no fallback
  authors,          // ← overwrite, no fallback
  citeKey,          // ← overwrite, no fallback
  doi,              // ← overwrite, AND doi was defaulted to 'unknown:<citeKey>' at line 75!
  bibtex,           // ← overwrite, no fallback
  abstract: opts.abstract ?? dedup.abstract,  // (these later ones are fill-only — correct)
  year:     opts.year     ?? dedup.year,
  // ...
})
```

`artifactUpdate` is a shallow merge (`{ ...found.artifact, ...patch }`
in `lib/memory-v2/store.ts:477`), so the patch wins.

### Concrete failure case

Library already contains, from agent literature-search:

```
title:    "Attention Is All You Need"
authors:  ["Ashish Vaswani", "Noam Shazeer", ...] (11 authors)
doi:      "10.48550/arxiv.1706.03762"
abstract: <full 100-word abstract>
```

User imports a Zotero export entry for the same paper with thinner data
(only first author, no DOI). Dedup matches via `citeKey` or
`title+year`. The update branch then:

1. Overwrites the clean title with the user's lowercased version
2. Collapses 11 authors → `["A. Vaswani", "others"]`
3. Replaces real DOI with `"unknown:vaswani_attention"` (because `doi`
   was defaulted at line 75)
4. Wipes/overwrites the curated BibTeX field
5. The paper's semantic hash (`lib/wiki/types.ts:116` —
   `title/authors/abstract/year/venue/doi/arxivId`) changes, so the
   Paper Wiki agent **re-runs LLM page generation**, burning real cost
6. Because the real DOI was lost, `hasAnyFulltextSource` flips to
   `false` → Paperclip / arXiv full-text retrieval breaks for that paper

### Fix (PR-0)

Adopt the same fill-only semantics that `updatePaperMetadata`
(`paper-artifact.ts:176-223`) already uses for enrichment. For each
field on the dedup-update path, write the new value **only** when the
existing value is missing, empty, or a recognized placeholder
(`unknown:*` for DOI, `["Unknown"]` for authors, `""` for title).

Plus the small API tweak from Q4: add `wasDeduped: boolean` to
`UpsertPaperResult` so the importer can report counts without relying
on timestamp heuristics.

PR-0 touches:
- `lib/commands/paper-artifact.ts` (upsert merge logic + return type)
- `lib/types.ts` (none expected; types referenced indirectly)
- All call sites of `upsertPaperArtifact` — grep confirms only
  `lib/tools/literature-search.ts` consumes the result. Field reads
  there should be unaffected, but verify.
- New unit tests covering: new paper, dedup-by-DOI, dedup-by-citeKey,
  dedup-by-title-year, downgrade-resistance (current bug regression).

PR-0 is a **hard prerequisite** for this importer. Without it, every
re-import of a `.bib` containing thinner metadata than what's in the
library will silently corrupt data.

## 1. Why a Design Note (Not an RFC)

This is the narrowest possible slice of the larger Paper Memory
Quickstart work. The goal is to lock the **data contract** before any
code lands, so that:

- the BibTeX parser choice doesn't accidentally lose fields we'll
  later need for Crossref enrichment or Paper Wiki indexing,
- the dedup behaviour (`findExistingPaperArtifact`) sees consistent
  `doi` / `citeKey` shapes whether a paper came from agent search or
  a `.bib` import,
- once approved, the actual importer implementation is mechanical.

## 2. Architectural Anchors (Already in Code)

| Anchor | Location | What it gives us |
|---|---|---|
| `upsertPaperArtifact(title, opts, ctx)` | `lib/commands/paper-artifact.ts:39` | Single write path; runs dedup before insert. **All importers funnel through this.** |
| `findExistingPaperArtifact` | `lib/memory-v2/store.ts:557` | Dedup by `doi` → `citeKey` → exact-match-on-normalized title (+ year if both have one). Importer does **not** do its own dedup. |
| `enrichPaperArtifacts({ paperIds })` | `lib/commands/paper-enrichment.ts:65` | Crossref + Semantic Scholar fill-in for missing fields. Importer **does not** call APIs itself. |
| `Provenance.source: 'user' \| 'agent' \| 'import'` | `lib/types.ts:73` | The literal `'import'` is reserved but unused today. BibTeX importer is its first consumer. |
| `PaperArtifact` schema | `lib/types.ts:103` | Authoritative target shape (see §6). |
| Paper Wiki scanner | `lib/wiki/scanner.ts` | Auto-picks up new `type === 'paper'` artifacts on next idle tick — importer does nothing to invoke it. |
| `computeSemanticHash` | `lib/wiki/types.ts:116` | Determines when a paper change retriggers LLM wiki re-processing (fields: title/authors/abstract/year/venue/doi/arxivId). |

## 3. Parser Selection — Locked

**`@retorquere/bibtex-parser` v9.0.29** (verified 2026-05-11):

| Metric | Value |
|---|---|
| Latest release | 9.0.29 — 2026-03-13 (recent, active) |
| First release | 2019-08-17 (6+ years mature) |
| Weekly downloads | 2,900 |
| Monthly downloads | 10,365 |
| GitHub security advisories | 0 |
| Open issues | 0 |
| License | ISC (package.json) / MIT (repo) — both permissive |

**One caveat to record**: unpacked size is **8.5 MB**, pulling in the
`@unified-latex/*` family, `wink-nlp` + `wink-eng-lite-web-model`,
`unicode2latex`, `nearley`, `moo`. The dependency hop is significant
because of the linguistic and LaTeX-AST tooling. This is acceptable
because:

- The parser runs in the **main process only**; it is never bundled
  into the renderer (no impact on first-paint or chat UI)
- The Electron base install is already ~150 MB, so 8 MB is < 6%
  additional
- The cost buys correct handling of Zotero exports, LaTeX accents
  (`{\'e}` → `é`), name particles (`"von der Berg, Hans"`), `@string`
  macros, and BibLaTeX extensions — re-implementing these manually
  would be far worse

Decision is locked unless we discover a runtime correctness issue
during PR-2 implementation.

## 4. Locked Decisions Summary (Q1-Q6)

| ID | Decision |
|---|---|
| Q1 | `@retorquere/bibtex-parser` v9.0.29; verified npm metadata (§3) |
| Q2 | `identityConfidence`: DOI → `'high'`, arXiv-only → `'medium'`, neither → `'low'` |
| Q3 | Fill-only merge semantics (delivered via PR-0, see §0) |
| Q4 | Add `wasDeduped: boolean` to `UpsertPaperResult` (delivered via PR-0) |
| Q5 | Per-entry failure is soft: skip the bad entry, return a `failureDetails: []` list, continue importing the rest. Only fail the whole import when the file is not BibTeX at all (no `@xxx{...}` blocks found). |
| Q6 | IPC: `cmd:import-bibtex` (renderer → main), progress events on `import:progress` (main → renderer). Same shape pattern as `cmd:enrich-papers` / `enrich:progress`. |
| Same-file dup | If the same `citeKey` appears twice in one `.bib`, **keep the first occurrence**, record the second in `failureDetails` as a warning. |
| Hybrid paper source | On dedup-merge, **preserve the original `externalSource`**. Do not add a `additionalSources` array or any UI surface for "imported via N sources" — out of scope. |

## 5. Fixture `.bib` Entries

These ten fixtures encode every edge case the mapping must survive.
They will be checked into `lib/importers/__tests__/fixtures/sample.bib`
during PR-2 implementation.

### F1 — Canonical `@article` with DOI

```bibtex
@article{smith2024transformer,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  journal = {Advances in Neural Information Processing Systems},
  year = {2024},
  volume = {37},
  doi = {10.48550/arXiv.1706.03762},
  url = {https://arxiv.org/abs/1706.03762},
}
```

### F2 — `@inproceedings` with `booktitle` instead of `journal`

```bibtex
@inproceedings{chen2023rag,
  title = {Retrieval-Augmented Generation for Knowledge-Intensive {NLP} Tasks},
  author = {Lewis, Patrick and Perez, Ethan and Piktus, Aleksandra},
  booktitle = {Proceedings of NeurIPS},
  year = {2023},
  pages = {9459--9474},
}
```

### F3 — arXiv-only entry (no DOI, BibLaTeX `eprint`)

```bibtex
@online{anon2024llmagent,
  title = {Survey of {LLM} Agents},
  author = {Anonymous Researcher},
  year = {2024},
  eprint = {2410.12345},
  eprinttype = {arXiv},
  eprintclass = {cs.AI},
}
```

### F4 — LaTeX accents and ligatures

```bibtex
@article{moller2022,
  title = {Caf{\'e}-Bench: Evaluating {AI} on French Bistro Menus},
  author = {M{\"o}ller, J{\"u}rgen and {\'A}lvarez, Jos{\'e}},
  journal = {Nature},
  year = {2022},
  doi = {10.1038/s41586-022-00001-1},
}
```

### F5 — Name particles ("von", "Jr.")

```bibtex
@book{vonberg2020,
  title = {Compiler Design},
  author = {von der Berg, Hans and Smith, Jr., Robert},
  publisher = {MIT Press},
  year = {2020},
}
```

### F6 — `@misc` with no year, no venue, no DOI (worst case)

```bibtex
@misc{blogpost,
  title = {Thoughts on Scaling Laws},
  author = {Karpathy, Andrej},
  howpublished = {Blog post},
  url = {https://karpathy.github.io/2024/scaling.html},
}
```

### F7 — Zotero export with `file` field pointing at local PDF

```bibtex
@article{zotero2024,
  title = {A Real Paper},
  author = {Doe, Jane},
  journal = {Science},
  year = {2024},
  doi = {10.1126/science.abc1234},
  file = {Full Text:files/12345/Doe - 2024 - A Real Paper.pdf:application/pdf},
}
```

### F8 — Duplicate of F1 with a different citeKey (dedup test)

```bibtex
@article{vaswani_attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2024},
  doi = {10.48550/arXiv.1706.03762},
}
```

### F9 — Entry with `@string` macro (must resolve)

```bibtex
@string{NIPS = {Neural Information Processing Systems}}

@inproceedings{bengio2003,
  title = {A Neural Probabilistic Language Model},
  author = {Bengio, Yoshua and Ducharme, R{\'e}jean},
  booktitle = NIPS,
  year = {2003},
}
```

### F10 — Malformed (missing closing brace) — must fail soft

```bibtex
@article{broken,
  title = {This Entry Is Broken,
  author = {Nobody},
  year = {2024},
```

### F11 — Same `citeKey` twice in one file (Group A1 in §7)

```bibtex
@article{dupkey,
  title = {First Occurrence},
  author = {Author, A.},
  year = {2024},
}

@article{dupkey,
  title = {Second Occurrence — Should Be Skipped},
  author = {Author, B.},
  year = {2024},
}
```

### F12 — Author with `"and others"`

```bibtex
@article{etalentry,
  title = {Paper With Truncated Author List},
  author = {Smith, John and others},
  year = {2024},
  doi = {10.1234/etal.2024},
}
```

### F13 — Year as "to appear" / non-numeric

```bibtex
@article{toappear,
  title = {A Paper That Has Not Appeared},
  author = {Future, Anne},
  journal = {Future Journal},
  year = {to appear},
}
```

### F14 — Title containing math mode

```bibtex
@article{mathmode,
  title = {Optimal Algorithms in $O(n^2)$ Time},
  author = {Knuth, Donald},
  year = {2024},
  doi = {10.1234/math.2024},
}
```

## 6. Field Mapping Table

`BibInput` is the intermediate type produced by the parser layer.
The right-hand column is what gets passed to `upsertPaperArtifact()`.

| `PaperArtifact` field | Source in `.bib` | Transformation |
|---|---|---|
| `title` (required) | `title` | LaTeX decode (`{\'e}` → `é`, `--` → `–`, `\&` → `&`); strip outer `{}`; collapse internal whitespace. Math mode (`$...$`) preserved verbatim. |
| `authors` | `author` | Split on top-level ` and ` (case-insensitive, brace-aware); for each name, prefer `"Last, First"` form → output `"First Last"`. Handle `"von der Berg, Hans"` → `"Hans von der Berg"`. The literal token `"others"` is **dropped** (BibTeX convention for `et al.`). |
| `year` | `year` *or* parsed from BibLaTeX `date = {2024-03}` | Coerce to integer; drop if not 1900–2100. Non-numeric values like `"to appear"` → `undefined`. |
| `doi` | `doi` *or* extracted from `url = "https://doi.org/..."` | Normalize via existing `normalizeDOI`. If none, leave `opts.doi` undefined and let upsert default to `unknown:<citeKey>`. |
| `arxivId` | `eprint` when `eprinttype = arXiv` *or* extracted from `url` matching `arxiv.org/abs/...` *or* DOI prefix `10.48550/arXiv.` | Strip `vN` suffix; validate via existing `isValidArxivId`. |
| `venue` | First non-empty of: `journal` (article), `booktitle` (inproceedings/incollection), `howpublished` (misc), `publisher` (book/phdthesis) | LaTeX decode. |
| `url` | `url` | Pass through. |
| `pdfUrl` | Heuristic: `url` only if it ends in `.pdf` | **Never** synthesize from `file` field — see §8. |
| `abstract` | `abstract` | LaTeX decode. Empty string if absent (matches `upsertPaperArtifact` default). |
| `citeKey` | BibTeX entry key (the `xxx` in `@article{xxx, ...}`) | Pass through as-is. |
| `bibtex` | Original entry text, verbatim | Preserve `@string` macros as already resolved by the parser. Never use `buildFallbackBibtex` from importer — see §9. |
| `externalSource` | n/a | Always `'bibtex-import'`. (See §10 for hybrid-paper rule.) |
| `identityConfidence` | Derived | `'high'` if DOI present; `'medium'` if arxivId present (no DOI); `'low'` otherwise. |
| `provenance.source` | n/a | `'import'` (first use of this enum literal). |
| `provenance.extractedFrom` | n/a | `'file-import'`. |
| `provenance.sessionId` | from `ctx` | Pass through. |
| `tags` | `keywords` (comma- or semicolon-split) | Trim, dedupe, lowercase. |

### Fields deliberately left undefined

| Field | Why |
|---|---|
| `relevanceScore`, `relevanceJustification`, `subTopic` | Literature-study judgments. A user's BibTeX library is not a scored study. Leaving these `undefined` correctly causes `ScoreBadge` (`LiteratureView.tsx:29`) to render nothing. |
| `addedInRound`, `addedByTask` | Literature-study round identifiers. Importer is not a study. |
| `searchKeywords` | Agent-search artifact, not applicable. |
| `keyFindings` | LLM-extracted from full text. Defer to Paper Wiki. |
| `citationCount` | Comes from Crossref / Semantic Scholar via post-import enrichment. |
| `fulltextPath` | Set by the Paper Wiki fulltext pipeline. |
| `pubmedId`, `pmcId`, `semanticScholarId` | Not standard BibTeX fields; filled later by enrichment. |
| `enrichmentSource`, `enrichedAt` | Set by `enrichPaperArtifacts`. |

## 7. Corner Cases — Exhaustive Catalog

Each case lists: scenario / what happens today (with PR-0 applied) /
required importer behavior.

### Group A — Duplicates inside one `.bib` file

**A1. Same `citeKey` twice** (fixture F11)
- Parser layer: `@retorquere/bibtex-parser` exposes duplicates; we
  detect and **keep first, skip second**.
- Reported as a non-fatal warning in `failureDetails`:
  `{ citeKey, reason: 'duplicate-citekey-in-file' }`.

**A2. Different `citeKey`s, same paper** (fixture F8 vs F1)
- First entry → new paper artifact.
- Second entry → dedup via DOI hit → fill-only merge (no-op in this
  case since first entry already has all fields).
- `bibtex` field keeps **first** entry's raw text (see §9).
- UI summary line: `"merged: N (Group A2 — same paper, different citekey)"`.

### Group B — Re-import of the same `.bib`

**B1. Bit-for-bit identical re-import**
- Every entry dedups. Fill-only finds no missing fields. 100% no-op.
- Summary: `{ added: 0, merged: N, fieldsFilled: 0 }`.

**B2. User added DOIs in Zotero, re-imports**
- Existing artifacts have `doi: 'unknown:<citeKey>'`; new entries
  carry real DOIs. Fill-only detects `unknown:*` placeholder and
  writes the real DOI in.
- `identityConfidence` should also be lifted `'low'` → `'high'` in
  this case. Importer code must check and update.
- Wiki re-processes affected papers (semantic hash includes DOI).

**B3. User edited a paper inside PiPilot (typo fix), `.bib` still has old version**
- Fill-only preserves PiPilot edits because they're not "empty /
  placeholder". The `.bib`'s stale data is silently dropped.
- Correct behavior — user-intent edits beat batch re-imports.

**B4. User deletes 20 entries from `.bib`, re-imports the remaining 80**
- The 20 deleted papers stay in the library as "orphans" — `.bib`
  doesn't mention them, but PiPilot has no signal that the user
  intended to delete.
- **No auto-delete.** Importer never removes artifacts.
- Summary may include `"Note: your library contains N papers not in
  this .bib file. None were removed."` (deferred to wizard UI; not
  this PR).

### Group C — Conflict with library

**C1. `.bib` paper was previously added by agent literature-search**
- Most common case. Dedup via DOI.
- Fill-only fills missing `tags`/`venue`/`bibtex` (if previously
  auto-generated) without disturbing `relevanceScore`/`subTopic`.
- `externalSource` stays as `'literature-search'`. **No hybrid
  source tracking — locked decision.**

**C2. `.bib` paper was previously dropped manually with `unknown:*` DOI**
- Library has `doi: 'unknown:foo'`, `title: 'paper.pdf'`,
  `citeKey: 'unknown<ts>'`. `.bib` has real DOI, real title, real
  citeKey.
- Dedup priority is `doi → citeKey → title+year`. **None match.**
  Result: a new paper artifact is created → **silent duplicate** in
  the library.
- **Deferred — not solved in PR-1/PR-2.** Documented here so we
  remember. See §11 Q8 for the decision rationale.

**C3. `.bib` paper title fuzzy-matches an existing one**
- `findExistingPaperArtifact` does exact match on normalized title
  (lowercase, punctuation collapsed, whitespace normalized) +
  optional year. "Slightly different" titles do **not** match.
- Effect: if titles differ even by one extra word, treated as
  separate papers. Acceptable; users can manually merge later.

### Group D — `.bib` data quality issues

**D1. DOI typo (`10.1234/wrong` instead of `10.1234/right`)**
- Garbage in, garbage out. We import with the typo'd DOI.
  `identityConfidence` is still `'high'` (we trust the DOI field's
  presence, not its correctness).
- Enrichment will fail or return a wrong paper. We don't try to
  detect this in PR-2 (out of scope; might be a future "verify
  identities" feature).

**D2. Author `"X and others"`** (fixture F12)
- Drop the literal `"others"` token. Authors = `["X"]`.
- `identityConfidence` not downgraded — we still trust the DOI if
  present.
- Enrichment can fill the full author list from Crossref.

**D3. Title with LaTeX math mode (`$O(n^2)$`)** (fixture F14)
- Preserve verbatim. Downstream markdown renderer (KaTeX) handles
  display. Consistent with `paper-writing` skill semantics.

**D4. Title with LaTeX formatting commands (`{\\bf BERT}`)**
- `@retorquere/bibtex-parser` strips `\\bf`/`\\it`/`\\emph` etc.
  while keeping the wrapped content. No custom logic needed.

**D5. File encoding not UTF-8**
- Read with `readFileSync(path, 'utf-8')`. If decoding yields
  replacement characters (U+FFFD) and we can detect, return clear
  error: `"file is not UTF-8 — please re-export from your reference
  manager as UTF-8"`.
- **Do not auto-detect** alternative encodings (latin-1, gbk, etc.) —
  wrong guesses silently corrupt all accented characters.

**D6. Non-numeric year (`"to appear"`, `"in press"`)** (fixture F13)
- `parseYear()` returns `undefined`. Paper imports with `year`
  unset.
- Enrichment may fill it later when the paper actually publishes.

**D7. Empty `.bib` file or file with only `@comment` blocks**
- Parser returns 0 entries. Summary: `added: 0, failed: 0`. Not an
  error.

**D8. File that isn't BibTeX at all** (e.g. user picked `references.txt`)
- Parser returns 0 entries OR a fatal error. Importer detects "no
  `@xxx{...}` blocks found anywhere" and returns a **fatal** error
  rather than `added: 0`. Q5 exception.

### Group E — Wiki agent interaction

**E1. Import 500 papers at once**
- Synchronous to artifact writes; Papers tab populates immediately.
- Wiki agent processes asynchronously at its normal pacing
  (single-writer, 5–15 s per paper). Total wiki processing time:
  ~1–2 hours running in background.
- UI: the existing `WikiStatusPill` already shows
  `"Wiki · processing N/M"`. No new UI needed.

**E2. Enrichment of 500 papers**
- Sequential through `enrichPaperArtifacts`, rate-limited by
  CrossRef (50 req/s) and Semantic Scholar (1 req/s). Bottleneck is
  S2 → ~8 minutes for 500 papers.
- Non-blocking; progress reported via `enrich:progress`.

**E3. Re-import triggering wiki re-process (post-PR-0)**
- Fill-only means most re-imports don't change semantic-hash fields.
- When fields *do* change (e.g. B2 — DOI added), wiki re-processing
  is correct behavior. Cost is paid only for actually-changed
  papers.

### Group F — Cross-project

**F1. Same `.bib` imported in Project A, then Project B**
- Paper artifacts are project-local: Project B independently creates
  its own copies. No deduplication across projects (by design).
- Paper Wiki is global: wiki pages built once (canonical key
  collision). `provenance_projects` records the paper was used in A
  and B. Correct behavior.

### Group G — Deletion / Undo

**G1. User regrets the import, wants to undo**
- No "undo entire batch" action. The wizard's Done page lists newly
  added paper IDs, each with a per-row Delete button. This matches
  the existing single-artifact-delete UX.
- Implementation deferred to wizard PR (PR-4).

**G2. User deleted a paper, re-imports `.bib`**
- `findExistingPaperArtifact` doesn't find it (file was removed).
- New paper artifact is created.
- Wiki watermark from the prior generation may still exist; canonical
  key match means wiki agent skips LLM re-generation (correct
  behavior — minimal cost).

## 8. `pdfUrl` Field — Do **Not** Convert Local Paths

Zotero exports include `file = {Title:files/12345/foo.pdf:mime}`.
This is a Zotero-relative path, not a URL. The BibTeX importer
**ignores** this field entirely. Reasons:

- A `file:///` URL would only resolve on the user's current machine.
- PDF copy/registration is the responsibility of a separate
  `.bib + PDFs` importer slice (future PR).
- The Paper Wiki fulltext pipeline retrieves PDFs from arXiv /
  Paperclip once DOI or `arxivId` is present — preferred path.

## 9. `bibtex` Field — Store Verbatim, First Wins

The importer passes the **original entry text** of each `.bib` entry
to `upsertPaperArtifact`. It does **not** call `buildFallbackBibtex`.

On dedup-merge, the existing `bibtex` field is preserved (under
fill-only). Specifically:

- If the existing paper's `bibtex` was set by an importer or by the
  user, it stays (first-wins).
- If the existing paper's `bibtex` was previously auto-generated by
  `buildFallbackBibtex` (because it was created by agent search
  without curated BibTeX), the **new BibTeX from `.bib` should
  arguably win** because the user-provided BibTeX is more authoritative.
  This is the open question Q7 in §11.

## 10. Exact `upsertPaperArtifact` Call Shape

```ts
// lib/importers/bibtex.ts (sketch — illustrative)

import { upsertPaperArtifact } from '../commands/paper-artifact.js'
import type { CLIContext } from '../types.js'

interface BibEntry {
  citeKey: string
  entryType: string                   // 'article' | 'inproceedings' | ...
  fields: Record<string, string>      // already LaTeX-decoded
  rawSource: string                   // verbatim entry text including @ and braces
}

interface BibImportProgress {
  citeKey: string
  status: 'parsed' | 'upserted' | 'deduped' | 'failed' | 'duplicate-in-file'
  error?: string
}

export interface BibImportResult {
  added: number          // new paper artifacts created
  merged: number         // dedup-merged into existing
  fieldsFilled: number   // count of merges where at least one field changed
  failed: number         // soft failures (per-entry)
  failureDetails: Array<{ citeKey: string; reason: string }>
  importedPaperIds: string[]   // feed directly into enrichPaperArtifacts
}

export function importBibtexEntry(
  entry: BibEntry,
  ctx: CLIContext,
  onProgress?: (e: BibImportProgress) => void,
): { paperId: string; deduped: boolean } | { failed: true; reason: string } {
  const title = entry.fields.title
  if (!title) {
    onProgress?.({ citeKey: entry.citeKey, status: 'failed', error: 'missing-title' })
    return { failed: true, reason: 'missing-title' }
  }

  const authors = parseAuthorList(entry.fields.author)
  const year    = parseYear(entry.fields.year ?? entry.fields.date)
  const doi     = extractDoi(entry.fields.doi, entry.fields.url)
  const arxivId = extractArxivId(entry)
  const venue   = pickVenue(entry)

  const confidence: 'high' | 'medium' | 'low' =
    doi ? 'high' : (arxivId ? 'medium' : 'low')

  const result = upsertPaperArtifact(
    title,
    {
      authors,
      year,
      venue,
      url: entry.fields.url,
      pdfUrl: undefined,                  // §8 — never from `file` field
      abstract: entry.fields.abstract ?? '',
      citeKey: entry.citeKey,
      doi,
      arxivId,
      bibtex: entry.rawSource,            // §9 — verbatim
      tags: parseKeywords(entry.fields.keywords),
      externalSource: 'bibtex-import',
      identityConfidence: confidence,
      // Deliberately undefined: relevanceScore, subTopic, keyFindings,
      // addedInRound, addedByTask, searchKeywords, citationCount,
      // fulltextPath, pubmedId, pmcId, semanticScholarId,
      // enrichmentSource, enrichedAt.
    },
    ctx,
  )

  if (!result.success || !result.paper) {
    onProgress?.({
      citeKey: entry.citeKey,
      status: 'failed',
      error: result.error ?? 'upsert-failed',
    })
    return { failed: true, reason: result.error ?? 'upsert-failed' }
  }

  // result.wasDeduped comes from PR-0 — no timestamp heuristics.
  onProgress?.({
    citeKey: entry.citeKey,
    status: result.wasDeduped ? 'deduped' : 'upserted',
  })

  return { paperId: result.paper.id, deduped: !!result.wasDeduped }
}

export async function importBibtexFile(
  bibPath: string,
  ctx: CLIContext,
  onProgress?: (e: BibImportProgress) => void,
): Promise<BibImportResult> {
  // 1. readFileSync(bibPath, 'utf-8'); detect replacement characters (D5).
  // 2. parse with @retorquere/bibtex-parser; if 0 entries AND no @xxx
  //    syntax detected, return fatal error (D8).
  // 3. detect same-citekey duplicates within the file (A1); skip later
  //    occurrences; record to failureDetails.
  // 4. for each entry: importBibtexEntry(entry, ctx, onProgress).
  // 5. collect importedPaperIds; caller passes to enrichPaperArtifacts.
  // 6. Wiki agent picks up new artifacts automatically (no invocation).
}
```

### What this code does **not** do

- ❌ No HTTP. Caller invokes `enrichPaperArtifacts({ paperIds })`
  after import finishes.
- ❌ No PDF I/O. PDF folder is a separate importer.
- ❌ No Wiki manipulation. Background scanner picks up new artifacts.
- ❌ No UI. The wizard is a separate slice.
- ❌ No batch undo. Per-row delete in the Done page covers this.

## 11. Remaining Open Questions (Decision Needed Before PR-2)

**Q7 — `bibtex` field overwrite when existing is auto-generated.**

Background: when agent literature-search creates a paper, it sets
`bibtex` to whatever `buildFallbackBibtex` produces — a minimal
auto-generated string. If a user later imports a `.bib` containing
the curated BibTeX for the same paper, **should the imported version
replace the auto-generated one?**

- (a) **Always preserve first** — simple, deterministic, but means
  curated user BibTeX never replaces agent-fallback BibTeX. Bad for
  the `paper-writing` skill which emits `references.bib` from this
  field.
- (b) **Replace when existing matches auto-generated pattern** —
  detect by re-running `buildFallbackBibtex(...)` and string-comparing.
  Cheap, but fragile if the fallback format ever changes.
- (c) **Add a flag** `bibtexIsAutoGenerated: boolean` to
  `PaperArtifact`. Set when `buildFallbackBibtex` runs, cleared on
  any user/import write. Then importer replaces freely when flag is
  true. Cleanest, but adds a schema field.

Recommendation: **(c)**. Schema field is cheap and explicit. Lands
in PR-0 alongside `wasDeduped`. Importer in PR-2 acts on it.

**Q8 — `.bib`-vs-manual-drop collision (Group C2).**

When a user previously dropped a PDF (creating a paper with
`title='paper.pdf'`, `doi='unknown:...'`) and then imports a `.bib`
with the real DOI for the same paper, dedup misses on all three
keys → silent duplicate.

Options:
- (a) **Accept and document** — let the duplicate happen; rely on a
  future "merge papers" UI for users to resolve manually.
- (b) **Post-import scan** — after the import completes, look for
  papers that share fuzzy title+year and prompt the user to confirm
  merges. Heavier; adds a UX surface.
- (c) **Pre-import fuzzy probe** — extend `findExistingPaperArtifact`
  with a fuzzy fallback (Levenshtein on title) before declaring
  "new paper". Risky — fuzzy dedup has false positives.

Recommendation: **(a) for PR-1/PR-2.** Document the gap. Revisit
once we have telemetry showing users actually hit it. Don't pre-
emptively engineer.

If you sign off on (c) for Q7 and (a) for Q8, the design note is
locked and we can start PR-0.

## 12. PR Roadmap

| PR | Title | Touches |
|---|---|---|
| **PR-0** | `upsertPaperArtifact` fill-only + `wasDeduped` + `bibtexIsAutoGenerated` | `lib/commands/paper-artifact.ts`, `lib/types.ts`, tests |
| **PR-1** | This design note (already up at #48) | `lib/docs/rfc/006-bibtex-import-mapping.md` |
| **PR-2** | BibTeX importer implementation + fixtures + unit tests | `lib/importers/bibtex.ts`, `lib/importers/__tests__/` |
| **PR-3** | IPC wiring (`cmd:import-bibtex` + `import:progress`) + renderer store | `app/src/main/ipc.ts`, `app/src/preload/index.ts`, renderer store |
| **PR-4** | Wizard UI (Papers-tab empty-state CTA + HeroIdle CTA) | `app/src/renderer/components/center/LiteratureView.tsx`, `HeroIdle.tsx`, new wizard component |

## 13. Out of Scope for This Note

- Zotero `.bib` export specifics beyond what the fixtures cover
- PDF folder importer
- Wizard UI / first-launch placement
- Research Memory Report (the Paper Wiki *is* the report)
- Enrichment chaining (caller's responsibility)
- Telemetry / activity-store wiring
- "Merge papers" UI for resolving manual-drop / `.bib` duplicates
  (Group C2, Q8)
- Batch-undo for imports
