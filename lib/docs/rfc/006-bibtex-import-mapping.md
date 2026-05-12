# Design Note 006: BibTeX Importer — Field Mapping

**Status:** Draft — awaiting review
**Author:** Captain + Claude
**Date:** 2026-05-11
**Scope:** *Only* the field mapping from a parsed BibTeX entry to a
`upsertPaperArtifact()` call. The wizard UI, Zotero `.bib` export handling,
PDF folder importer, and "Research Memory Report" surface are all out of
scope for this note — they reuse this mapping as a building block.

## 1. Why a Design Note (Not an RFC)

This is the narrowest possible slice of the larger Paper Memory Quickstart
work. The goal is to lock the **data contract** before any code lands, so
that:

- the BibTeX parser choice doesn't accidentally lose fields we'll later
  need for Crossref enrichment or Paper Wiki indexing,
- the dedup behaviour (`findExistingPaperArtifact`) sees consistent
  `doi` / `citeKey` shapes whether a paper came from agent search or a
  `.bib` import,
- once approved, the actual importer implementation is mechanical.

## 2. Architectural Anchors (Already in Code)

These exist today and dictate the shape of the mapping. Reproducing them
here so the doc is self-contained for review.

| Anchor | Location | What it gives us |
|---|---|---|
| `upsertPaperArtifact(title, opts, ctx)` | `lib/commands/paper-artifact.ts:39` | Single write path; runs dedup before insert. **All importers funnel through this.** |
| `findExistingPaperArtifact` | `lib/memory-v2/store.ts` | Dedup by `doi` → `citeKey` → fuzzy (title + year). Importer does **not** do its own dedup. |
| `enrichPaperArtifacts({ paperIds })` | `lib/commands/paper-enrichment.ts:65` | Crossref + Semantic Scholar fill-in for missing fields. Importer **does not** call APIs itself. |
| `Provenance.source: 'user' \| 'agent' \| 'import'` | `lib/types.ts:73` | The literal `'import'` is reserved but unused today. BibTeX importer is its first consumer. |
| `PaperArtifact` schema | `lib/types.ts:103` | Authoritative target shape (see §5). |
| Paper Wiki scanner | `lib/wiki/scanner.ts` | Auto-picks up new `type === 'paper'` artifacts on its next tick — importer does nothing to invoke it. |

## 3. Parser Selection

### Candidates

| Package | Pros | Cons / Risks |
|---|---|---|
| `@retorquere/bibtex-parser` | Maintained by the Better-BibTeX-for-Zotero author; handles Zotero quirks (escaped braces, name particles, math mode). | Heavier dependency; pulls in unified/remark. Worth verifying current bundle impact. |
| `bibtex-ts` / `@orcid/bibtex-parse-js` | Lighter; pure JS. | Older; weak on LaTeX accent escapes and "von / Jr." name parsing. |
| Hand-rolled regex | Zero deps. | We will get the edge cases wrong. **Rejected** — see §7. |

### Recommendation

Use **`@retorquere/bibtex-parser`** as the parser. The cost of a heavier
dep is small compared to the cost of mis-parsing real Zotero exports,
which is what most users will feed in.

**Decision pending Captain's input** — see §10, question Q1. Before
installing, the implementer must check current weekly downloads, last
publish date, and audit advisories, since this note was written without
live npm verification.

## 4. Fixture `.bib` Entries (Cases the Mapping Must Handle)

These ten fixtures encode every edge case the mapping needs to survive.
They will be checked into `lib/importers/__tests__/fixtures/sample.bib`
once implementation starts.

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

### F6 — `@misc` with no year, no venue, no DOI (worst-case)

```bibtex
@misc{blogpost,
  title = {Thoughts on Scaling Laws},
  author = {Karpathy, Andrej},
  howpublished = {Blog post},
  url = {https://karpathy.github.io/2024/scaling.html},
}
```

### F7 — Zotero-exported entry with `file` field pointing at local PDF

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

## 5. Field Mapping Table

`BibInput` is the intermediate type produced by the parser layer. The
right-hand column is what gets passed to `upsertPaperArtifact()`.

| `PaperArtifact` field | Source in `.bib` | Transformation |
|---|---|---|
| `title` (required) | `title` | LaTeX decode (`{\'e}` → `é`, `--` → `–`, `\&` → `&`); strip outer `{}`; collapse internal whitespace. |
| `authors` | `author` | Split on top-level ` and ` (case-insensitive, brace-aware); for each name, prefer `"Last, First"` form → output `"First Last"`. Handle `"von der Berg, Hans"` → `"Hans von der Berg"`. Drop suffix particles like `Jr.` into the surname segment. |
| `year` | `year` *or* parsed from BibLaTeX `date = {2024-03}` | Coerce to integer; drop if not 1900–2100. |
| `doi` | `doi` *or* extracted from `url = "https://doi.org/..."` | Normalize via existing `normalizeDOI` (strip `https://doi.org/`, lowercase). If none, leave for upsert to set `unknown:<citeKey>`. |
| `arxivId` | `eprint` when `eprinttype = arXiv` *or* extracted from `url = "arxiv.org/abs/..."` *or* DOI prefix `10.48550/arXiv.` | Strip `vN` suffix; validate via existing `isValidArxivId` from `lib/wiki/types.ts`. |
| `venue` | `journal` (for `@article`) *or* `booktitle` (for `@inproceedings`, `@incollection`) *or* `howpublished` (for `@misc`) *or* `publisher` (for `@book`, `@phdthesis`) | First non-empty wins; LaTeX decode. |
| `url` | `url` | Pass through. If `url` was *only* a DOI link, leave it but also set `doi`. |
| `pdfUrl` | Heuristic: `url` if it ends in `.pdf`; otherwise undefined. | Do **not** synthesize from `file` field — that's a local path, not a URL. |
| `abstract` | `abstract` | LaTeX decode. Empty string if absent (matches `upsertPaperArtifact` default). |
| `citeKey` | BibTeX entry key (the `xxx` in `@article{xxx, ...}`) | Pass through as-is. If empty (malformed), let `upsertPaperArtifact` regenerate via `generateCiteKey(authors, year)`. |
| `bibtex` | The **original** entry text, verbatim | Preserve `@string` macros as already resolved (BibTeX library will inline them). Do not regenerate — the user's `.bib` is the source of truth for citation style. |
| `externalSource` | n/a | Always `'bibtex-import'`. (See §6 for rationale.) |
| `identityConfidence` | derived | `'high'` if DOI present; `'medium'` if arxivId present; `'low'` otherwise. |
| `provenance.source` | n/a | `'import'`. |
| `provenance.extractedFrom` | n/a | `'file-import'`. |
| `provenance.sessionId` | from `ctx` | Pass through. |
| `tags` | `keywords` (comma- or semicolon-split) | Trim, dedupe, lowercase. |

### Fields we **deliberately leave undefined**

| Field | Why |
|---|---|
| `relevanceScore` | Score is the literature-team agent's judgement of "relevance to a specific study". A user's BibTeX library is not a scored study. Leaving it `undefined` correctly causes `ScoreBadge` (`LiteratureView.tsx:29`) to render nothing. |
| `relevanceJustification` | Same reason. |
| `subTopic` | Same — this is a study-level grouping. |
| `addedInRound` / `addedByTask` | Both are literature-study round identifiers (`"R-01"`, `"deep_literature_study"`). Importer is not a study. |
| `searchKeywords` | Agent-search artefact. Not applicable. |
| `keyFindings` | LLM-extracted from full text. Defer to Paper Wiki agent. |
| `citationCount` | Comes from Crossref/Semantic Scholar via the post-import enrichment pass — not from `.bib`. |
| `fulltextPath` | Set by the Paper Wiki fulltext pipeline. Importer never writes this. |
| `pubmedId` / `pmcId` / `semanticScholarId` | Not standard BibTeX fields. Filled later by enrichment. |
| `enrichmentSource` / `enrichedAt` | Set by `enrichPaperArtifacts`. |

## 6. `externalSource` Value Choice

Use the single string `'bibtex-import'`. Rationale:

- It distinguishes this importer from future ones (`'zotero-bib-import'`,
  `'pdf-folder-import'`) without re-using a string that already means
  something (`'literature-search'`, `'arxiv'`, `'crossref'`).
- It makes the existing source filter UI (`LiteratureView.tsx`'s
  `filter.source`) immediately useful: users can quickly slice "things
  I imported via BibTeX" without any new UI work.
- It is stable across re-imports — if a `.bib` is re-imported, the
  dedup path in `upsertPaperArtifact` will preserve the original
  `externalSource` via the `opts.externalSource ?? dedup.externalSource`
  pattern (`paper-artifact.ts:107`), so we don't churn.

## 7. The `bibtex` Field — Store Verbatim, Not Regenerated

`upsertPaperArtifact` will accept any string for `bibtex`. The importer
must pass the **original entry text** (post `@string` resolution),
not call `buildFallbackBibtex()`. Reasons:

- Users have already curated citation keys, field ordering, and
  BibLaTeX-specific fields (`eprint`, `urldate`, `keywords`). Round-
  tripping through our minimal builder would silently lose them.
- The downstream paper-writing skill (`lib/skills/builtin/paper-writing/`)
  re-emits BibTeX into `references.bib` files; preserving the original
  means the user's `\cite{}` keys keep working.
- The cost is one extra parser call (most BibTeX libs expose the
  source range per entry).

## 8. The `pdfUrl` Field — Do **Not** Convert Local Paths

Zotero exports include a `file = {Title:files/12345/foo.pdf:mime}`
field. This is a Zotero-relative path to a local PDF, not a URL.

For this BibTeX-only importer, we **ignore** the `file` field
entirely. Reasons:

- A `file:///` URL embedded into the artifact would only resolve on
  the user's current machine, and breaks the moment the project is
  opened on a second device.
- Adding local-PDF copy-into-project logic blurs the line with the
  separate PDF-folder importer (a future slice). Keep that complexity
  contained there.
- The Paper Wiki fulltext pipeline will fetch the PDF from arXiv /
  Paperclip once the DOI or arxivId is present — preferred path.

If the user explicitly needs to use a Zotero export *with* its PDFs,
that becomes the responsibility of the Zotero importer slice, which
can copy files and then call this BibTeX mapping for metadata. **Not
this PR.**

## 9. Exact `upsertPaperArtifact` Call Shape

```ts
// lib/importers/bibtex.ts (sketch — illustrative, not final)

import { upsertPaperArtifact } from '../commands/paper-artifact.js'
import type { CLIContext } from '../types.js'

interface BibEntry {
  citeKey: string
  entryType: string                   // 'article' | 'inproceedings' | ...
  fields: Record<string, string>      // already LaTeX-decoded
  rawSource: string                   // verbatim entry text incl. @ and braces
}

interface BibImportProgress {
  citeKey: string
  status: 'parsed' | 'upserted' | 'deduped' | 'failed'
  error?: string
}

export interface BibImportResult {
  added: number
  deduped: number
  failed: number
  failureDetails: Array<{ citeKey: string; error: string }>
  importedPaperIds: string[]          // feed straight into enrichPaperArtifacts
}

export function importBibtexEntry(
  entry: BibEntry,
  ctx: CLIContext,
  onProgress?: (e: BibImportProgress) => void,
): { paperId: string; deduped: boolean } | { failed: true; error: string } {
  const title = entry.fields.title
  if (!title) {
    onProgress?.({ citeKey: entry.citeKey, status: 'failed', error: 'missing title' })
    return { failed: true, error: 'missing title' }
  }

  const authors = parseAuthorList(entry.fields.author)            // §5
  const year    = parseYear(entry.fields.year ?? entry.fields.date)
  const doi     = extractDoi(entry.fields.doi, entry.fields.url)  // §5
  const arxivId = extractArxivId(entry)                            // §5
  const venue   = pickVenue(entry)                                 // §5

  const confidence: 'high' | 'medium' | 'low' =
    doi ? 'high' : (arxivId ? 'medium' : 'low')

  const result = upsertPaperArtifact(
    title,
    {
      authors,
      year,
      venue,
      url: entry.fields.url,
      pdfUrl: undefined,        // §8 — never from `file` field
      abstract: entry.fields.abstract ?? '',
      citeKey: entry.citeKey,
      doi,
      arxivId,
      bibtex: entry.rawSource,  // §7 — verbatim
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
    onProgress?.({ citeKey: entry.citeKey, status: 'failed', error: result.error ?? 'upsert failed' })
    return { failed: true, error: result.error ?? 'upsert failed' }
  }

  // dedup detection: upsert doesn't tell us directly, but we can compare
  // createdAt vs updatedAt of the returned paper to know whether this
  // call created or merged. (See §10, Q4 — a tiny API tweak may be
  // cleaner.)
  const deduped =
    result.paper.createdAt !== result.paper.updatedAt &&
    new Date(result.paper.updatedAt).getTime() -
      new Date(result.paper.createdAt).getTime() > 1000

  onProgress?.({
    citeKey: entry.citeKey,
    status: deduped ? 'deduped' : 'upserted',
  })

  return { paperId: result.paper.id, deduped }
}

export async function importBibtexFile(
  bibPath: string,
  ctx: CLIContext,
  onProgress?: (e: BibImportProgress) => void,
): Promise<BibImportResult> {
  // 1. parse with @retorquere/bibtex-parser
  // 2. for each entry: importBibtexEntry(entry, ctx, onProgress)
  // 3. collect importedPaperIds — caller passes to enrichPaperArtifacts
  // 4. caller decides whether to also invoke Wiki rebuild (it shouldn't —
  //    the scanner picks them up automatically).
}
```

### What this code does **not** do

- ❌ No HTTP. Crossref / Semantic Scholar enrichment is invoked by the
  caller via the existing `enrichPaperArtifacts({ paperIds })` after
  the import finishes.
- ❌ No PDF I/O. PDF folder is a separate importer.
- ❌ No Wiki manipulation. The Paper Wiki scanner picks up the new
  paper artifacts on its next idle tick.
- ❌ No UI. The wizard is a separate slice.

## 10. Open Questions for Captain (Decisions Needed Before Coding)

**Q1 — Parser choice.**
Sign off on `@retorquere/bibtex-parser`, or do you want the implementer
to evaluate alternatives first? (Current weekly downloads + last
publish date + bundle size should be checked before install regardless.)

**Q2 — `identityConfidence` thresholds.**
Proposed: DOI → `'high'`, arxivId → `'medium'`, neither → `'low'`. Is
that enough, or do you want venue+year heuristics to lift `'low'` to
`'medium'`? I lean toward keeping it simple now and tightening later
once we see real failures.

**Q3 — Re-import behaviour.**
If a user re-imports the same `.bib` file (or an updated copy), the
dedup path will keep the original `externalSource` / `citeKey`. Is
that correct, or should re-import update those too? My read:
**keep original** — the dedup target may have been hand-edited.

**Q4 — Surfacing dedup outcome from `upsertPaperArtifact`.**
The current return type doesn't tell the caller whether dedup matched.
The sketch above infers it from `createdAt` vs `updatedAt`, which is
fragile. Should we add `wasDeduped: boolean` to `UpsertPaperResult`?
Cheap change; touches one type and one return statement.

**Q5 — What counts as a fatal parse error vs a per-entry skip?**
A `.bib` with one F10-style broken entry: do we
(a) abort the whole import, or
(b) skip the broken entry and import the rest with a failure list?
Strong recommendation: **(b)**, mirroring how `enrichPaperArtifacts`
collects `failureDetails` rather than throwing.

**Q6 — IPC channel name.**
For the next slice (the IPC handler) — proposed channel
`cmd:import-bibtex` for symmetry with `cmd:enrich-papers`. Same
progress event pattern (`import:progress`). Ack?

## 11. Out of Scope for This Note

- Zotero `.bib` export specifics (mostly identical, defer until needed)
- PDF folder importer (separate slice)
- Wizard UI / first-launch placement
- Research Memory Report surface — by prior decision (see chat 2026-05-11),
  the Paper Wiki *is* the report; no new document is generated
- Enrichment chaining (caller's responsibility)
- Telemetry / activity-store wiring
