# RFC-014: Artifacts as Workspace Files (Files-as-Carrier)

> Spec version: 0.5 (DRAFT) | Last updated: 2026-05-24
>
> v0.5: **smoke-tested on a real 25-paper project** → found + fixed paper round-trip data
> loss. Paper `.rp.yaml` sidecar is now the **lossless source of truth** (full record); the
> `.bib` is a derived, read-not-back LaTeX view with a sanitized entry key. Also: web-content
> is exempt from files-as-carrier (stays local JSON, not shared) (§4.3, §4.5).
>
> v0.4: **paper layout revised to ONE FILE PER PAPER** (`papers/<citeKey>.bib` +
> `papers/<citeKey>.rp.yaml`), superseding the v0.2 "per-actor `references.bib` library"
> pick — conflict-free, per-paper git history, mirrors the old one-JSON-per-paper layout;
> combined `references.bib` becomes an on-demand export (§4.3, §12 #1). Implemented + tested.
>
> v0.3: end-to-end **consumer audit** before implementation (§5.4). Confirms the
> "same `Artifact` objects → consumers unchanged" claim; **exactly one** breaking site (the
> mention resolver reads artifact JSON directly) + the index must carry body text for search.
> Blast radius = indexer + `store.ts` write path + one resolver redirect.
>
> v0.2: all eight §12 design decisions resolved — per-actor `references.bib` library,
> sidecar `.rp.yaml`, nested `rp:` front-matter, `rp.id`-marked notes only, type-dir
> defaults, agent-md as a normal note, citeKey+`rp_id` pairing, new sharded
> `.research-pilot/index/`.
>
> **Implementation status (2026-05-24): IMPLEMENTED** on branch
> `feat/artifact-files-as-carrier`. New modules: `lib/memory-v2/front-matter.ts`,
> `artifact-files.ts` (serialization + legacy reader), `indexer.ts`, `artifact-writer.ts`,
> `migrate-files.ts`, `workspace-gitignore.ts`. `store.ts` reads/writes/finds go through the
> index + file writer; `lib/mentions/resolver.ts` uses `resolveArtifactByKey`;
> `app/src/main/ipc.ts` runs migration + `rebuildIndex` on project open and on fs-watch
> changes. Tests: `__tests__/artifact-files.test.ts`, `indexer.test.ts`, `migrate-files.test.ts`
> (+ existing suite, 609 green). **Smoke-tested on a real 25-paper project copy → 0 data
> loss after the §4.3 sidecar-authoritative fix** (see §4.3). Impl deviations: (a) migration
> marker is a file `.research-pilot/.artifact-model` (not a `project.json` field); (b) the
> paper `.rp.yaml` sidecar is the **lossless source of truth** (full record); the `.bib` is a
> derived LaTeX view (sanitized key) and is never read back when a sidecar exists; (c)
> web-content is exempt from files-as-carrier (stays local JSON, §4.5).
> Deferred: combined-`references.bib` export (needs per-actor libraries from RFC-013 sharing).
>
> This is the standalone spec for what RFC-013
> (Shared Workspaces) calls **Phase 0.5** — a prerequisite refactor of the artifact
> subsystem. It is **orthogonal to** sharing (it makes the single-user app cleaner on its
> own) but **required before** sharing, because sharing assumes the workspace's real files
> are the source of truth (RFC-013 §3.1).

## 1. Overview

Today, most artifact content lives **only** inside `.research-pilot/artifacts/<type>/<uuid>.json`:
a `note`'s markdown and a `paper`'s BibTeX/abstract exist nowhere else (verified in code,
2026-05-24). The artifact JSON *is* the source of truth.

This RFC inverts that: **the workspace's real files become the single source of truth**
(note → `.md`, paper → `.bib` + sidecar, data → the data file, etc.), and
`.research-pilot/artifacts/` becomes a **local, derived index** — rebuilt by scanning the
workspace, gitignored, never shared.

### Design Axiom

```
Files are truth.  The index is a derived, disposable cache.
Anything in the index can be reconstructed by scanning workspace files.
```

### Why (the payoff)

- **Human-legible & tool-compatible**: notes are real Markdown, papers are real `.bib`
  (LaTeX/Zotero-usable), data is the data file. Open them in any editor.
- **Unblocks sharing cleanly** (RFC-013): notes/papers travel as ordinary files under the
  normal track-everything + per-actor-subdir rules; no special artifact sync, no per-actor
  artifact subdirs in `.research-pilot/`, no dangling `provenance.sessionId`.
- **Single source of truth**: no drift between "the file" and "the artifact".

### The blast-radius-limiting trick

The derived index reconstructs the **exact same `Artifact` objects** that `listArtifacts()`
returns today. So **all read consumers stay unchanged** (entity-store, `searchArtifacts`,
mentions resolver/candidates, the IPC handlers). Only the **build path** (a new indexer)
and the **write path** (`createArtifact`/`updateArtifact` now emit files) change.

---

## 2. Current State (verified 2026-05-24)

Citations into the live code, so the refactor targets are unambiguous.

### 2.1 Types — `lib/types.ts:72–181`
- `ArtifactType = 'note' | 'paper' | 'data' | 'web-content' | 'tool-output'`
- `ArtifactBase`: `id, type, title, tags[], summary?, contentRef?(unused), provenance, createdAt, updatedAt`
- `Provenance`: `source('user'|'agent'|'import'), sessionId, agentId?, extractedFrom?, messageId?`
- `NoteArtifact`: `+ content, filePath?`
- `PaperArtifact` (**31 fields**): `+ citeKey, bibtex, bibtexIsAutoGenerated?, doi, authors[], abstract, year?, venue?, url?, pdfUrl?, searchKeywords?[], externalSource?, relevanceScore?, citationCount?, enrichmentSource?, enrichedAt?, subTopic?, keyFindings?[], relevanceJustification?, addedInRound?, addedByTask?, fulltextPath?, identityConfidence?, arxivId?, pubmedId?, pmcId?, semanticScholarId?`
- `DataArtifact`: `+ filePath(required), mimeType?, schema?(DataSchema), runId?, runLabel?`
- `WebContentArtifact`: `+ url, content, fetchedAt?`
- `ToolOutputArtifact`: `+ toolName, outputPath?, outputText?`

### 2.2 Store — `lib/memory-v2/store.ts`
- `createArtifact()` (339–431): `id = crypto.randomUUID()`; writes `<dir>/<uuid>.json` flat; best-effort ledger row.
- `updateArtifact()` (471–490): read JSON → merge patch → write back → ledger.
- `deleteArtifact()` (492–499): delete JSON → ledger.
- `listArtifacts()` (433) / `findArtifactById()`: non-recursive `safeReaddir()`.
- `searchArtifacts()` (501–554): token-overlap over per-type text (see §5.3).
- `ensureAgentMd()` (264–287): special `agent-md` note auto-created at init — **special case**.

### 2.3 Identity & references
- IDs are **UUID v4**. **No cross-artifact reference fields exist** — mentions resolve at
  query time by `id` / `id`-prefix / (papers) `citeKey` / `title` substring
  (`lib/mentions/resolver.ts:60–102`).
- IDs are referenced outside the JSON in: the **ledger** (`artifacts/ledger.jsonl`, local),
  a **volatile** entity cache (`lib/mentions/entity-index.ts:24–34`, rebuilt on mutation),
  and **note content** as user/agent-authored `@type:key` strings.
- ⇒ **IDs must stay stable** across the refactor; everything else is derived.

### 2.4 Consumers (read) — must keep working
- Library: `app/src/renderer/stores/entity-store.ts:48–99` (`notes/papers/data`, by title/year/tags/id).
- Search: `searchArtifacts` (store.ts:501–554).
- Mentions: `lib/mentions/{resolver,candidates}.ts` — **resolver reads artifact JSON
  directly** (the one consumer to redirect, §5.4).
- IPC: `app/src/main/ipc.ts` — `entity:list-notes` (1405), `entity:list-literature` (1409),
  `entity:list-data` (1413), `entity:search` (1417), `entity:delete` (1421),
  `artifact:create` (1429), `artifact:update` (1437).
- Wiki agent reads PaperArtifacts (`fulltextPath`, metadata).

### 2.5 Writers (must also emit files) 
`createArtifact`/`updateArtifact`/`deleteArtifact` (store.ts); `upsertPaperArtifact`
(`lib/commands/paper-artifact.ts:124–373`, dedup fill-only + enrichment); `artifact-create`/
`-update` tools (`lib/tools/entity-tools.ts`); importers (`lib/importers/bibtex.ts`);
`literature-search.ts:627`; `metadata-enrichment.ts`; web-tools; data-analyze;
`createArtifactFromWorkspaceFile` (ipc.ts:354–388); `ensureAgentMd`.

### 2.6 No front-matter today
No `gray-matter`/YAML-front-matter parsing exists. BibTeX import uses
`@retorquere/bibtex-parser`; `PaperArtifact.bibtex` already holds a **reconstructed
standalone entry string**; there is **no artifact→.bib export** yet.

---

## 3. Design Principle

```
                 SCAN (recursive)                 read (unchanged API)
 workspace files ───────────────▶ derived index ───────────────▶ Library / search /
 (.md/.bib/.csv…)  indexer         (.research-pilot/    Artifact[]   mentions / IPC
        ▲                           index/, gitignored)
        │ write (create/update emit files + reindex)
   create/update/import
```

- **Files** carry content + identity (an `id` persisted in the file).
- **Index** is `Artifact[]` JSON of the *same shape as today*, rebuilt from files; local & gitignored.
- **Reads** go through the index → consumers unchanged.
- **Writes** emit/modify the real file(s), then update the index entry.

---

## 4. File Formats (per type)

### 4.1 Common conventions
- **Front-matter library**: introduce `gray-matter` (or equivalent) for YAML front-matter
  read/write on `.md` files.
- **Identity lives in the file.** Every artifact's `id` (the existing UUID) is persisted in
  the file (front-matter `id:` for `.md`; a non-standard `rp_id` field for `.bib`). This is
  what keeps ledger/mentions/cache stable and survives index rebuilds and sync.
- **Nested `rp:` block (decided §12 #3).** Top level holds **user-facing, hand-editable**
  keys (`title`, `tags`, `summary`); a nested **`rp:` block** holds machine fields (`id`,
  `type`, `provenance`, `actor`, `createdAt`, `updatedAt`). Grouping keeps the top level
  clean and never collides with a user's own front-matter keys.
- **Default locations (decided §12 #5): type-named dirs, per-actor when shared.** Solo:
  `notes/`, `papers/`, `tool-output/` at the workspace root. Shared: under
  `<displayName>/…` (e.g. `Alice Chen/notes/`). Data files keep their existing location.
  (web-content is exempt — stays in `.research-pilot/`, §4.5.)
  These are **defaults, not requirements** — the indexer finds artifacts by marker
  (front-matter `rp.id` / `.bib`+`rp_id`) **anywhere** in the workspace, so a user can move
  them freely.

### 4.2 note → `.md` with front-matter
```markdown
---
title: Threshold theorem intuition
tags: [surface-code, error-correction]
summary: Why d=3 tolerates one error
rp:
  id: 7f3a…-uuid
  type: note
  provenance: { source: agent, sessionId: …, agentId: coordinator, extractedFrom: agent-response }
  actor: { id: …, displayName: "Alice Chen" }   # present only in shared projects
  createdAt: 2026-05-24T…Z
  updatedAt: 2026-05-24T…Z
---

<the note markdown body = the old `content` field>
```
- A `.md` **with an `rp.id`** is a managed note. A plain `.md` without it is just a file
  (visible in the tree, not a Library note) — optionally "adopt-able" by adding front-matter.
- The special `agent-md` note (`ensureAgentMd`) becomes a **normal managed note** (a `.md`
  with `rp.id` like any other) at a stable path — no special-casing (decided §12 #6).
- `filePath?` (old "imported from") becomes moot — the note *is* the file.
- **Lossless (do NOT cherry-pick fields):** the body is `content` (note) / `outputText`
  (tool-output); the `rp:` block carries **every other field, including non-schema/unknown
  ones**. Serialize/parse are exact inverses. A 2nd smoke test (OS-CISC663) caught a
  tool-output carrying a non-schema `content` field (real data) that a cherry-picking
  serializer dropped — hence the full-record rule, mirroring the paper sidecar (§4.3).

### 4.3 paper → one `papers/<citeKey>.bib` + `papers/<citeKey>.rp.yaml` per paper
**Decided (§12, revised): one file per paper**, not a shared `references.bib` library.
Conflict-free by construction, per-paper git history + atomic delete, mirrors the old
one-JSON-per-paper layout. (Once shared, new papers land under `<displayName>/papers/…`;
the PI's pre-existing ones stay put — RFC-013 §5.1.)

**The `.rp.yaml` sidecar holds the COMPLETE paper record and is the lossless source of
truth; the `.bib` is a derived LaTeX/Zotero view.** This was changed after a smoke test on
a real 25-paper library: re-parsing the `.bib` to reconstruct fields lost data on real
inputs — a `§` in a citeKey broke the BibTeX entry-key and dropped the whole entry; curly
quotes/em-dashes in abstracts and URL-form arxiv ids didn't survive BibTeX escaping. YAML
round-trips any string faithfully, so we reconstruct from the sidecar and never re-parse the
`.bib` when a sidecar exists. The `.bib` stays valid + useful (its entry key is sanitized of
chars like `§`; authors use `{Name}` brace-literals), but it is regenerated, not read back.

`papers/chen2025surface.bib`:
```bibtex
@article{chen2025surface,
  title = {…}, author = {{Jane Q. Chen} and {Wei Zhang}}, year = {2025}, journal = {…},
  doi = {…}, url = {…}, abstract = {…}, eprint = {2501.00001}, archivePrefix = {arXiv},
  rp_id = {7f3a…-uuid}        % non-standard, ignored by LaTeX — durable identity anchor
}
```
`papers/chen2025surface.rp.yaml` (flat — one paper's app fields):
```yaml
id: 7f3a…-uuid
type: paper
tags: [...]
summary: ...
bibtex: "@article{chen2025surface, …}"   # curated original kept verbatim (when curated)
bibtexIsAutoGenerated: false
pdfUrl: ...
fulltextPath: ...
searchKeywords: [...]            # literature-study + scoring fields
externalSource: literature-search
relevanceScore: 0.82
citationCount: 41
enrichmentSource: crossref
enrichedAt: ...
subTopic: ...
keyFindings: [...]
relevanceJustification: ...
addedInRound: R-01
addedByTask: deep_literature_study
identityConfidence: high
pubmedId: ...
pmcId: PMC...
semanticScholarId: ...
provenance: { source: import, extractedFrom: file-import }
actor: { id: …, displayName: "Alice Chen" }   # shared projects only
createdAt: ...
updatedAt: ...
```

**Field placement:** the **`.rp.yaml` sidecar carries the full record** (all 31 fields incl.
title/authors/abstract/doi/citeKey + the app fields + a verbatim `bibtex` string). The
**`.bib`** carries the standard bibliographic subset for LaTeX (title, author, year,
journal/booktitle, doi, url, abstract, eprint) + the `rp_id` anchor — derived, not read back.

- Adding/updating a paper = write its two files; deleting = remove them. No shared-file
  read-modify-write → no append conflicts.
- **`.bib` content** (derived): a curated `bibtex` that parses cleanly is written verbatim
  (entry key sanitized + `rp_id` injected) so rich fields reach LaTeX; otherwise built from
  structured fields. Authors use `{Name}` brace-literals. The `.bib` is for humans/LaTeX; it
  is never the read-back source when a sidecar exists.
- **Read/identity**: when a `<citeKey>.bib` has a sibling `<citeKey>.rp.yaml`, the artifact
  is reconstructed **entirely from the sidecar** (lossless). A raw `.bib` with **no** sidecar
  is best-effort parsed (needs an `rp_id`) — for adopting hand-dropped bibliographies.
- A future **"export combined `references.bib`"** can concatenate all papers into one bib
  for LaTeX on demand (derived). Deferred (RFC-013 sharing era).

### 4.4 data → the data file + optional `.rp.yaml` sidecar
The data file (CSV/Excel/…) is already a workspace file (`filePath`). App metadata
(`id, tags, summary, schema, mimeType, runId, runLabel, provenance, actor, timestamps`)
goes to `<datafile>.rp.yaml`. `schema` can also be re-sniffed by the indexer if the
sidecar is absent.

### 4.5 web-content → EXEMPT: stays local JSON inside `.research-pilot/`
**Decided (RFC-013 §3.2): web-content is NOT shared and is exempt from files-as-carrier.**
It remains a plain JSON artifact at `.research-pilot/artifacts/web-content/<id>.json` (its
original location) — cache-like (scraped pages, re-fetchable), not in the Library UI, not
@-mentionable. The indexer reads it via the legacy-JSON scan; the migration leaves it
untouched. (The markdown serializer still *supports* web-content for safety, but the write
path stores JSON.)

### 4.6 tool-output → `.md`/`.txt` with front-matter (or referenced file)
`outputText` becomes the file body; `toolName, outputPath, id, provenance` in front-matter.
If the tool already produced a file (`outputPath`), the sidecar/front-matter references it.

---

## 5. The Derived Index

### 5.1 Shape & location
- A local cache reproducing today's `Artifact` objects exactly. Location (decided §12 #8):
  a **new `.research-pilot/index/`** dir (NOT reusing `artifacts/`, to avoid confusion with
  migration-period legacy JSON) — **gitignored**, **sharded** per-artifact (same JSON shape
  as today, so `listArtifacts` just changes which dir it reads + cheap incremental writes).
- **The index carries the body text, not just metadata** — note `content`, web-content
  `content`, tool-output `outputText`, paper `abstract` — because `searchArtifacts()` builds
  its corpus from these inline fields (audited §5.4). The indexer reads file bodies into the
  index on (re)build, so search stays in-memory with **no per-query file I/O**.
- It is **disposable**: deletable at any time; rebuilt by a scan.

### 5.2 Build & incremental update
- **Indexer** walks the workspace recursively (the fs watcher already uses
  `fs.watch(..., {recursive:true})`, `app/src/main/ipc.ts:startFsWatcher`), recognizing:
  `.md` w/ `rp.id` (note / tool-output), `<citeKey>.bib` + sidecar (paper), data sidecars.
  It also reads legacy JSON from `.research-pilot/artifacts/*` — including **web-content**,
  which lives there permanently (§4.5). Each is parsed into an `Artifact`.
- **Full rebuild** on project open / on demand; **incremental** on watcher events (debounced).
- **Identity**: from the file (`rp.id` / `rp_id`); never invented at index time, so it's stable.

### 5.3 Consumers unchanged
`listArtifacts()`, `findArtifactById()`, `searchArtifacts()` (its per-type text recipe,
store.ts:501–525), entity-store, mentions, and the 7 IPC handlers (§2.4) all keep their
current signatures and behavior — they just read the rebuilt index. **This is the main
reason the refactor is tractable.**

### 5.4 Consumer impact & blast radius (audited 2026-05-24)

An end-to-end audit of every artifact consumer confirms the claim, with **exactly one** site
to change:

- **WILL BREAK — the mention resolver** (`lib/mentions/resolver.ts:60–102`) is the *only*
  code that reads `.research-pilot/artifacts/<type>/*.json` **directly** (`readdirSync` +
  `readFileSync` + `JSON.parse`), bypassing the store API. Fix: route it through the
  store/index API (`findArtifactById` + the index). ~1 file, ~30 lines. (Verify the sibling
  autocomplete `lib/mentions/candidates.ts` during impl — expected to already use the store API.)
- **SAFE — everything else goes through the store API or doesn't read artifacts:** the IPC
  `artifact-get/-list/-search/-create/-update` handlers, the renderer (via IPC only, receives
  full `Artifact` objects incl. `content` — no separate body fetch), list commands
  (`lib/commands/list.ts`), search (`searchArtifacts`), paper enrichment
  (`listArtifacts`+`updateArtifact`), the ledger (append-only, no reads), and the **wiki**
  (its own markdown + `provenance.jsonl`, never reads artifact JSON).
- **No implicit creation**: artifacts are created only explicitly (the `artifact-create`
  tool / IPC / drag-drop / bibtex import). The auto-memory extractor writes to
  `.research-pilot/memory/`, **not** artifacts — a separate subsystem, untouched. No creation
  path depends on a synchronous inline-content return that the refactor would break.
- **Enrichment = shallow field merge** (`updateArtifact`, a few paper fields) → maps cleanly
  to front-matter/sidecar edits; no JSON-merge semantics that resist file edits.
- **Joins preserved**: `provenance.sessionId/messageId` + ledger `turnId/toolCallId` keep
  working because the index reproduces provenance verbatim.

Bottom line: **blast radius = the indexer + the write path in `store.ts` + the one resolver
redirect.** No change to the `Artifact` type, read APIs, renderer, search, or wiki.

---

## 6. Write Path Changes

Every write site (§2.5) now goes through a thin file-emitting layer:
- **`createArtifact`**: serialize to the real file(s) per §4 (writing `id` into the file),
  then upsert the index entry. (No more authoritative `<uuid>.json`.)
- **`updateArtifact`**: patch the file's front-matter/sidecar/body, re-derive the index entry.
- **`deleteArtifact`**: delete the file(s) (+ sidecar), drop the index entry.
- **`upsertPaperArtifact`** (dedup fill-only + enrichment): dedup now keys on the `.bib`/
  sidecar set (by doi/citeKey/title+year as today); fill-only merges write back into the
  `.bib`/sidecar. Preserve `bibtexIsAutoGenerated` gating.
- Importers / literature-search / enrichment / tools: unchanged at the call site (they call
  the same `artifactCreate`/`upsertPaperArtifact`), which now emit files.
- `ensureAgentMd`: emits the designated note file.
- Ledger writes stay (local, best-effort), keyed by the same stable `id`.

---

## 7. Identity & References (preserved)
- `id` persisted in every file → ledger rows, the volatile mention cache, and `@type:key`
  mentions in note content all keep resolving.
- `citeKey` = `.bib` entry key → `@paper:<citeKey>` mentions keep working.
- No cross-artifact id edges exist to migrate (§2.3), so there is no reference graph to rewrite.

---

## 8. Migration

- **One-time, idempotent migration** gated by a marker in `project.json`
  (e.g. `artifactModel: 2`). For each existing `.research-pilot/artifacts/<type>/<uuid>.json`:
  emit the corresponding file(s) per §4 **preserving the UUID** as `id`/`rp_id`, then build
  the index, then move legacy JSON to `.research-pilot/artifacts-legacy/` (kept until the
  user confirms — reversible).
- **Lazy fallback**: until migrated, the indexer can also ingest legacy `<uuid>.json` as a
  source, so old projects open without a forced migration step (migration can be opt-in /
  background). 
- **Edge cases**: `bibtexIsAutoGenerated` flag carried to sidecar; the `agent-md` special
  note mapped to its designated file; data sidecars created from existing `schema`.

---

## 9. Dependencies
- Add `gray-matter` (or equivalent) for front-matter.
- Reuse `@retorquere/bibtex-parser` for `.bib` read; add a **bib emitter** (today only
  `reconstructStandaloneBibtex` exists for import re-encode — generalize it for write).
- No new runtime services.

---

## 10. Backward Compatibility (hard constraint)
- **Unshared, unmigrated projects keep working** via the lazy-fallback indexer (§8).
- The `Artifact` type and all read APIs are **unchanged** (§5.3); the renderer needs no
  changes beyond possibly surfacing the new file locations in the tree.
- Migration is reversible (legacy JSON retained) until confirmed.

---

## 11. Phased Implementation (this is RFC-013 Phase 0.5)

| Step | Deliverable |
|---|---|
| **0.5a — Indexer + read parity** | Build the workspace→`Artifact[]` indexer; route `listArtifacts`/`search` through it; **redirect the mention resolver (the only direct-JSON reader, §5.4) to the store/index API**; ingest BOTH new files and legacy `<uuid>.json`. No behavior change yet. |
| **0.5b — Write emits files** | `createArtifact`/`updateArtifact`/`deleteArtifact` + `upsertPaperArtifact` emit `.md`/`.bib`/sidecar; index updates incrementally. New artifacts are files. |
| **0.5c — Migration** | One-time migrate legacy JSON → files (UUID-preserving), `artifactModel:2` marker, legacy archived. |
| **0.5d — Polish** | `gray-matter` integration, bib emitter, combined-`references.bib` export, agent-md mapping, watcher debounce/perf. |

Each step is shippable; 0.5a is pure refactor (no user-visible change), de-risking the rest.
Rough total: ~800–1500 LOC (RFC-013 §16).

---

## 12. Decisions (all resolved 2026-05-24)
1. ~~Paper layout~~ → **one file per paper** `papers/<citeKey>.bib` + `papers/<citeKey>.rp.yaml`
   (revised v0.4 from the earlier "per-actor library" pick). Conflict-free, per-paper git
   history, mirrors the old one-JSON-per-paper layout; combined `references.bib` = on-demand
   export (§4.3).
2. ~~App fields location~~ → **sidecar `.rp.yaml`** (keep `.bib` clean & LaTeX-usable; YAML
   handles arrays/nesting) (§4.3).
3. ~~Front-matter layout~~ → **nested `rp:` block**; top level = user-facing `title/tags/summary` (§4.1).
4. ~~What counts as a note~~ → **only `.md` with `rp.id`** is a managed note; plain `.md` are
   just files (with an "adopt" action) (§4.2).
5. ~~Default locations~~ → **type-named dirs, per-actor when shared**; defaults not
   requirements (indexer finds artifacts by marker anywhere) (§4.1).
6. ~~agent-md~~ → a **normal managed note** at a stable path, no special-casing (§4.2).
7. ~~Sidecar pairing~~ → **pair by citeKey, self-heal via `rp_id`** on rename (§4.3).
8. ~~Index location/format~~ → **new `.research-pilot/index/`, sharded** per-artifact JSON (§5.1).

Remaining items are implementation detail (exact stable path for agent-md, watcher debounce
tuning, sidecar YAML schema), not open design decisions.

---

## 13. Risks & Non-Goals
- **One file per paper = conflict-free for papers** (each `papers/<citeKey>.bib` is its own
  file; deletes are atomic). Trade-off: many small files under `papers/`, and LaTeX users
  wanting a single bibliography need the on-demand combined export (§4.3). Accepted.
- **Hand-edits drift**: a user editing a `.bib`/`.md`/sidecar by hand is fine (files are
  truth) but must re-index; the watcher handles it. Losing a sidecar block loses app-only
  metadata (not the bibliographic content) — mitigated by the `rp_id` anchor + re-derivable
  defaults.
- **Watcher performance** on large workspaces → debounce + incremental indexing.
- **Not** a change to the `Artifact` type or read APIs (deliberately stable).
- **Not** coupled to sharing — though it unblocks RFC-013.
