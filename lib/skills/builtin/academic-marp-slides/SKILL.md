---
name: academic-marp-slides
description: "Create or revise high-quality academic and research presentation slides in Markdown using Marp, following a story-first multi-phase workflow. Use when the user needs conference talk slides, lab or group meeting decks, thesis defense presentations, research seminars, invited talks, mixed-audience or industry research talks, OR wants to create, revise, or edit a talk deck or a specific slide of it (e.g. 'revise slide 7 of my conference talk'). Starts from an audience-facing story spine before slide titles, frameworks, screenshots, or feature lists; then applies Assertion-Evidence and Mayer multimedia principles. For teaching/lecture slides use `teaching-marp-slides`; for written documents use `paper-writing` or `scientific-writing`; for individual figures use `scientific-visualization`."
category: Presentation
tags: [Marp, Slides, Presentation, Conference Talk, Lab Meeting, Thesis Defense, Seminar, Research Talk, Assertion-Evidence, 做PPT, 学术幻灯片, 演示文稿, 学术报告]
triggers: [make slides, create presentation, conference talk, lab meeting slides, thesis defense, research presentation, seminar slides, marp, slide deck, revise slides, edit slides, improve slides, 做幻灯片, 做报告, 学术演讲, 修改幻灯片, PPT]
depends: [scientific-visualization, scientific-schematics]
license: MIT
metadata:
    skill-author: Dong Dai
    based-on: robonuggets/marp-slides, Alley Assertion-Evidence, Mayer multimedia learning principles
---

# Academic Research Presentation Slides with Marp

## Core Principle

**A talk is not a structured summary. It is a guided change in audience understanding.** Before slide titles, contribution lists, frameworks, screenshots, or feature inventories, design the path the audience must travel: what they believe now, what observation disrupts that belief, what diagnosis explains it, why it matters to them, what turn follows, what approach answers it, and what evidence proves it.

Apply the story-first workflow built into this skill before Phase 1 whenever the talk is short, public-facing, mixed-audience, industry-facing, demo-heavy, pitch-like, or when the user says the deck feels introductory, flat, report-like, product-like, lacking story, or lacking human connection.

**Slides are not documents.** They are visual aids for a spoken narrative. A good slide deck cannot be produced in one pass — it requires iteration through distinct phases, each with a different goal. This skill enforces a **phased workflow** that separates thinking (what to say) from structuring (what order) from visual design (how it looks). Skipping phases produces the flat, overstuffed, logically-loose decks that plague academic talks.

The two theoretical anchors:

1. **Assertion-Evidence structure** (Michael Alley): Every content slide must have a clear claim and visual evidence. In specialist research talks, this usually means the visible title is a complete-sentence assertion. In short, public, executive, industry, or mixed-audience talks, the visible title may be a keyword/chapter title, but the speaker notes must contain the hidden assertion the slide proves.
2. **Mayer's multimedia learning principles**: Images + spoken explanation beats on-screen text read aloud. Reduce redundancy, maximize signaling, keep related elements spatially close.

**Violating either of these is the most common reason academic slides fail.**

> **Note on Dry Run**: The user explicitly handles delivery rehearsal and validation themselves after receiving the draft. This skill therefore stops at a polished draft and does not prescribe dry-run steps. The user will test the deck and come back with revisions (Revise Mode).

---

## When to Use This Skill

- Conference talks, invited talks, workshop presentations
- Lab meetings, group meetings, research seminars
- Thesis defenses, qualifying exams
- Converting a paper/preprint into a talk
- **Revising** an existing Marp research slide deck

### When NOT to Use

| Need | Use Instead |
|------|-------------|
| Teaching / lecture / classroom slides | `teaching-marp-slides` |
| Written paper, report, grant | `paper-writing`, `scientific-writing`, or `research-grants` |
| One standalone figure | `scientific-visualization`, `matplotlib`, or `seaborn` |
| Diagram / schematic only | `scientific-schematics` |
| Poster (static large-format) | Ask user before proceeding — Marp can do it but dedicated poster tools are better |
| PPTX that user will keep editing in PowerPoint | Marp PPTX export loses styling; warn the user first |

---

## Phase 0: Mode Detection (Do This First, Every Time)

Before anything else, determine which mode applies:

### Signals for **Revise Mode**
- User attached or referenced an existing `.md` Marp file
- User says "change/fix/improve/update [existing slides]"
- User says "the deck I made…" / "slide 5 should…" / "this section is…"
- User pastes Marp Markdown and asks for edits

### Signals for **Create Mode**
- User describes a paper, research, or topic but has no existing deck
- User says "make slides for my talk on…" / "help me prepare a presentation"
- No Marp source file has been provided or created earlier in the conversation

If ambiguous, **ask**:
> "Are we starting a new deck from scratch, or revising an existing one? If existing, please share the .md source."

Then route to the appropriate mode below.

---

## Context Gate (Required Before Create Mode)

**Good slides do not start from scratch — they are rooted in existing context.** Before entering Phase 1, run the context sweep below and summarize what you found (and what you could not find) to the user. A one-paragraph summary up front saves a Phase 3 rewrite later.

The sweep has three tiers. **Do all of tier 1 always; do tier 2 whenever it is cheap and plausibly relevant; only do tier 3 if tier 1+2 left real gaps.** Report at each tier — do not silently skip.

### Tier 1 — Local context (always do, zero cost)

Four distinct local stores. Check each one — they don't overlap:

1. **Structured memory** — `.research-pilot/memory/` holds long-lived user facts (co-author names, venue preferences, recurring style choices, prior talk themes). Read `MEMORY.md` (the index) and open any memory files whose description looks relevant. These are persistent across sessions and override inferred defaults.
2. **Papers wiki (RFC-005)** — the user's curated literature knowledge base. Use it as follows:
   - `wiki_coverage` first if you don't know what's in it — returns the list of indexed topics/facets.
   - `wiki_search` with the user's topic / method / key terms.
   - `wiki_get` to pull a specific entry; `wiki_neighbors` to walk from a known entry to adjacent work; `wiki_source` to trace a claim back to the underlying paper.
   - If the wiki tools return "Wiki not available", the workspace has no wiki — skip this substep and move on.
3. **Artifacts (local literature + notes)** — call `artifact-search` scoped to `papers` and `notes` with the user's topic/method keywords. Hits here are the user's own saved papers, reading notes, and prior session outputs. Read the most relevant before asking the user anything.
4. **Workspace files and session history** — scan:
   - `.research-pilot/memory-v2/session-summaries/` for summaries of prior work on this topic
   - `.research-pilot/memory-v2/focus/` for the user's current focus entries
   - `.research-pilot/artifacts/tool-output/slides/` for any prior decks in this workspace (style reference)
   - Any paper drafts, reading PDFs, or data files the user dropped into the workspace root — use `grep`/`find` for likely filenames.

If any of these sources names a PDF/DOCX by path that is not yet an artifact, run `convert-document` on it first so its content becomes usable text.

### Tier 2 — User confirmation + light expansion (do when gaps remain)

**Ask the user once, in a batched message**, whether any of these additional inputs exist:
- **Paper, preprint, or manuscript draft** for the research being presented (if not already found)
- **Prior talk slides** from the same group (style, figure choices)
- **Conference/venue style guide** (some conferences have templates)
- **Target venue examples** (published keynotes from the same venue)

**Plus, do a quick literature scan** if the slides will have a related-work section and tier 1 returned little:
- Call the `literature-search` tool with the user's topic + method keywords, limited to ~5–10 hits. This is a *context-building* pass, not an exhaustive survey — pull titles, venues, and abstracts to understand where the work sits.
- If `wiki_coverage` in tier 1 showed the wiki is well-populated on this topic, skip this step — the wiki already covers it.

### Tier 3 — Online fallback (do only if needed for a specific gap)

Use these only when a tier 1+2 gap is *load-bearing* for the deck (e.g., the user named a venue you've never heard of, or a result claim needs a citation nobody has):
- `web_search` for venue style guides, conference CFPs, keynote examples, or recent news tied to the claim.
- `web_fetch` on a specific URL the user mentioned or the search returned.

Do not use tier 3 for general background — that belongs in `literature-search` or the wiki.

### After the sweep — report and decide

Write one short paragraph to the user:
- **What I found:** [memory hits / wiki hits / artifact hits / workspace files / literature-search hits / web snippets]
- **What I still need:** [specific gaps that would change the deck — e.g., "no prior slides from your group, so I'll guess at visual style unless you share one"]
- **Proposed action:** either (a) proceed to Phase 1 now, or (b) pause while the user supplies one or two missing pieces

If the sweep turns up nothing substantive and the user has nothing more to share, proceed — but flag it explicitly:
> "No source material found locally or via a quick literature scan — I'll generate from scratch. Output will be generic and may need heavier revision. Consider sharing a paper draft, notes artifact, or a reference talk if possible."

This flag tells the user what quality to expect and invites them to supply material before committing.

## Working Posture (Applies to All Phases)

Work like a junior presenter briefing a senior advisor — not like a machine executing a template.

- **Surface assumptions before acting.** If you're inferring something the user didn't say (e.g., "I assume this is for specialists in your exact subfield"), state it.
- **Name decisions and their rationale.** When choosing a narrative structure or an evidence type, say why you picked it and what else you considered.
- **Flag unknowns.** If a slide needs a figure you don't have, mark it with a clear placeholder and a question to the user.
- **Less is more.** Do not add filler content. Every slide, bullet, and figure must earn its place. If a slide feels empty, that's a composition problem to solve by re-layout — not by inventing content.

These apply at every STOP AND CONFIRM gate.

---

# CREATE MODE

Four phases. Each has a stop-and-confirm gate with the user. **Do not skip gates. Do not proceed to the next phase without explicit user approval — even if the answer seems obvious.**

```
Phase 1: Storyline   ──►  Outline on paper, no PPT    (25% of total time)
Phase 2: Skeleton    ──►  Empty slide sequence         (15%)
Phase 3: Content     ──►  Fill in figures + text       (40%)
Phase 4: Polish      ──►  Visual refinement            (20%)
```

## Phase 1: Storyline

**Goal**: Decide what story to tell before touching any slide software.

**Tools allowed**: Prose story spines, slide spines, and evidence promises. **Do not create a `.md` file yet.**

### Step 1.1 — Consolidated intake (ask everything up front, in one batch)

Rather than asking questions one at a time and ping-ponging, ask for everything needed in a single structured request. If the user has already answered some of these in earlier messages or if the Context Gate surfaced them from artifacts, fill those in and only ask the remainder.

**Required before moving on:**

1. **Audience** — peers in subfield / adjacent field / broad scientific / funders / mixed
2. **Talk length** — lightning 5 min / short 10–12 min / standard 15–25 min / invited 45–60 min / defense 45–60 min
3. **Venue** — conference hall / seminar room / lab meeting / online — affects theme choice
4. **Opening material** — a real observation, case, failure, surprise, demo, or lived workflow that can open the talk. If the user only gives a broad "gap," help extract a concrete scene from the source material.
5. **Audience stakes** — why this audience should care before the solution appears
6. **Evidence available** — demo, data, results, screenshots, artifacts, figures, or examples that prove the story is real
7. **Context material available** — paper draft, prior slides, reference talks (tie to Context Gate above)
8. **Hard constraints** — mandatory slides (affiliation logos, funding acknowledgments), required sections (disclosures, conflicts)

Batch these as one message. Do not begin drafting slide titles until the user has answered the required items (1, 2, 4, 5) at minimum, or the Context Gate surfaced enough evidence to infer them and you state the assumptions.

### Step 1.2 — Draft the story spine before slide titles

Before writing any assertion list, framework, section list, or Marp skeleton, write a prose story spine using the contract below.

Required fields:

1. **Audience belief** — what the audience likely assumes now
2. **Opening observation** — the concrete case, failure, surprise, or lived workflow that starts the talk
3. **Diagnosis** — what is actually going wrong beneath the surface
4. **Stakes** — why this audience should care now
5. **Turn** — what must change once the diagnosis is accepted
6. **Approach** — the method, system, framework, or design that follows naturally
7. **Evidence** — the result, demo, artifact, data, screenshot, or example that proves it
8. **Invitation/takeaway** — what the audience should remember, discuss, or reconsider

If the story spine starts with a framework, contribution list, or feature list, stop and rewrite it. The audience must feel the problem before the framework appears.

### Step 1.3 — Propose 2–3 narrative structure options (let the user pick)

Do not pick a single narrative unilaterally. Identify the 2–3 structures that plausibly fit the research, describe the trade-off, and let the user choose. This prevents committing to the wrong arc before the user has had a chance to weigh in.

Candidate structures:

| Structure | Best when… | Risk |
|-----------|-----------|------|
| **Observation -> Diagnosis -> Design** | Audience needs to recognize a real phenomenon before hearing the solution | Requires a sharp opening observation |
| **Case -> Generalization -> Framework** | A concrete demo, user story, or workflow can reveal a broader principle | The case can feel narrow unless generalized clearly |
| **Failure -> Constraint -> Solution** | Existing tools look impressive but fail in real deployment | Can sound negative if not balanced |
| **Before -> Breakdown -> After** | Audience already knows the old workflow and needs to see what changes | Needs a clear before/after artifact |
| **Question -> Investigation -> Answer** | Talk follows a research puzzle or intellectual journey | Can meander if the answer is weak |
| **Problem -> Method -> Result** | Specialist research audiences expect compressed paper logic | Often feels generic for short, public, or industry talks |
| **Reversal** | Finding contradicts common belief or prior work | Requires a genuinely surprising result |
| **Comparison** | Benchmarks, head-to-head systems studies, framework papers | Audience may lose interest in the losers |

Present the 2–3 most plausible candidates to the user with a one-line trade-off for each, then wait for their pick.

### Step 1.4 — Choose title style

Do not always force visible assertion titles.

Use **assertion titles** when:

- Audience is technical or specialist
- Talk is research-result heavy
- Each slide presents evidence for a claim

Use **keyword/chapter titles** when:

- Talk is short, public-facing, executive, industry, outreach, pitch-like, or panel-adjacent
- The spoken narrative carries the claim
- Slides serve as anchors, not documents

In keyword-title mode, every content slide still needs a hidden speaker-note assertion:

```markdown
# The Gap

<!-- Speaker assertion: The gap is no longer model access; it is whether AI can operate inside accountable workflows. -->
```

### Step 1.5 — Draft the slide spine

Derive the slide sequence from the story spine. Each content slide must include:

1. **Story beat** — where this slide sits in the audience's cognitive path
2. **Surface title** — assertion title or keyword/chapter title, depending on title style
3. **Hidden assertion** — required for keyword-title mode; optional if the visible title is already a complete assertion
4. **Evidence promise** — what visual/demo/data/screenshot will prove this beat

The audience should be able to follow the talk as a story, not as a table of contents. Technical elements must appear as answers to established obstacles, not as an up-front taxonomy.

### Step 1.6 — ★ STOP AND CONFIRM ★

Present to the user before writing any Markdown. Structure the handoff like a junior-to-advisor briefing:

**Proposal:**
1. The story spine (audience belief, observation, diagnosis, stakes, turn, approach, evidence, invitation)
2. The chosen narrative structure (one of the candidates the user picked)
3. Title style (assertion or keyword/chapter) and why
4. The ordered slide spine: story beat, surface title, hidden assertion if needed, evidence promise
5. Target slide count and time budget

**Assumptions I made (tell me if any are wrong):**
- [List any inferences — audience expertise level, what to omit, what to emphasize]

**Open questions:**
- [List anything still undecided — e.g., "unclear whether the negative result should be its own section or a subsection"]

**Do not proceed to Phase 2 without explicit approval.** Fixing a broken storyline here costs minutes; fixing it in Phase 3 costs hours.

**Persist the approved storyline.** After approval, call `artifact-create` with `type='note'` and a title like `Slides storyline — <talk title>`, storing the story spine, narrative choice, title style, slide spine, and evidence promises. This gives the user a resumable checkpoint and makes the plan searchable in future sessions.

### Phase 1 Checklist

- [ ] Context Gate completed (workspace searched; source material confirmed or absence flagged)
- [ ] Consolidated intake completed (audience, length, venue, opening observation, stakes, evidence, context material, constraints)
- [ ] Story spine completed before slide titles
- [ ] Opening observation is concrete, not just "there is a gap"
- [ ] 2–3 narrative candidates were presented; user picked one
- [ ] Title style chosen deliberately
- [ ] Every planned slide has a story beat and evidence promise
- [ ] Keyword-title slides include hidden speaker-note assertions
- [ ] STOP gate briefing surfaced assumptions and open questions
- [ ] User has approved the storyline
- [ ] Approved storyline persisted as a note artifact

---

## Phase 2: Skeleton

**Goal**: Translate the approved slide spine into a Marp file where every slide exists but contains no visual content yet.

**Tools allowed**: Create the `.md` file with minimum front matter. Use the default theme. **No images, no CSS tuning, no colors.**

### Step 2.1 — Decide output location

Write the Marp source to `<workspace>/.research-pilot/artifacts/tool-output/slides/<slug>.md` (create the `slides/` subfolder if it does not exist). Using the project artifact tree means the deck lives alongside other session outputs and can be discovered later with `artifact-search`.

If the user has specified a different path, honor it — but mention this convention so they know where future decks will land by default.

### Step 2.2 — Minimum front matter

```markdown
---
marp: true
theme: default
paginate: true
math: mathjax
---
```

### Step 2.3 — One slide per story beat

For each approved story beat from Phase 1:

```markdown
---

# [Surface title from Phase 1]

> PLACEHOLDER: [one sentence describing the evidence promised for this story beat]

<!-- Speaker assertion: [hidden assertion if the visible title is a keyword/chapter title] -->
<!-- Speaker notes: key points to say aloud -->
```

### Step 2.4 — Add structural slides

- **Title slide** (1) — use `<!-- _class: lead -->` and `<!-- _paginate: false -->`
- **Outline slide** (1) — only if talk >20 min
- **Section dividers** (1 per major section) — `<!-- _class: lead -->`
- **Thank you / questions slide** (1)
- **Backup slides** (2–5) clearly marked for anticipated Q&A

### Step 2.5 — Check timing arithmetic

Standard pacing: **~1 minute per content slide**.

| Talk length | Content slides | Total incl. dividers |
|-------------|----------------|----------------------|
| 5 min | 5–7 | 6–8 |
| 10–12 min | 8–12 | 10–14 |
| 15–20 min | 13–18 | 16–22 |
| 25 min | 18–22 | 22–27 |
| 45–60 min (defense) | 30–45 | 40–55 |

If skeleton is 30% over or under target, fix it now.

### Step 2.6 — ★ STOP AND CONFIRM ★

Show the user the skeleton (titles + placeholders only). Ask:

- Does the logical flow from story beat to story beat still work when read in order?
- Is any slide doing too much or too little?
- Are there missing transitions?

Wait for approval before Phase 3.

### Phase 2 Checklist

- [ ] Skeleton file written under `.research-pilot/artifacts/tool-output/slides/` (or user-specified path)
- [ ] Every story beat has a slide
- [ ] Every slide has a placeholder describing what visual evidence goes there
- [ ] Keyword-title slides include hidden speaker assertions
- [ ] Slide count matches target time budget
- [ ] Section dividers, title, thank-you slides in place
- [ ] User has approved the skeleton

---

## Phase 3: Content

**Goal**: Replace every placeholder with actual visual evidence (figures, tables, equations) and concise supporting text.

**Tools allowed**: Embed figures, write text, build simple tables. **No theme/color polishing yet.**

### Step 3.1 — For each slide, decide evidence type

| Assertion claims… | Best evidence form |
|-------------------|-------------------|
| Quantitative comparison | Bar/line chart or table with bold winners |
| Structural/spatial concept | Schematic diagram or annotated figure |
| Procedural idea | Flowchart or numbered steps |
| Theoretical result | Equation with labeled terms |
| Qualitative contrast | Two-column before/after layout |
| Discovery / example | Representative image + caption |

### Step 3.2 — Evidence must serve the story

A screenshot, chart, or demo is not automatically evidence. Before placing any visual, write the story contract for it:

1. **Obstacle answered** — what problem or tension already established in the story does this visual answer?
2. **Speaker pointing target** — what should the speaker point at or narrate?
3. **Ten-second memory** — what should the audience remember after a quick glance?

Bad:

- Screenshot shows the model picker.
- Screenshot shows the audit graph.

Good:

- This screenshot proves model choice is made per task, because different workflow steps cross different data boundaries.
- This audit graph proves the answer can be reviewed after the fact, rather than trusted as a black box.

If a visual only proves "we have this feature," reframe it as story evidence or cut it.

### Step 3.3 — Source figures by priority (use project skills/tools)

1. **Existing publication figures** from the paper draft or prior slides — but simplify: remove panels, enlarge fonts, trim legends. Publication figures are too dense for slides.
2. **Fresh publication-quality figures** — delegate to project skills:
   - For journal-style multi-panel plots → `load_skill('scientific-visualization')`
   - For low-level custom plots → `load_skill('matplotlib')` or `load_skill('seaborn')`
   - Export to `<workspace>/.research-pilot/artifacts/tool-output/slides/figures/` and embed with a relative path.
3. **Fresh data-driven numbers or charts** — if a claim needs a computation or re-plot the user doesn't have yet, call the `data-analyze` tool first; persist its output, then embed it.
4. **Schematics and concept diagrams** — call the `generate_diagram` tool (load `scientific-schematics` first for type-specific prompt guidance). Output format: PNG for final embed (recommended for slides — fixed, predictable visual), or `format: "svg"` when the author wants to hand-tweak labels / colors afterwards (writes a `.png` anchor sibling for diffing). Best quality requires `OPENAI_API_KEY`; without the key, SVG falls back to a chat-model-only path with reduced quality, or hand-write inline SVG using the Component Library below.
5. **Related-work / citation slides** — use the `literature-search` tool to gather references with proper metadata; pull BibTeX/DOIs into speaker notes or a References backup slide.
6. **Inline SVG / HTML components** — for metric cards, simple bar charts, timelines (see Component Library below).

### Step 3.4 — Follow one-idea-per-slide limits

Marp **silently clips** overflowing content. These are survival rules:

- Max 6 bullet points (prefer 3–4)
- Max 1 primary figure + ≤3 lines of supporting text
- Max 1 table with ≤5 rows and ≤5 columns
- Max 1 code block of ≤12 lines
- Body text never below 0.7em

If a slide violates these, **split it**. Never shrink text to fit.

### Step 3.5 — Less is more (reject filler content)

Every slide, bullet, figure, and icon must earn its place. Actively reject these filler patterns:

- **Stat slop** — numbers or metrics included because "slides need data," not because they support the assertion
- **Decorative icons** — small icons next to every bullet point that add no semantic meaning
- **Padding bullets** — expanding 3 real points into 5 to "fill the slide"
- **Restated titles** — a bullet that just rewrites the title in worse prose
- **Generic agenda slides** — "Outline: Intro → Method → Results → Conclusion" on a 15-min talk wastes 90 seconds

If a slide feels empty, fix it by **re-composing the layout** (larger figure, better whitespace, two-column split), never by inventing content. One thousand no's for every yes.

### Step 3.6 — Apply Mayer non-redundancy

Whatever you will say aloud must **NOT** also appear as on-screen text. On-screen text should only be:

- Key numerical values and labels
- Proper nouns and technical terms the audience might miss aurally
- The single-sentence takeaway reinforcing the title

Write spoken narration in speaker notes (HTML comments), not on the slide surface.

### Step 3.7 — Write the takeaway line

Every content slide needs a visible one-line takeaway that reinforces the slide claim:

```markdown
# LEGO-xtal generates 1,741 new sp² allotropes from 25 starting structures

![w:700](./figures/energy_distribution.png)

**A ~70× expansion of the known low-energy sp² carbon space** using only symmetry augmentation and descriptor-guided pre-relaxation.
```

### Step 3.8 — ★ STOP AND CONFIRM ★

Render the deck locally and show the user. Like Phase 1, include assumptions and open questions alongside the draft:

**Deliverable:**
- Rendered Marp deck with figures and text filled in (HTML preview at minimum)

**Assumptions I made:**
- [e.g., "I picked the left panel of Figure 3 because it shows the main result most cleanly; flag if you'd prefer the combined panel."]

**Open questions:**
- [e.g., "Slide 7 needs a schematic I don't have — should I draw a placeholder or wait for you to provide one?"]

Ask the user to:

- Flip through and confirm each slide delivers on its story beat and slide claim
- Flag any slide that feels too dense, too empty, or illogical
- Note any figure that needs to be replaced or redrawn

Wait for approval before Phase 4.

### Phase 3 Checklist

- [ ] Every slide has primary visual evidence
- [ ] Every visual answers a specific obstacle in the story
- [ ] No slide violates the one-idea limits
- [ ] No slide has more than ~30 English words (or ~50 CJK characters) of on-screen prose
- [ ] Every slide has a takeaway line
- [ ] Speaker notes exist for at least every results slide
- [ ] All embedded figures resolve (no broken links)
- [ ] User has reviewed the filled-in deck

---

## Phase 4: Polish

**Goal**: Apply consistent visual styling. **No content changes at this stage.** If content still needs changes, return to Phase 3.

### Step 4.1 — Choose and apply a theme

| Venue | Theme |
|-------|-------|
| Conference auditorium, invited talk | **Dark theme** |
| Lab meeting, classroom, well-lit room | **Light theme** |
| Print handouts needed | **Light theme** |
| Premium / keynote feel | **Dark theme** with single strong accent |

Paste the full CSS block from the Theme System section. **Do not invent a new theme unless specifically requested** — the provided themes are tuned for legibility.

### Step 4.2 — Enforce consistency

- **Font consistency** — one heading font, one body font, one monospace
- **Color consistency** — main + one accent. Semantic colors used the same way throughout.
- **Figure styling** — axis font size, line weight, legend placement consistent across charts
- **Spatial consistency** — titles, footers, pagination in same position everywhere

### Step 4.3 — Readability checks

- **Far-row test**: Zoom to 25%, squint. Anything unreadable is too small.
- **Print test**: Export PDF, view greyscale. Color-only distinctions should still work (add shape/bold).
- **Colorblind test**: Avoid red-green as sole distinguisher.
- **Projector test**: Body text at least `#666` on light or `#94a3b8` on dark.

### Step 4.4 — Add speaker notes and metadata

```markdown
<!-- Speaker note: Emphasize the 70× expansion. Pause after the number. Backup slide 3 has phonon validation if asked. -->
```

### Step 4.5 — Export

```bash
# HTML (best fidelity, use on presentation laptop)
npx @marp-team/marp-cli slides.md --html --allow-local-files

# PDF (backup + sharing) — ALWAYS export this too
npx @marp-team/marp-cli slides.md --pdf --allow-local-files

# PPTX (only if user will edit further in PowerPoint)
npx @marp-team/marp-cli slides.md --pptx --allow-local-files
```

**Always export HTML + PDF.** Projector failures are common; PDF is the universal fallback.

### Step 4.6 — Persist the final deliverable

Call `artifact-create` with `type='tool-output'`, title `Slides — <talk title>`, and the final Markdown content. Record the exported HTML/PDF paths in the artifact body so the user can find them later via `artifact-search`.

### Phase 4 Checklist

- [ ] Theme CSS applied consistently
- [ ] Fonts, colors, spacing consistent across all slides
- [ ] Far-row and print tests pass
- [ ] Speaker notes present for key slides
- [ ] HTML + PDF both exported
- [ ] Final deck persisted as a tool-output artifact
- [ ] User has the final deliverables

---

# REVISE MODE

**Goal**: Improve an existing deck without disturbing the user's intentional choices.

**Guiding principle — Respect the user's work.** The user has already made hundreds of decisions. Change only what's requested or clearly broken. Do not rewrite to match Claude's style preferences.

## Change-Size Classification

Classify the request before editing:

| Level | Meaning | Examples |
|-------|---------|----------|
| **L1 — Surface** | Typos, colors, rewordings, image resizing | "fix typos", "make accent green", "this figure too small" |
| **L2 — Local** | Rework one slide, swap a figure, tighten bullets | "rewrite slide 7", "replace figure on slide 12" |
| **L3 — Structural** | Reorder sections, add/remove slides, change narrative or story spine | "cut 5 min from the talk", "motivation should come after results", "this feels like an introduction, not a story" |
| **Vague** | "feels off", "middle is boring", "too dense" | Diagnose first, propose a plan |

Report which level you think applies before editing if it's anything beyond L1.

## Story Diagnosis Checklist

Use this before any visual, title, screenshot, or wording edits when the user says the deck feels:

- introductory
- flat
- too much like a report
- too much like a product pitch
- lacking story
- lacking human connection
- not compelling
- hard for the audience to care about

Check:

1. Does the deck open with a concrete observed phenomenon, case, failure, or tension?
2. Does the audience have a reason to care before the solution appears?
3. Is the framework introduced as an answer to a problem, or as a taxonomy?
4. Are screenshots/data used as evidence in a story, or as feature demonstrations?
5. Is there a human actor in the narrative: researcher, user, student, customer, reviewer, or operator?
6. Does each technical element answer a previously established obstacle?
7. Can the talk be summarized as "we noticed X, realized Y, therefore built/tested Z"?
8. If the method/system name were removed, would the story still be interesting?

If two or more fail, classify the request as **L3 structural**. Do not polish the existing deck first. Propose a new story spine and revised slide spine, then wait for user confirmation before editing.

## Quick Diagnosis Checklist

When the user reports a problem but doesn't pinpoint it, run through this in order. Report findings before making edits.

**Structural level**
- [ ] Story spine is visible: audience belief -> observation -> diagnosis -> stakes -> turn -> approach -> evidence -> invitation?
- [ ] Reading titles/story beats alone tells a coherent story?
- [ ] Slide count matches stated talk length (±20%)?
- [ ] Each section has a divider?
- [ ] Results slides outnumber background slides?

**Per-slide level (scan each content slide)**
- [ ] Title is an assertion, or keyword-title mode has a hidden speaker assertion?
- [ ] Main visual evidence present and supports the title?
- [ ] Visual evidence answers a specific story obstacle instead of merely showing a feature?
- [ ] Body text ≤30 English words (or ~50 CJK chars)?
- [ ] Takeaway line present?
- [ ] Not violating one-idea-per-slide limits (≤6 bullets, ≤1 primary figure)?

**Visual level**
- [ ] Fonts consistent throughout?
- [ ] One accent color used consistently?
- [ ] No content clipped at slide edges?
- [ ] Figures legible (axis labels readable)?

Flag any failing items. Let the user pick which to fix.

## Revise Mode Workflow

1. **Load and read** the existing `.md` file completely.
2. **Classify the request** (L1 / L2 / L3 / vague).
3. **If the user reports a story/compellingness problem**: run Story Diagnosis first; if two or more fail, propose a new story spine and wait for confirmation.
4. **If L3 or vague**: run diagnosis, propose a plan, wait for user confirmation.
5. **If L1 or L2 with specific targets**: execute directly.
6. **Use targeted edits** — not full-file rewrites. Full rewrites are a red flag unless the approved diagnosis is L3 structural story repair.
7. **Report changes** as a compact, 1-indexed diff summary (e.g., "Slide 5: replaced figure; Slide 8: split into 8a + 8b").
8. **Do not polish unrelated slides** unless the user asked for a consistency pass.

## Common Revise Requests and How to Handle

| Request | Classification | Action |
|---------|---------------|--------|
| "Fix typos" | L1 | Scan all, fix, report count |
| "Change the accent color to green" | L1 | Update theme CSS only |
| "This figure is too small" | L2 | Adjust `w:` value, offer to simplify figure |
| "Rewrite slide 7's bullets" | L2 | Rewrite only slide 7, preserve style |
| "The middle feels too dense" | L2 vague | Diagnose first: flag overloaded slides, propose splits |
| "This feels like an intro, not a story" | L3 structural | Run Story Diagnosis, propose new story spine before editing |
| "The screenshots feel like feature demos" | L3 structural | Re-map screenshots to story obstacles; confirm revised slide spine |
| "Add a slide about X" | L3 | Ask where it goes, what evidence it needs, confirm title |
| "Cut 5 minutes from the talk" | L3 | Identify cuttable slides, confirm before removing |
| "Reorganize so method comes before motivation" | L3 | Confirm the user really wants this (non-standard arc), then reorder |

---

# Reference Material (Shared by Both Modes)

## Marp Syntax Essentials

### Front matter

```markdown
---
marp: true
theme: default
paginate: true
math: mathjax
size: 16:9
style: |
  /* CSS block — paste from Theme System below */
---
```

### Per-slide directives

```markdown
<!-- _class: lead -->            # centered, title-like layout (this slide only)
<!-- _paginate: false -->        # hide page number (this slide only)
<!-- _backgroundColor: #000 -->  # override background (this slide only)
<!-- backgroundColor: #1a1a2e --> # set for this slide AND subsequent
<!-- header: "Section 2" -->     # persistent header
<!-- footer: "Conf 2026" -->     # persistent footer
```

### Images

```markdown
![w:400](figure.png)              # fixed width
![h:300](figure.png)              # fixed height
![bg](image.jpg)                  # full background
![bg right:40%](image.jpg)        # split layout, image right 40%
![bg left:35%](image.jpg)         # split layout, image left 35%
![bg contain](image.jpg)          # fit without cropping
![bg brightness:0.3](image.jpg)   # darkened
```

### Math

```markdown
Inline: $E = mc^2$

Block:
$$
\mathcal{L} = \sum_i \ell(f(x_i), y_i) + \lambda \|w\|^2
$$
```

**Critical pitfall — math inside HTML containers**: Marp's MathJax/KaTeX plugin is a markdown-it tokenizer plugin. It can only render math that markdown-it actually tokenizes. Per CommonMark, content inside a **single-line** HTML block tag is treated as literal text and never re-parsed as Markdown, so the `$...$` never reaches the math plugin and prints as raw dollar signs in the PDF.

This fails silently — there is no warning, just literal `$` characters in the output. When you use layout components from the Inline Component Library (`<div class="cols">`, `<div class="card">`, two- / three-column grids, metric cards), you MUST use one of these patterns:

```html
<!-- ❌ BROKEN: math on same line as the <div> tag — will NOT render -->
<div class="card"><strong>$\max_\ell(\tau - t_\ell) \le S_{\max}$</strong></div>

<!-- ✅ FIX A: blank lines inside <div> force markdown-it to re-parse -->
<div class="card">

**$\max_\ell(\tau - t_\ell) \le S_{\max}$**

</div>

<!-- ✅ FIX B: put block math outside the container; keep only non-math content in the grid -->
<div class="card">
<div class="label">Invariant</div>
</div>

$$\max_\ell(\tau - t_\ell) \le S_{\max}$$
```

Rule: **whenever a slide has both a `<div>`-based layout and LaTeX math, write the math on its own line with a blank line separating it from the surrounding HTML tags.** Or write the whole slide in pure Markdown without grid containers — inline `$...$` and block `$$...$$` always render correctly in plain Markdown context.

Short exponents like `K=10⁻³` can be written with Unicode superscripts as a last resort in tight layouts, but lose LaTeX fidelity — only acceptable for trivial cases.

## Theme System

### Dark Theme (Conference / Invited Talks)

```yaml
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400&display=swap');
  :root {
    --accent: #60a5fa;
    --dark: #0f172a;
    --card: #1e293b;
    --border: #334155;
    --body: #94a3b8;
    --label: #64748b;
    --muted: #475569;
    --light: #f1f5f9;
    --green: #4ade80;
    --red: #f87171;
    --yellow: #fbbf24;
  }
  section {
    background: var(--dark);
    color: var(--light);
    font-family: 'Inter', sans-serif;
    font-weight: 300;
    padding: 48px 64px;
  }
  section.lead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    text-align: center;
  }
  h1 { font-weight: 700; font-size: 2.2em; color: var(--light); margin-bottom: 0.3em; line-height: 1.2; }
  h2 { font-weight: 300; font-size: 1.3em; color: var(--body); margin-top: 0; }
  h3 { font-weight: 600; font-size: 0.75em; color: var(--label); text-transform: uppercase; letter-spacing: 0.1em; }
  p, li { color: var(--body); line-height: 1.6; font-size: 1em; }
  strong { color: var(--light); font-weight: 600; }
  em { color: var(--accent); font-style: normal; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: var(--card); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { color: var(--label); font-weight: 600; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  td { color: var(--body); border-bottom: 1px solid var(--border); padding: 8px 12px; }
  a { color: var(--accent); text-decoration: none; }
  blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--muted); font-style: italic; }
  footer { color: var(--muted); font-size: 0.6em; }
```

### Light Theme (Lab Meetings / Classrooms / Print)

```yaml
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400&display=swap');
  :root {
    --accent: #2563eb;
    --dark: #f8fafc;
    --card: #ffffff;
    --border: #e2e8f0;
    --body: #475569;
    --label: #64748b;
    --muted: #94a3b8;
    --light: #0f172a;
    --green: #16a34a;
    --red: #dc2626;
    --yellow: #ca8a04;
  }
  section {
    background: var(--dark);
    color: var(--light);
    font-family: 'Inter', sans-serif;
    font-weight: 300;
    padding: 48px 64px;
  }
  section.lead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    text-align: center;
  }
  h1 { font-weight: 700; font-size: 2.2em; color: var(--light); margin-bottom: 0.3em; line-height: 1.2; }
  h2 { font-weight: 300; font-size: 1.3em; color: var(--body); margin-top: 0; }
  h3 { font-weight: 600; font-size: 0.75em; color: var(--label); text-transform: uppercase; letter-spacing: 0.1em; }
  p, li { color: var(--body); line-height: 1.6; font-size: 1em; }
  strong { color: var(--light); font-weight: 600; }
  em { color: var(--accent); font-style: normal; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: var(--card); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { color: var(--label); font-weight: 600; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); padding: 8px 12px; text-align: left; }
  td { color: var(--body); border-bottom: 1px solid var(--border); padding: 8px 12px; }
  a { color: var(--accent); text-decoration: none; }
  blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--muted); font-style: italic; }
  footer { color: var(--label); font-size: 0.6em; }
```

### Recommended Font Pairings for Research

| Heading / Body | Best For | Notes |
|----------------|----------|-------|
| Inter 700 / Inter 300 | General research talks | Clean, highly legible, safe default |
| Outfit 800 / Raleway 200 | Data-heavy dashboards | High contrast weight difference |
| DM Serif Display / DM Sans 300 | Humanities, social science | Warmer, editorial feel |
| Space Grotesk 700 / IBM Plex Mono 300 | CS/Systems talks | Technical, monospace body for code-heavy content |
| Plus Jakarta Sans 800 / Plus Jakarta Sans 200 | Internal team presentations | Friendly, modern |

## Slide Templates

### Title slide

```markdown
<!-- _class: lead -->
<!-- _paginate: false -->

# Paper or Talk Title Here
## Subtitle or Key Finding in One Line

**Presenter Name**, Co-author, Co-author
*Affiliation — Conference / Venue, Date*
```

### Section divider

```markdown
<!-- _class: lead -->
<!-- _paginate: false -->

# Methodology
```

### Assertion-Evidence content slide (default)

```markdown
# LEGO-xtal generated 1,741 new sp² allotropes from 25 starting structures

![w:700](./figures/energy_distribution.png)

**A ~70× expansion** of the known low-energy sp² carbon space, achieved without a single extra DFT calculation during generation.
```

### Two-column comparison

```markdown
# Pre-relaxation cuts optimization time by 10× versus pure energy-based search

<div style="display: flex; gap: 40px;">
<div style="flex: 1;">

### Without pre-relaxation
- Random init → MACE optimization
- ~120 min per 1k samples
- Many stuck in bad minima

</div>
<div style="flex: 1;">

### With SO(3) pre-relaxation
- Descriptor-guided warm start
- ~9.5 min per 1k samples
- Higher fraction reach sp² geometry

</div>
</div>
```

### Data table slide

```markdown
# Our model outperforms all baselines on three metrics

| Method | Accuracy | Latency (ms) | Memory (GB) |
|--------|----------|--------------|-------------|
| Baseline A | 78.2% | 120 | 4.2 |
| Baseline B | 81.5% | 95 | 6.1 |
| **Ours** | **86.3%** | **72** | **3.8** |

**Bold = best in column.** Averaged over 5 runs, all std < 0.3%.
```

### Equation slide

```markdown
# Our training objective combines supervised and contrastive losses

$$
\mathcal{L} = \underbrace{\mathcal{L}_{\text{CE}}(f(x), y)}_{\text{supervised}} + \lambda \underbrace{\mathcal{L}_{\text{CL}}(z_i, z_j)}_{\text{contrastive}}
$$

- $\lambda = 0.1$ chosen by validation
- $z_i, z_j$: augmented views of same input
```

### Thank you / questions

```markdown
<!-- _class: lead -->
<!-- _paginate: false -->

# Thank You

**Questions?**

your.email@university.edu
Paper: arxiv.org/abs/xxxx.xxxxx
Code: github.com/yourname/project
```

## Inline Component Library

### Metric cards

```html
<div style="display: flex; gap: 24px; margin-top: 24px;">
  <div style="flex: 1; background: var(--card); border: 1px solid var(--border); border-top: 3px solid var(--accent); border-radius: 8px; padding: 20px;">
    <div style="color: var(--label); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.1em;">New structures</div>
    <div style="font-size: 2.2em; font-weight: 700; color: var(--light); margin: 4px 0;">1,741</div>
    <div style="color: var(--green); font-size: 0.8em;">70× vs training</div>
  </div>
</div>
```

### Simple bar chart (inline SVG)

```html
<svg viewBox="0 0 500 200" style="width: 100%; max-width: 600px; margin: 20px auto; display: block;">
  <line x1="60" y1="170" x2="480" y2="170" stroke="var(--border)" stroke-width="1"/>
  <rect x="80" y="90" width="60" height="80" fill="var(--muted)" rx="4"/>
  <rect x="180" y="60" width="60" height="110" fill="var(--muted)" rx="4"/>
  <rect x="280" y="30" width="60" height="140" fill="var(--accent)" rx="4"/>
  <text x="110" y="190" fill="var(--label)" font-size="12" text-anchor="middle">Baseline A</text>
  <text x="210" y="190" fill="var(--label)" font-size="12" text-anchor="middle">Baseline B</text>
  <text x="310" y="190" fill="var(--light)" font-size="12" text-anchor="middle" font-weight="600">Ours</text>
  <text x="110" y="82" fill="var(--body)" font-size="12" text-anchor="middle">78.2%</text>
  <text x="210" y="52" fill="var(--body)" font-size="12" text-anchor="middle">81.5%</text>
  <text x="310" y="22" fill="var(--accent)" font-size="13" text-anchor="middle" font-weight="600">86.3%</text>
</svg>
```

## Common Failure Modes

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Audience asks "what was the point?" after talk | Phase 1 was skipped; no clear thesis | Return to Phase 1 |
| Slides look busy and cramped | Phase 3 violated one-idea limits | Split overloaded slides |
| Listener got lost in the middle | Missing transitions; story spine has gaps | Re-read story beats in order |
| Figures illegible from back row | Used publication figures directly | Re-export at slide sizes using `scientific-visualization` |
| Content overflows and gets clipped | Marp silent-clipping | Visual preview every slide |
| Polish consumed all the time | Started Phase 4 before content stable | No visual work until content approved |
| Math renders as literal `$...$` in PDF | `$...$` is inside a single-line HTML block tag (e.g., `<div class="card">...$x$...</div>`), so markdown-it never tokenizes it | Add blank lines inside the `<div>` around the math, OR move block `$$...$$` outside the container. See Math section for the canonical fix. |

## Export Reference

```bash
# Live preview during authoring
npx @marp-team/marp-cli slides.md --watch --html --allow-local-files

# Final HTML
npx @marp-team/marp-cli slides.md --html --allow-local-files

# PDF backup — ALWAYS produce this
npx @marp-team/marp-cli slides.md --pdf --allow-local-files

# PPTX (only if editing further in PowerPoint)
npx @marp-team/marp-cli slides.md --pptx --allow-local-files
```

## Integration with Other Skills and Tools

| Task | Combine with |
|------|-------------|
| Publication-quality figures | `scientific-visualization` → PNG/SVG → embed |
| Custom low-level plots | `matplotlib` or `seaborn` → PNG/SVG → embed |
| Diagrams and schematics | `scientific-schematics` → SVG → embed |
| Convert paper draft → talk | `convert-document` tool on PDF/DOCX → extract observations, stakes, evidence, and claims in Phase 1 |
| Fresh data-driven numbers | `data-analyze` tool → feed results into Phase 3 |
| Related-work / references | `literature-search` tool → populate References backup slide; also used as quick tier-2 context scan in Context Gate |
| Search workspace for prior work | `artifact-search` on `papers`/`notes` during Context Gate (tier 1) |
| Paper knowledge base lookups | `wiki_search` / `wiki_get` / `wiki_coverage` / `wiki_neighbors` / `wiki_source` during Context Gate (tier 1) |
| Long-lived user preferences (venues, co-authors, style) | Read `.research-pilot/memory/MEMORY.md` + linked files during Context Gate (tier 1) |
| Online fill-ins (venue CFP, keynote examples) | `web_search` / `web_fetch` as tier-3 fallback only |
| Persist storyline and final deck | `artifact-create` with `type='note'` (Phase 1) and `type='tool-output'` (Phase 4) |
| Sister skill for lectures | `teaching-marp-slides` — use for classroom/course material |

---

## Final Reminder

Slide quality is set in Phase 1 (storyline) and by the user's own dry run after delivery. **A deck with a weak thesis and beautiful visuals loses to a deck with a sharp thesis and plain visuals — every time.** In Revise Mode, respect the user's existing choices: change only what's requested or clearly broken.
