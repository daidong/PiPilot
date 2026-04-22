---
name: teaching-marp-slides
description: "Create or revise lecture/teaching slides in Markdown using Marp for upper-undergraduate and graduate courses across any academic discipline. Use when the user needs classroom lecture slides, course materials, tutorial slides, workshop sessions, or wants to revise existing teaching slides. Enforces Cognitive Load Theory, worked-example effect, scaffolding, and retrieval practice principles. Produces both a lecture version and a handout version. For research/conference talks use `academic-marp-slides`; for written documents use `paper-writing` or `scientific-writing`."
category: Presentation
tags: [Marp, Slides, Teaching, Lecture, Course, Pedagogy, Classroom, Tutorial, Workshop, Worked Example, Scaffolding, 教学, 课件, 讲课]
triggers: [lecture slides, teaching slides, course slides, tutorial slides, classroom presentation, make lecture, teach a class, course materials, workshop slides, revise lecture, improve lecture, 讲课幻灯片, 课件, 教学课件, 授课幻灯片]
depends: [scientific-visualization, scientific-schematics]
license: MIT
metadata:
    skill-author: Dong Dai
    based-on: robonuggets/marp-slides, Sweller Cognitive Load Theory, Alley worked-example effect, Vygotsky scaffolding
---

# Teaching / Lecture Slides with Marp

## Core Principle

**Teaching slides are not research slides.** Where research slides argue a single thesis to an expert audience, teaching slides **build understanding** in a learning audience and serve as **reference material** that students re-read while studying.

This changes almost every design rule:

| | Research slides (`academic-marp-slides`) | Teaching slides (this skill) |
|---|---|---|
| Title style | Assertion sentence | Topic label (findable in outline) |
| Information density | Sparse, image-led | Higher — slides also function as notes |
| Redundancy | Avoid duplicating speech | **Intentional repetition reinforces memory** |
| Structure | Single narrative arc | Repeated learning units (intro → example → practice) |
| One idea per slide | Strict | Relaxed when comparison/context requires it |
| Slides the student reads later | No | **Yes — must stand alone** |

### The four theoretical anchors

1. **Cognitive Load Theory (Sweller)**: Distinguish intrinsic load (concept difficulty), extraneous load (bad design), and germane load (productive struggle). Minimize extraneous, preserve germane.
2. **Worked Example Effect**: Learners benefit more from complete worked examples than from pure problem-solving practice, especially when a concept is new. Every new concept needs an accompanying worked example.
3. **Scaffolding (Vygotsky)**: Bridge known → unknown. New concepts require a prerequisite-recall step before introduction.
4. **Retrieval Practice & Spacing Effect**: Long-term retention requires active recall. Every lecture needs review + preview moments.

> **Note on rehearsal**: The user handles delivery rehearsal themselves after receiving the draft. This skill stops at a polished draft and does not prescribe dry-teach steps. The user will test the lecture and return with revisions (Revise Mode).

---

## Target Audience Assumption

This skill is tuned for **upper-undergraduate and graduate-level** instruction. That means:

- Students can handle moderate notation and specialized terminology once defined
- Scaffolding bridges a few concepts at a time, not every basic term
- Worked examples can assume familiarity with prerequisite material
- Advanced asides (marked with `★ Advanced`) are appropriate when the cohort is mixed or when extending the core path for stronger students

For intro-level or non-specialist audiences, the skill is still usable but you'll want to expand prerequisite-recall sections and keep worked examples closer to first principles.

**The skill is domain-neutral.** Templates use placeholders that adapt to whatever subject matter the user brings — equations for a math course, diagrams for a biology course, derivations for a physics course, case analyses for a humanities course, and so on. Fill these placeholders from the user's domain context in conversation, not from pre-encoded subject knowledge.

---

## When to Use This Skill

- Classroom lectures (50 / 75 / 90 minutes)
- Recorded lectures and flipped-classroom materials
- Graduate seminars, recitations, discussion sections
- Tutorials, hands-on workshops, technical training sessions
- **Revising** an existing Marp lecture deck

### When NOT to Use

| Need | Use Instead |
|------|-------------|
| Research / conference talk | `academic-marp-slides` |
| Written paper, textbook chapter, full lecture notes document | `paper-writing` or `scientific-writing` |
| Standalone data figure | `scientific-visualization`, `matplotlib`, or `seaborn` |
| Conceptual diagram only | `scientific-schematics` |
| Reference documentation / how-to guide | Write Markdown directly |

---

## Phase 0: Mode Detection (Do This First)

### Signals for **Revise Mode**
- User attached or referenced an existing `.md` lecture file
- User says "fix/update/add to [existing lecture]"
- Source Markdown already in conversation

### Signals for **Create Mode**
- User describes a topic to teach but no existing deck
- "Make lecture slides for [topic]"
- No Marp source yet

When ambiguous, ask:
> "Are we starting fresh or revising an existing lecture? If existing, please share the .md source."

---

## Context Gate (Required Before Create Mode)

**Good lectures do not start from scratch — they build on existing course context.** Before entering Phase 1, run the context sweep below and summarize what you found (and what you could not find) to the user.

Unlike research decks, teaching materials usually live as **plain files in the user's workspace** — syllabus PDFs, textbook scans, prior `.pptx`/`.pdf`/`.md` lectures, problem-set folders — not inside `.research-pilot/`. So the sweep leads with the workspace itself, and the user typically knows the file paths.

The sweep has three tiers. **Do all of tier 1 always; do tier 2 whenever it is cheap and plausibly relevant; only do tier 3 if tier 1+2 left real gaps.** Report at each tier — do not silently skip.

### Tier 1 — Local context (always do, zero cost)

1. **Ask the user up front what they have, and do a quick `ls` to verify.** Most of the time the instructor will say "the syllabus is at `./courses/CS101/syllabus.pdf`" or "last year's lectures are in `./lectures/`". If they haven't pointed at a path, run a one-shot workspace scan to surface candidates — for example:
   ```bash
   ls -la
   find . -maxdepth 3 -type f \( -iname "*syllabus*" -o -iname "*lecture*" -o -iname "*lec[0-9]*" -o -iname "*slides*" -o -iname "*unit*" -o -iname "*chapter*" -o -iname "*problem*" -o -iname "*hw*" -o -iname "*ps[0-9]*" \) -not -path "*/node_modules/*" -not -path "*/.git/*" | head -40
   ```
   Don't open every hit — list them to the user briefly and let them pick the relevant ones. Then `convert-document` any PDFs/DOCX the user confirms, and read Markdown/text directly.
2. **Prior lectures under research-pilot tool-output** — check `.research-pilot/artifacts/tool-output/slides/` for any lectures in the same course generated in earlier sessions. Match terminology, notation, formatting.
3. **Structured memory** — read `.research-pilot/memory/MEMORY.md` (the index) for long-lived facts about this course: standard notation, the instructor's preferred analogies, cohort quirks, past student misconceptions they want called out every term. Open any memory file whose description looks relevant.
4. **Artifacts** — call `artifact-search` scoped to `notes` and `papers` with keywords from the lecture topic (course code, unit name, last lecture title). Hits here are typically TA notes, reading summaries, or pedagogical references the user saved.
5. **Papers wiki (RFC-005)** — usually less central for teaching, but worth a `wiki_search` if the lecture is research-adjacent (e.g., a graduate seminar on recent papers). If `wiki_search` returns nothing or "Wiki not available", skip.

### Tier 2 — User confirmation + light expansion (do when gaps remain)

**Ask the user once, in a batched message**, whether any of these additional inputs exist that didn't show up in the `ls`:
- **Course syllabus** (scope, where this lecture fits)
- **Prior lectures from this course** (what students have already seen; established terminology and notation)
- **Textbook or required readings** (so you can reference, not duplicate)
- **Past versions of this lecture** (instructor's earlier slides, if teaching the course before)
- **Problem sets or exams** (so Check-for-understanding slides can preview assessment style)

**Plus, do a quick literature scan** only in specific cases:
- Graduate seminar / research-adjacent lecture where the field has moved since the textbook was written → `literature-search` for the last 1–2 years of relevant work.
- A worked example will rest on a recent result the user didn't provide.
- Otherwise skip — for a standard course lecture the textbook + syllabus are enough.

### Tier 3 — Online fallback (do only if needed for a specific gap)

Use only when a specific, load-bearing gap remains:
- `web_search` for authoritative definitions, up-to-date convention changes (e.g., a terminology update in a standards body), or a concrete example to replace one you can't generate.
- `web_fetch` on a URL the user named.

Do not use tier 3 to generate the body of the lecture — that's the instructor's subject-matter call, not yours.

### After the sweep — report and decide

Write one short paragraph to the user:
- **What I found:** [files from `ls` / prior lectures / memory hits / artifact hits / literature hits]
- **What I still need:** [specific gaps — e.g., "no problem-set PDF found, so check-for-understanding slides will guess at assessment style unless you share one"]
- **Proposed action:** either (a) proceed to Phase 1 now, or (b) pause while the user supplies one or two missing pieces

If the sweep turns up nothing substantive and the user has nothing more to share, proceed — but flag it explicitly:
> "No course context found locally and nothing to pull from — I'll generate from scratch. Output may duplicate material students already have or miss things they already know. Consider sharing the syllabus, a prior lecture, or the textbook section if possible."

## Working Posture (Applies to All Phases)

Work like a junior teaching assistant briefing the lead instructor — not like a machine executing a template.

- **Surface assumptions before acting.** If you're inferring something the user didn't say (e.g., "I assume students have already seen [prerequisite concept] from Unit 3"), state it.
- **Name decisions and their rationale.** When choosing a worked example, say why that specific example and what alternatives you considered.
- **Flag unknowns.** If a worked example needs a figure or data you don't have, mark it with a clear placeholder and ask.
- **Less is more.** Teaching slides are denser than research slides, but that's no license for filler. Every definition, step, example, and common-mistake entry must teach something specific. See Step 4.7 for the anti-slop rules.

These apply at every STOP AND CONFIRM gate.

---

## Consolidated Intake (Ask Everything Up Front, in One Batch)

Rather than asking questions one at a time and ping-ponging, ask for everything needed in a single structured request. If the user has already answered some of these in earlier messages, or the Context Gate surfaced them from artifacts, fill those in and only ask the remainder.

**Required before moving on:**

1. **Topic** — what specifically is this lecture about (be precise, not "machine learning" but "backpropagation through a single hidden layer")
2. **Level** — upper-undergraduate / graduate / mixed / professional audience
3. **Lecture length** — 50 min / 75 min / 90 min / 2–3 hour tutorial
4. **Prerequisites you can assume** — concrete list of prior courses, topics, notation students have already seen
5. **Format** — large lecture / small seminar / flipped / interactive with exercises
6. **Handout policy** — slides before, after, or during class?
7. **Context material available** — syllabus, prior lectures, textbook (tie to Context Gate above)
8. **Hard constraints** — mandatory content (university-required topics, accreditation standards), anything promised to students last class

Batch these as one message. Do not begin drafting learning objectives until at least items 1, 2, 3, and 4 are answered.

If the cohort is **mixed** (common in courses cross-listed between undergrad and grad):
- Write for the **mid-to-lower** of the range
- Mark deeper content with `<!-- _class: advanced -->` so it reads as optional
- Include prerequisite-recall slides even for "obvious" foundations

---

# CREATE MODE

Six phases. Confirmation gates at Phase 1, 3, 4, and 5. **Do not skip gates. Do not proceed without explicit user approval.**

```
Phase 1: Learning Objectives         ──►  Bloom-tagged outcome list    (15%)
Phase 2: Prerequisite & Gap Analysis ──►  Known vs new map              (10%)
Phase 3: Lesson Arc                  ──►  Structured slide outline      (15%)
Phase 4: Content + Worked Examples   ──►  Fill in all slides            (35%)
Phase 5: Engagement Checks           ──►  Insert checkpoints            (10%)
Phase 6: Polish + Dual Export        ──►  Visual + lecture/handout      (15%)
```

## Phase 1: Learning Objectives

**Goal**: Define what students should be able to *do* after the lecture, not just what "topics are covered."

Use **Bloom's taxonomy** to force specificity. Every objective starts with a verb at a chosen cognitive level:

| Bloom level | Example verbs | Example objective shape |
|-------------|--------------|-------------------------|
| **Remember** | define, list, identify, recall | "List the key assumptions of [framework]" |
| **Understand** | explain, describe, summarize, interpret | "Explain why [phenomenon] occurs" |
| **Apply** | implement, use, solve, compute | "Apply [method] to a new problem instance" |
| **Analyze** | compare, distinguish, diagnose | "Diagnose the failure mode of [approach] in scenario X" |
| **Evaluate** | critique, justify, choose | "Justify the choice of [approach A vs B] for [context]" |
| **Create** | design, construct, propose | "Design an experiment to test [hypothesis]" |

### Rules for objectives

- **3–6 objectives per 50-minute lecture**. More than 6 → split into two lectures.
- **Every objective must be assessable.** "Understand X" is not assessable by itself; "Explain why X fails when assumption Y is violated" is.
- **Each objective maps to ≥ 1 slide and ideally a worked example or check.**
- For **graduate-level** lectures, aim higher in Bloom's taxonomy (Analyze/Evaluate/Create); for **upper-undergraduate**, a mix of Apply and Analyze is typical.

### ★ STOP AND CONFIRM ★

Present the learning objectives to the user as a junior-to-instructor briefing:

**Proposal:**
- 3–6 objectives, each Bloom-tagged

**Assumptions I made (tell me if any are wrong):**
- [e.g., "I assumed the lecture is the first time students see [concept], not a review."]
- [e.g., "I assumed 'Apply' level is appropriate here rather than 'Analyze' — confirm based on the cohort."]

**Open questions:**
- [e.g., "Unsure whether objective 4 is a stretch goal or core — should I plan for it to be cuttable?"]

Also ask:
- Are these the right outcomes for this lecture?
- Is the level appropriate for the cohort?
- Anything missing? Anything too ambitious for one lecture?

Do not proceed without approval.

**Persist the approved objectives.** After approval, call `artifact-create` with `type='note'` and a title like `Lecture plan — <course code> <lecture N>: <topic>`, storing the objectives, the Bloom tags, and any instructor-provided constraints. This gives a resumable checkpoint and makes the plan searchable for revisions or reuse in future terms.

### Phase 1 Checklist

- [ ] Context Gate completed (workspace searched; course material confirmed or absence flagged)
- [ ] Consolidated intake completed
- [ ] 3–6 objectives, each Bloom-tagged
- [ ] Every objective starts with an action verb
- [ ] Every objective is assessable
- [ ] User has approved the objectives
- [ ] Approved objectives persisted as a note artifact

---

## Phase 2: Prerequisite & Gap Analysis

**Goal**: Map what students already know against what they need to know, and identify the gap to scaffold.

### Step 2.1 — List prerequisites for each objective

For each learning objective, list the knowledge, skills, and mental models required. Be specific.

Template:
```
Objective: [action verb] [content]
Prerequisites:
  - [concept from prior course / earlier in this course]
  - [skill they should have already practiced]
  - [notation / terminology they've seen]
Gaps (new material to introduce today):
  - [definition / framework / technique]
  - [relationship to prerequisite concepts]
  - [common pitfalls in this new area]
```

### Step 2.2 — Plan scaffolding moves

For each identified gap, plan how to bridge it:

| Gap type | Scaffold move |
|---------|--------------|
| Forgotten prerequisite | Short recall slide at start of lecture |
| Subtle misconception likely | Explicit "common mistake" slide |
| Conceptually abstract | Start with concrete example, then generalize |
| Notation-heavy | Introduce one piece of notation at a time, anchor in an example |
| Multi-step procedure | Break into numbered steps on separate slides |
| Requires prior-course material | Link back explicitly: "recall from [course X] that…" |

### Step 2.3 — Flag advanced asides

For mixed cohorts or when extending beyond core requirements:
- Mark slides with `<!-- _class: advanced -->` (styling defined in Phase 6)
- Or add a small "★ Advanced" badge in the slide content

No confirmation gate here — this is internal planning. Move to Phase 3.

### Phase 2 Checklist

- [ ] Prerequisites listed for each objective
- [ ] Gaps identified
- [ ] Scaffolding strategy chosen for each gap
- [ ] Advanced asides flagged (if mixed cohort)

---

## Phase 3: Lesson Arc

**Goal**: Structure the lecture as a sequence of learning units, not a flat slide list.

### The canonical lecture arc

A 50-minute lecture typically has this shape. Use it unless there's good reason not to:

```
┌──────────────────────────────────────────────┐
│ 1. Review previous lecture         (2–3 min) │  retrieval practice
│ 2. Today's objectives              (1 min)   │  set expectations
│ 3. Motivation / hook               (2–3 min) │  why care?
│ 4. Prerequisite recall             (2–5 min) │  scaffolding
├──────────────────────────────────────────────┤
│  UNIT A                                      │
│   5. Concept introduction          (5 min)   │  definition + intuition
│   6. Worked example                (5–8 min) │  full solution shown
│   7. Check for understanding       (2 min)   │  student attempt
│   8. Common mistakes               (2 min)   │  misconception page
├──────────────────────────────────────────────┤
│  UNIT B (repeat pattern)                     │
├──────────────────────────────────────────────┤
│  Synthesis / how units relate      (2 min)   │
│  Summary + key takeaways           (2 min)   │  consolidation
│  Preview of next lecture           (1 min)   │  spacing effect
│  Reading / assignments             (1 min)   │
└──────────────────────────────────────────────┘
```

### Unit granularity

A "unit" is one learning objective worth of material. For a 50-min lecture with 4 objectives, expect 4 units of 8–12 min each.

### Slide budget per element

For a **50-min lecture** (~25–35 slides total):

| Element | Typical slides |
|---------|---------------|
| Title | 1 |
| Review previous lecture | 1–2 |
| Today's objectives | 1 |
| Motivation | 1–2 |
| Prerequisite recall | 1–3 |
| Concept introduction (per unit) | 2–3 |
| Worked example (per unit) | 3–5 |
| Check for understanding (per unit) | 1 |
| Common mistakes (per unit) | 1 |
| Summary + preview | 2 |
| Total | 25–35 |

For a **75-min** lecture, scale to ~35–50 slides. For **90-min**, ~45–60.

### Propose 2–3 pacing options (let the user pick)

The canonical arc is the default, but how you distribute time across units depends on what the instructor wants to emphasize. Before committing to a single arc, propose 2–3 pacing variants and let the user pick:

| Pacing | Emphasis | Trade-off |
|--------|----------|-----------|
| **Concept-heavy** | More time on definitions, intuition, and prerequisite recall; worked examples kept tight | Students leave with strong conceptual grasp but less procedural fluency |
| **Example-driven** | Minimal conceptual overhead, most time in worked examples and variants | Students can apply the method but may shakily justify it |
| **Balanced** | Canonical 50/50 split between concept and example per unit | Safe default; no particular strength |
| **Practice-heavy** | Short concept + short example + long active practice | Best when students already have partial exposure to the material |

Present 2–3 candidates that plausibly fit the topic, along with a one-line trade-off for each, and wait for the user's pick before drafting the full slide outline.

### ★ STOP AND CONFIRM ★

Present the outlined lesson arc as a junior-to-instructor briefing:

**Proposal:**
- Chosen pacing (from the options above)
- Units with time allocations
- Slide-by-slide outline with titles

**Assumptions I made:**
- [e.g., "I put the harder worked example in Unit B because students will be fresher after the Unit A break; move it if you'd rather front-load."]

**Open questions:**
- [e.g., "Unit C has three potential worked examples — which one is most representative of what appears on the midterm?"]

Also ask:
- Does this pacing fit the class period?
- Are the units the right granularity?
- Is anything missing (a topic, a worked example, a review moment)?

Wait for approval before Phase 4.

### Phase 3 Checklist

- [ ] Lecture arc mapped (review → motivate → units → synthesize → preview)
- [ ] Each learning objective corresponds to a unit
- [ ] Worked examples planned for each unit
- [ ] Check-for-understanding slides planned
- [ ] Total slide count matches lecture length
- [ ] User has approved the arc

---

## Phase 4: Content + Worked Examples

**Goal**: Fill in every slide with appropriate content, with special care for worked examples.

**Tools allowed**: Write content, embed figures, equations, tables, diagrams, and any subject-appropriate representation. **Visual polish comes later.**

### Step 4.0 — Decide output location

Write the Marp source to `<workspace>/.research-pilot/artifacts/tool-output/slides/<course-code>-lecture-<N>.md` (create the `slides/` subfolder if missing). Keeping all course lectures under the same path makes `artifact-search` and cross-lecture reuse straightforward.

If the user specifies a different path, honor it — but mention this convention so they know where future lectures will land by default. Export-time handout file will sit next to it as `<course-code>-lecture-<N>_handout.md`.

### Step 4.1 — Use topic-label titles (NOT assertions)

Unlike research slides, teaching slide titles should be **topic labels that work as an outline**:

```markdown
# [Topic name]: [subtopic]
```

Not:
```markdown
# [Complete sentence stating a result about the topic]
```

**Why**: Students use titles as navigation when reviewing. Topic labels are findable in a table of contents; assertion sentences are not. A student skimming notes a week later needs "Topic X: [specific subtopic]" rather than a full declarative statement.

**Exception**: end-of-unit takeaway slides **can** use an assertion-style title to consolidate.

### Step 4.2 — Concept introduction slide pattern

For each new concept:

```markdown
# [Concept name]

**Definition**
A *[concept]* is [precise one-sentence definition].

**Intuition**
[One analogy or informal explanation, 1–2 sentences. Connect to something the audience already understands.]

**When it matters**
[Concrete setting where this concept is essential — makes it memorable and anchors future recall.]
```

### Step 4.3 — Worked example pattern (the most important pattern in teaching)

A good worked example has **five components**, shown either across sequential slides or with progressive reveal on one slide:

```
1. Problem statement         → What exactly is given, what is to be found or shown?
2. Approach / key idea       → What's the insight that makes this tractable?
3. Step-by-step solution     → Show the full work, not just the answer
4. Final answer              → Concrete, checkable result
5. Reflection / why it works → Connect back to the concept; note assumptions and generalizations
```

**Generic template — fill placeholders from the user's subject matter:**

```markdown
# Worked example: [problem name]

### Problem
[State precisely what is given and what is to be found or shown.]

### Approach
[The key insight or technique — one or two sentences. Naming the approach before doing the work is crucial: it's what students most need to extract and transfer.]

### Step-by-step
1. [First step with justification]
2. [Second step with justification]
3. [... continue, splitting across slides if long]
4. [Final step producing the answer]

### Answer
**[Final result, clearly marked.]**

### Why this works / when it generalizes
[Connect back to the concept. Note key assumptions, and indicate when the approach generalizes or fails.]
```

**Key disciplines for worked examples**, regardless of subject:

- **Show the approach before the work.** Students who see a full solution without knowing why each step is taken learn less than those who first hear the key insight.
- **Annotate the critical step.** Use bold, arrows, or callouts on the one step where the key idea actually operates.
- **Label what would change in the general case.** Helps transfer from the specific instance to the broader class of problems.
- **Match representation to subject.** Equations for mathematical subjects, diagrams for structural/spatial subjects, case narratives for applied or humanities subjects, data tables for empirical subjects. The five-component structure stays the same.

### Step 4.4 — Source figures and demos (use project skills/tools)

Teaching decks use more figures and live demos than research decks. Source them in this priority order:

1. **Existing course figures** from prior lectures or textbook — simplify for slide use (enlarge labels, trim legends).
2. **Fresh concept diagrams / schematics** — `load_skill('scientific-schematics')` to generate SVG/PNG (requires `OPENROUTER_API_KEY`; fall back to inline SVG or hand-drawn placeholder if unavailable).
3. **Fresh data plots for intuition slides or worked-example setups** — `load_skill('scientific-visualization')` for journal-style multi-panel, or `load_skill('matplotlib')` / `load_skill('seaborn')` for custom/statistical plots. Save outputs to `<workspace>/.research-pilot/artifacts/tool-output/slides/figures/` and embed with relative paths.
4. **Live-compute demos for class** — the `data-analyze` tool can generate both a plot and the code behind it, useful for demo slides where the instructor wants to show "how we got this number." Embed the plot; paste a trimmed version of the code into a code slide; keep the raw analysis artifact for reference.
5. **Suggested-readings / references slide** — the `literature-search` tool assembles metadata for a References or Further Reading backup slide in the instructor's preferred citation style.
6. **Inline SVG / HTML components** — for metric callouts, small comparison visuals, simple bar charts without external dependencies (see templates below).

### Step 4.5 — Check-for-understanding slide pattern

Insert after each worked example. Three common formats:

**Format A — Predict/reason** (good for testing conceptual grasp)
```markdown
# Check: predict [quantity / behavior / outcome]

Given [setup], what is [quantity of interest]?

- A) [option]
- B) [option]
- C) [option]
- D) [option]

<!-- Give 30–60 seconds. Answer: [answer]. Common wrong answer: [option + why students pick it]. -->
```

**Format B — Spot the error** (good for testing analytical skills)
```markdown
# Check: what's wrong here?

[Present a short attempted solution, derivation, or argument with a subtle error embedded.]

Where does it fail, and why?

<!-- The error is at [location]. Students often miss it because [reason]. Good teachable moment for [concept]. -->
```

**Format C — Apply to a variant** (good at end of a unit)
```markdown
# Check: same idea, different problem

We just solved [original problem].
Now: [variant that changes one assumption].

How does the solution change?

<!-- Useful as think-pair-share for 2 min. Expected answer: [sketch]. -->
```

### Step 4.6 — Common mistakes slide pattern

Every major concept deserves a misconception slide. This prevents students from silently carrying wrong models:

```markdown
# Common mistakes with [concept]

**❌ "[Plausible but wrong statement students often make]"**
→ [Why it's wrong, in one sentence. What the correct statement is.]

**❌ "[Second misconception — often a confusion with a related concept]"**
→ [Distinction made explicit.]

**❌ "[Third misconception — often an over-generalization]"**
→ [Scope of validity clarified.]
```

**Where to find the misconceptions**: from previous years teaching the course, from exam errors, from office-hours questions, or from published pedagogical literature. If the user hasn't taught it before, ask them to predict likely misconceptions based on their own learning experience. If artifacts in the workspace contain past TA notes or exam post-mortems (check with `artifact-search`), draw from those.

### Step 4.7 — Slide density rules for teaching

Teaching slides can be **denser than research slides**, but not unlimited:

- Max ~60 words (English) or ~100 characters (CJK) of prose per slide
- Max ~15 lines of technical content (equations, derivations, code, structured data) per slide — split longer
- Max ~8 rows in a data or comparison table
- Body text not below 18pt (0.9em)
- **Always leave whitespace** — dense ≠ cramped
- If a slide approaches these limits, consider whether it's really one idea or two

### Step 4.8 — Less is more (reject filler content)

The "denser than research slides" allowance is often misused. Teaching slides go bad not because they're sparse, but because they're padded with material that looks educational but isn't. Actively reject these filler patterns:

- **Stat slop** — numbers, percentages, or metrics dropped onto slides for flavor, without teaching anything
- **Decorative icons** — icons next to every bullet that carry no semantic meaning
- **Padding bullets** — expanding 3 real points into 5 to "fill the slide" or "look thorough"
- **Restated titles** — a bullet or sentence that just paraphrases the topic label
- **Generic "why this matters"** — vague motivation that could apply to any topic ("This concept is widely used in industry")
- **Wikipedia-tone background** — dense expository prose summarizing a topic rather than teaching it
- **Too-clever examples** — examples chosen to impress rather than to scaffold understanding
- **Over-enumerated taxonomies** — lists of 8+ types/categories where students only need to recognize 2–3

If a slide feels thin, fix it by (a) adding a concrete example, (b) adding a common-mistake, or (c) merging with a neighbor — never by inventing filler. One thousand no's for every yes.

### Step 4.9 — Include speaker notes for every slide

Unlike research slides where notes are optional, teaching slides should have **notes for every slide** because:

1. They help the instructor recall timing, emphasis, and anticipated questions
2. They help co-instructors or TAs teach the same material consistently
3. They can be rendered in the handout version for students

```markdown
<!--
Speaker note: Spend ~90 sec on this slide. Walk through [step that's hard]
by pointing at [visual element]. Expected question: "[common question]" →
answer: [response]. Tie back to [earlier lecture / concept] if time allows.
-->
```

### ★ STOP AND CONFIRM ★

Show the filled-in deck as a junior-to-instructor briefing:

**Deliverable:**
- Rendered Marp deck with all units filled in, worked examples complete, speaker notes per slide

**Assumptions I made:**
- [e.g., "I chose [specific example] for Unit B because it mirrors problem 3 on last year's midterm; swap if you'd rather not foreshadow."]
- [e.g., "The common-mistakes slide for Unit A is based on my guess at what would go wrong; please verify against what you've actually seen."]

**Open questions:**
- [e.g., "Worked example in Unit C currently has a placeholder figure — do you want me to sketch a draft or wait for your diagram?"]

Also ask the user to:
- Verify each worked example for correctness (subject-matter expertise is theirs, not yours)
- Flag slides that are too dense or too sparse
- Note any missing concept the cohort will need
- Check the Common Mistakes slides against what they've actually seen students get wrong

Wait for approval before Phase 5.

### Phase 4 Checklist

- [ ] Skeleton + content written under `.research-pilot/artifacts/tool-output/slides/` (or user-specified path)
- [ ] Every concept slide has definition + intuition + when-it-matters
- [ ] Every unit has a worked example with all 5 components
- [ ] Every unit has a check-for-understanding slide
- [ ] Every unit has a common-mistakes slide
- [ ] Every slide has speaker notes
- [ ] All embedded figures resolve (no broken links)
- [ ] Slide density is within limits
- [ ] User has approved the content

---

## Phase 5: Engagement Checks

**Goal**: Audit the lecture for active-learning touchpoints, and add any missing ones.

Research on college teaching consistently shows that lectures with active engagement every 10–15 minutes outperform pure lecturing on learning gains. Use this phase to confirm adequate active moments.

### Step 5.1 — Engagement audit

Walk through the deck and count engagement points. A 50-min lecture should have **at least 4–5**:

| Engagement type | Purpose | Frequency |
|-----------------|---------|-----------|
| Check-for-understanding (predict/reason) | Test application | 1 per unit |
| Spot-the-error | Apply + analyze | 1 per unit |
| Think-pair-share prompt | Peer instruction | 1–2 per lecture |
| Live demonstration | Show process unfolding | When applicable |
| Poll / clicker question | Rapid formative assessment | Optional |
| Recall from last lecture | Retrieval practice | Opening |
| Mid-lecture summary | Consolidation | Midpoint of long lectures |

### Step 5.2 — Add missing engagement points

If the audit finds fewer than 4 engagement points, insert more:
- Convert a passive explanation slide into a "predict first, then reveal" pair
- Add a think-pair-share prompt after a conceptually hard slide
- Add a "before the next slide, try to…" prompt

### Step 5.3 — Distribution check

Engagement points should be **spread**, not clustered. Aim for at least one in each third of the lecture:
- Early third: recall from prior lecture
- Middle third: check-for-understanding on the first unit
- Late third: synthesis or integrative check

### Step 5.4 — ★ STOP AND CONFIRM ★

Show the engagement audit and any proposed additions. Ask the user if the active-learning density feels right for the cohort and format.

### Phase 5 Checklist

- [ ] At least 4–5 engagement points for a 50-min lecture
- [ ] At least one engagement type per unit
- [ ] Opening has a recall prompt
- [ ] Closing has a summary + preview
- [ ] Engagement points are spread across the lecture
- [ ] User has approved the engagement design

---

## Phase 6: Polish + Dual Export

**Goal**: Apply visual styling, produce both a lecture version and a handout version.

### Step 6.1 — Apply theme

**Default for teaching: Light theme.** Classrooms and lecture halls are typically lit, projectors vary in quality, and students need to read from the back. Dark theme is acceptable for evening classes or recorded video formats.

Paste the light-theme CSS from the Theme System section.

### Step 6.2 — Configure the `advanced` class (if mixed cohort)

The light-theme CSS in this skill already includes the `section.advanced` rule. If you used a different theme or removed it, add back:

```css
section.advanced {
  background: linear-gradient(to right, var(--card) 0%, var(--card) 8px, var(--dark) 8px);
}
section.advanced h1::before {
  content: "★ ADVANCED";
  color: var(--yellow);
  font-size: 0.5em;
  letter-spacing: 0.15em;
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
}
```

Then mark advanced slides with `<!-- _class: advanced -->`.

### Step 6.3 — Typographic and layout polish

- **Consistent fonts**: one for headings, one for body, one for monospace/technical content (if used)
- **Consistent color use**: main + one accent. Semantic colors (green/red/yellow) used the same way throughout
- **Consistent spacing**: titles, footers, pagination in same position on every slide
- **Equation rendering**: if the subject uses math, confirm `math: mathjax` in front matter

### Step 6.4 — Readability checks

- **Back-of-room test**: Zoom out or step 3m back. Body text and any technical content (equations, tables, diagrams) must remain readable.
- **Handout test**: Export PDF. Does each slide make sense without hearing the instructor? If not, expand speaker notes and ensure the handout version renders them.
- **Grayscale test**: View PDF in grayscale. Any color-only distinctions should still be distinguishable via shape, position, or weight.
- **Colorblind safety**: Avoid red-green as the only distinguisher in figures.

### Step 6.5 — Export BOTH versions

Teaching decks benefit from two PDF outputs:

**Lecture version** — clean slides for projection:
```bash
npx @marp-team/marp-cli lecture.md --pdf --allow-local-files -o lecture.pdf
npx @marp-team/marp-cli lecture.md --html --allow-local-files -o lecture.html
```

**Handout version** — speaker notes included, for student self-study. Marp CLI does not render HTML comments as visible text by default. The cleanest approach:
1. Duplicate the `.md` file as `lecture_handout.md`
2. In the copy, convert `<!-- Speaker note: ... -->` blocks into visible markdown blockquotes:
   ```markdown
   > **Instructor notes**: [the speaker-note content]
   ```
3. Export the handout version as PDF:
   ```bash
   npx @marp-team/marp-cli lecture_handout.md --pdf --allow-local-files -o handout.pdf
   ```

Automate this conversion with a short `sed`/script step if the course will have many lectures.

### Step 6.6 — Persist the final deliverables

Call `artifact-create` with `type='tool-output'`, title `Lecture — <course code> <lecture N>: <topic>`, and store the final lecture Markdown. In the artifact body, record the paths of:
- Lecture `.md` source
- Handout `.md` source
- Lecture PDF + HTML
- Handout PDF

This makes the lecture discoverable via `artifact-search` next term and lets downstream revisions pick up where this session left off.

### Phase 6 Checklist

- [ ] Light theme applied (or dark if appropriate for the venue)
- [ ] Fonts, colors, spacing consistent across all slides
- [ ] Back-of-room test passed
- [ ] Handout test passed (slides stand alone with notes)
- [ ] Lecture PDF + HTML exported
- [ ] Handout PDF (with notes rendered) exported
- [ ] Final deck + handout persisted as tool-output artifact
- [ ] User has final deliverables

---

# REVISE MODE (Lightweight)

**Goal**: Improve an existing lecture without undoing the instructor's deliberate choices.

**Guiding principle**: Teaching decks embed the instructor's pedagogical choices — pacing, emphasis, chosen examples, analogies tuned to their specific cohort. Do not override these unless asked. Revise requests here are often feedback from having taught the lecture once ("this part confused students", "we ran out of time", "the second example didn't land").

## Core Rules

1. **Read the whole deck first** to understand the lesson arc before editing.
2. **Classify the request**:
   - **L1 — Surface**: Typos, factual errors, formatting. Just fix.
   - **L2 — Content**: Replace an example, rewrite an explanation, update a figure. Describe the planned change, then do it.
   - **L3 — Structural**: Add/remove units, change objectives, reorder sections. Confirm before executing.
3. **Preserve the instructor's voice and choices**. Keep phrasing, examples, and analogies unless explicitly told to change them. These are often tuned to the cohort.
4. **Report changes explicitly.** After edits, produce a short diff summary listing which slides changed and what changed on each — don't make the user hunt for differences. Format:
   ```
   Changes made:
   - Slide 5 (old title: "..."): Replaced worked example with a simpler variant; kept common-mistakes slide
   - Slide 9: Added approach-naming sentence before step-by-step; addresses "students got lost here"
   - Slide 14: Split into two slides (was over-dense); now slides 14 and 15
   ```
5. **If the user's request is vague** ("this part didn't work", "the middle felt off"), run the Quick Diagnosis Checklist below before editing.

## Slide reference convention

**Slide numbers are 1-indexed.** When the user says "slide 5" or "page 5," they mean the fifth slide they see — i.e., the fifth `---`-separated section, matching the pagination number in the rendered deck.

- Never silently translate to a zero-indexed array position.
- If there's any ambiguity (the user might be excluding the title slide, or counting units rather than slides), **ask once**: "To confirm: by 'slide 5' you mean the one currently showing page 5 in the bottom corner, which is titled '...'?"
- When reporting changes, use the same 1-indexed numbering the user sees.

## Quick Diagnosis Checklist (for vague requests)

When the user says something vague ("this part didn't work", "feels off"), run through this checklist and flag issues. Let the user choose what to fix.

**Lesson arc level**
- [ ] Review-previous slide present at start?
- [ ] Learning objectives stated explicitly?
- [ ] Each objective has a corresponding unit?
- [ ] Summary + preview at end?

**Per-unit level** (scan each unit)
- [ ] Concept introduced with definition + intuition + when-it-matters?
- [ ] Worked example present and complete (problem → approach → steps → answer → reflection)?
- [ ] Check-for-understanding slide present?
- [ ] Common-mistakes slide present?

**Density level**
- [ ] No slide has more than ~60 words of prose?
- [ ] No slide has more than ~15 lines of technical content?
- [ ] Tables ≤ 8 rows?
- [ ] Body text at 18pt+?

**Engagement level**
- [ ] ≥ 4 active-learning points in a 50-min lecture?
- [ ] Engagement spread across the lecture (not all clumped)?

Flag any failing items. Let the user select which to address.

## Common Revise Requests

| Request | Classification | Action |
|---------|---------------|--------|
| "Students got lost at [topic]" | L2 vague | Diagnose that unit's worked example; propose a clearer approach slide or additional scaffolding |
| "Add a slide on [new concept]" | L3 | Ask: which unit? what objective does it support? worked example needed? |
| "This is too long for 50 min" | L2/L3 | Identify cuttable content: reduce a worked example, move a unit to pre-class reading, cut a secondary concept, or move supplementary slides to backup |
| "Update this content — the convention / definition has changed" | L1/L2 | Apply the update, check for downstream references in other slides |
| "First unit too easy, second too hard" | L3 | Propose rebalancing: move material between units, or adjust Bloom level of objectives |
| "Add more exercises" | L2 | Confirm which units, which engagement type (predict / spot-the-error / apply-to-variant) |
| "Make the slides work as a handout without me speaking" | L3 | Expand in-slide prose under figures/examples, expand common-mistakes slides to explain each misconception fully, ensure handout export renders notes |
| "Change the examples to fit a different cohort" | L2/L3 | Confirm cohort and level, swap examples while keeping concept scaffolding |

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
<!-- _class: advanced -->        # advanced/optional marker (needs CSS defined)
<!-- _backgroundColor: #000 -->  # override background (this slide only)
<!-- header: "Unit 2" -->        # persistent header (until redefined)
<!-- footer: "Course X, Lec 5" --> # persistent footer
```

### Images and figures

```markdown
![w:400](figure.png)              # fixed width
![h:300](figure.png)              # fixed height
![bg](image.jpg)                  # full background
![bg right:40%](image.jpg)        # split layout, image right 40%
![bg left:35%](image.jpg)         # split layout, image left 35%
![bg contain](image.jpg)          # fit without cropping
```

### Math

```markdown
Inline: $f(x) = ax + b$

Block:
$$
\int_{a}^{b} f(x)\, dx = F(b) - F(a)
$$
```

**Critical pitfall — math inside HTML containers**: Marp's MathJax/KaTeX plugin is a markdown-it tokenizer plugin. It can only render math that markdown-it actually tokenizes. Per CommonMark, content inside a **single-line** HTML block tag is treated as literal text and never re-parsed as Markdown, so the `$...$` never reaches the math plugin and prints as raw dollar signs in the PDF.

This fails silently — there is no warning, just literal `$` characters in the output. Teaching slides frequently use grid layouts for concept cards, worked-example blocks, and comparison tables — if any of those contain math, you MUST use one of these patterns:

```html
<!-- ❌ BROKEN: math on same line as the <div> tag — will NOT render -->
<div class="card"><strong>$f'(x) = \lim_{h \to 0} \frac{f(x+h)-f(x)}{h}$</strong></div>

<!-- ✅ FIX A: blank lines inside <div> force markdown-it to re-parse -->
<div class="card">

**$f'(x) = \lim_{h \to 0} \frac{f(x+h)-f(x)}{h}$**

</div>

<!-- ✅ FIX B: put block math outside the container; keep only non-math content in the grid -->
<div class="card">
<div class="label">Definition</div>
</div>

$$f'(x) = \lim_{h \to 0} \frac{f(x+h)-f(x)}{h}$$
```

Rule: **whenever a slide has both a `<div>`-based layout and LaTeX math, write the math on its own line with a blank line separating it from the surrounding HTML tags.** Or write the whole slide in pure Markdown without grid containers — inline `$...$` and block `$$...$$` always render correctly in plain Markdown context.

Short exponents like `K=10⁻³` can be written with Unicode superscripts as a last resort in tight layouts, but lose LaTeX fidelity — only acceptable for trivial cases. Worked-example step-by-step derivations should always use proper LaTeX so students can re-read notation correctly.

## Light Theme CSS (default for teaching)

```yaml
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  :root {
    --accent: #2563eb;
    --dark: #f8fafc;
    --card: #ffffff;
    --border: #e2e8f0;
    --body: #334155;
    --label: #64748b;
    --muted: #94a3b8;
    --light: #0f172a;
    --green: #16a34a;
    --red: #dc2626;
    --yellow: #ca8a04;
    --code-bg: #f1f5f9;
  }
  section {
    background: var(--dark);
    color: var(--light);
    font-family: 'Inter', sans-serif;
    font-weight: 400;
    padding: 40px 56px;
    font-size: 22px;
  }
  section.lead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    text-align: center;
  }
  section.advanced {
    background: linear-gradient(to right, var(--card) 0%, var(--card) 6px, var(--dark) 6px);
  }
  section.advanced h1::before {
    content: "★ ADVANCED";
    color: var(--yellow);
    font-size: 0.45em;
    letter-spacing: 0.15em;
    display: block;
    margin-bottom: 10px;
    font-weight: 600;
  }
  h1 { font-weight: 700; font-size: 1.8em; color: var(--light); margin-bottom: 0.3em; line-height: 1.25; }
  h2 { font-weight: 600; font-size: 1.2em; color: var(--body); margin-top: 0.6em; }
  h3 { font-weight: 600; font-size: 0.9em; color: var(--accent); margin-top: 0.8em; }
  p, li { color: var(--body); line-height: 1.55; }
  strong { color: var(--light); font-weight: 600; }
  em { color: var(--accent); font-style: normal; font-weight: 500; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.88em; background: var(--code-bg); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); color: var(--light); }
  pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px 18px; font-size: 0.85em; line-height: 1.5; }
  pre code { background: transparent; border: none; padding: 0; font-size: 1em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88em; margin: 12px 0; }
  th { color: var(--label); font-weight: 600; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); padding: 8px 10px; text-align: left; }
  td { color: var(--body); border-bottom: 1px solid var(--border); padding: 8px 10px; }
  blockquote { border-left: 4px solid var(--accent); padding: 4px 16px; color: var(--body); background: var(--code-bg); margin: 12px 0; }
  footer { color: var(--label); font-size: 0.6em; }
```

## Slide Templates

All templates use domain-neutral placeholders. Replace bracketed content with material from the actual subject the user is teaching.

### Title slide

```markdown
<!-- _class: lead -->
<!-- _paginate: false -->

# [Lecture Topic]
## [Course Code] — Lecture [N]

**[Instructor Name]**
*[Term] [Year] — [Institution]*
```

### Today's objectives slide

```markdown
# Today you will be able to…

1. **[Action verb]** [specific outcome]
2. **[Action verb]** [specific outcome]
3. **[Action verb]** [specific outcome]
4. **[Action verb]** [specific outcome]

> By the end, you should be able to [concrete capability tied to assessment or next lecture].
```

### Review-previous-lecture slide

```markdown
# Where we left off: [last lecture's main topic]

**Last lecture we established:**
- [key claim 1]
- [key claim 2]
- [key claim 3]

**Today we'll see how this leads to [today's topic].**
```

### Prerequisite recall

```markdown
# Quick recall: [prerequisite concept]

A **[concept]** is [one-sentence working definition].

[Optional: a short illustrative instance or a minimal formula / diagram, kept to what's needed for today.]

*If you're not sure, revisit [specific reference] before next class.*
```

### Concept introduction

```markdown
# [Concept name]

**Definition**
A *[concept]* is [precise one-sentence definition].

**Intuition**
[One analogy or informal explanation that connects to something the audience already understands.]

**When it matters**
[A concrete setting where this concept is essential — makes it memorable and anchors future recall.]
```

### Worked example (generic template)

```markdown
# Worked example: [problem name]

### Problem
[State precisely what is given and what is to be found or shown.]

### Approach
[The key insight or technique — one or two sentences. Naming the approach before doing the work is crucial.]

### Step-by-step
1. [First step with justification]
2. [Second step]
3. [... continue, split across slides if long]
4. [Final step producing the answer]

### Answer
**[Final result, clearly marked.]**

### Why this works
[Connect back to the concept. Note key assumptions, and when the approach generalizes or fails.]
```

### Check-for-understanding (predict/reason)

```markdown
# Check: predict [quantity / behavior / outcome]

Given [setup], what is [quantity of interest]?

- A) [option]
- B) [option]
- C) [option]
- D) [option]

<!-- Give 30–60 seconds. Answer: [answer]. Common wrong answer: [option + why students pick it]. -->
```

### Check-for-understanding (spot the error)

```markdown
# Check: what's wrong here?

[Present a short attempted solution, derivation, or argument with a subtle error embedded.]

Where does it fail, and why?

<!-- The error is at [location]. Students often miss it because [reason]. Good teachable moment for [concept]. -->
```

### Common mistakes

```markdown
# Common mistakes with [concept]

**❌ "[Plausible but wrong statement]"**
→ [Why it's wrong, in one sentence. Correct statement.]

**❌ "[Second misconception — often a confusion with a related concept]"**
→ [Distinction made explicit.]

**❌ "[Third misconception — often an over-generalization]"**
→ [Scope of validity clarified.]
```

### Synthesis slide

```markdown
# How today's concepts connect

[Unit A] and [Unit B] are both instances of [general framework], differing in [one key dimension].

| Aspect | [Unit A] | [Unit B] |
|--------|----------|----------|
| [dimension 1] | [value] | [value] |
| [dimension 2] | [value] | [value] |
| [when to use] | [scenario A] | [scenario B] |

**Key insight:** [the connection in one sentence.]
```

### Summary + preview

```markdown
# Summary: what you should now be able to do

✔ [Objective 1, restated]
✔ [Objective 2, restated]
✔ [Objective 3, restated]
✔ [Objective 4, restated]

### Next lecture
**[Next topic]** — we'll extend today's ideas to [direction].

### Before then
[Readings, assignments, problems to attempt.]
```

## Common Failure Modes

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Students can't follow the worked example | Jumped to steps without stating the approach | Add a slide naming the key insight before the step-by-step |
| Lecture runs long | Too many objectives or over-deep worked examples | Cut an objective; move one worked example to pre-class reading |
| Students guess instead of reason on checks | Check came before the concept was fully explained | Move the check after concept + worked example |
| Technical content illegible from back row | Font too small or content too dense | Enforce minimum font sizes; split dense slides |
| Students re-read but don't understand | Slides too sparse for standalone reading; no notes exported | Ensure handout version renders speaker notes; expand prose under visuals |
| Same misconception appears every term | No dedicated common-mistakes slide | Add one explicit slide per major concept |
| Engagement drops in the middle | All engagement points at start and end | Redistribute checks across the lecture |
| Math renders as literal `$...$` in PDF | `$...$` is inside a single-line HTML block tag (e.g., `<div class="card">...$x$...</div>`), so markdown-it never tokenizes it | Add blank lines inside the `<div>` around the math, OR move block `$$...$$` outside the container. See Math section for the canonical fix. |

## Export Reference

```bash
# Live preview during authoring
npx @marp-team/marp-cli lecture.md --watch --html --allow-local-files

# Lecture version (slides only)
npx @marp-team/marp-cli lecture.md --pdf --allow-local-files -o lecture.pdf
npx @marp-team/marp-cli lecture.md --html --allow-local-files -o lecture.html

# Handout version (speaker notes rendered as visible text)
# Steps:
#   1. cp lecture.md lecture_handout.md
#   2. Convert <!-- Speaker note: ... --> into > **Instructor notes**: ... blockquotes
#   3. Export:
npx @marp-team/marp-cli lecture_handout.md --pdf --allow-local-files -o handout.pdf
```

## Integration with Other Skills and Tools

| Task | Combine with |
|------|-------------|
| Concept diagrams / schematics | `scientific-schematics` → SVG → embed |
| Publication-quality figures for intuition slides | `scientific-visualization` → PNG/SVG → embed |
| Custom low-level plots | `matplotlib` or `seaborn` → PNG/SVG → embed |
| Ingest syllabus / textbook / prior slides | `convert-document` tool on PDF/DOCX → use as Context Gate input |
| Live-compute demos and demo-data plots | `data-analyze` tool → plot + code for a demo slide |
| Course data (grades, survey) for revisions | `data-analyze` tool → feed findings into Revise Mode |
| References / Further Reading slide | `literature-search` tool → populate a backup slide; also a quick tier-2 scan in Context Gate for research-adjacent lectures |
| Find prior course material in workspace | `ls` + `find` on user-provided paths (tier 1); `artifact-search` on `notes`/`papers` for saved notes |
| Long-lived course preferences (notation, recurring misconceptions, instructor voice) | Read `.research-pilot/memory/MEMORY.md` + linked files during Context Gate (tier 1) |
| Paper knowledge base lookups (graduate seminars) | `wiki_search` / `wiki_get` during Context Gate (tier 1, optional) |
| Online fill-ins (updated conventions, authoritative definitions) | `web_search` / `web_fetch` as tier-3 fallback only |
| Persist lecture plan and final deck | `artifact-create` with `type='note'` (Phase 1) and `type='tool-output'` (Phase 6) |
| Sister skill for research talks | `academic-marp-slides` — use for conference talks, invited talks, defenses |

---

## Final Reminder

Teaching slides succeed when a student can **re-read them alone** a week later and still learn from them. That's the single most important test — more than any visual polish. Worked examples and common-mistakes slides carry most of the weight. Respect the student's time and the instructor's voice.
