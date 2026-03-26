---
name: paper-writing
description: "Write publication-ready ML/AI/Systems conference papers (NeurIPS, ICML, ICLR, ACL, AAAI, COLM, OSDI, NSDI, ASPLOS, SOSP). Use when the user requests a conference manuscript, needs conference-specific templates/checklists, or format conversion between venues. For journal articles or technical reports, use scientific-writing instead."
category: Writing & Review
depends: [rewrite-humanize]
tags: [Academic Writing, NeurIPS, ICML, ICLR, ACL, AAAI, COLM, OSDI, NSDI, ASPLOS, SOSP, LaTeX, Paper Writing, Citations, Research, Systems]
triggers: [write paper, conference paper, NeurIPS, ICML, ICLR, ACL, AAAI, COLM, OSDI, NSDI, ASPLOS, SOSP, submit paper, draft paper, LaTeX paper, 写论文, 投稿, 会议论文]
---

# ML Paper Writing for Top AI & Systems Conferences

Expert-level guidance for writing publication-ready papers targeting **NeurIPS, ICML, ICLR, ACL, AAAI, COLM** (ML/AI venues) and **OSDI, NSDI, ASPLOS, SOSP** (Systems venues). This skill combines writing philosophy from top researchers (Nanda, Farquhar, Karpathy, Lipton, Steinhardt) with practical tools: LaTeX templates, citation verification, and conference checklists.

## Overview

This skill covers the full lifecycle of conference paper writing: from assembling research findings into a narrative, through drafting each section, to citation verification and conference-specific formatting. It is designed for CS/AI/Systems conferences with double-blind review, strict page limits, and LaTeX requirements.

## When to Use This Skill

- The user explicitly requests a conference paper (e.g., "write a NeurIPS submission", "prepare an OSDI paper").
- You are working on a writing task targeting a specific CS/AI/Systems conference.
- You need conference-specific LaTeX templates, formatting checklists, or reviewer criteria.
- You are converting a manuscript between conference formats (e.g., NeurIPS → ICML resubmission).

**Do NOT use this skill when**:
- Research is still in progress — finish experiments and analysis first.
- You need a literature survey — use the `literature-search` tool.
- You need to brainstorm research directions — use `brainstorming-research-ideas` or `creative-thinking-for-research`.
- You are writing a **journal article** (Nature, Science, NEJM, etc.), **technical report**, or **research summary** — use `scientific-writing` instead, which covers IMRAD structure, journal-specific citation styles (APA/AMA/Vancouver), and reporting guidelines (CONSORT/STROBE/PRISMA).

### paper-writing vs scientific-writing: Which to Use

| Target Output | Use This Skill | Why |
|--------------|----------------|-----|
| CS/AI/Systems conference paper (NeurIPS, ICML, OSDI, etc.) | `paper-writing` | Conference-specific templates, ML writing philosophy, reviewer guidelines, page limits |
| Journal article (Nature, Science, PNAS, NEJM, etc.) | `scientific-writing` | IMRAD structure, journal citation styles, reporting guidelines, discipline-specific terminology |
| Technical report, white paper, grant report | `scientific-writing` | Professional report formatting |

If the venue is ambiguous, ask the user before proceeding.

---

## CRITICAL: Never Hallucinate Citations

**This is the most important rule in academic writing.**

### The Problem
AI-generated citations have a **~40% error rate**. Hallucinated references — papers that don't exist, wrong authors, incorrect years, fabricated DOIs — are serious academic misconduct that can result in desk rejection or retraction.

### The Rule
**NEVER generate BibTeX entries from memory. ALWAYS verify programmatically.**

| Action | Correct | Wrong |
|--------|---------|-------|
| Adding a citation | Search via `literature-search` or `web-search` → verify → fetch BibTeX | Write BibTeX from memory |
| Uncertain about a paper | Mark as `[CITATION NEEDED]` | Guess the reference |
| Can't find exact paper | Note: "placeholder - verify" | Invent similar-sounding paper |

### When You Cannot Verify a Citation

```latex
% EXPLICIT PLACEHOLDER - requires user verification
\cite{PLACEHOLDER_author2024_verify_this}  % TODO: Verify this citation exists
```

Flag all placeholder citations when presenting the draft to the user.

---

## Workflow: From Research to Paper

### Phase 0: Assemble the Narrative

Before writing, gather your materials:

1. **Review existing artifacts**: Search note and data artifacts in the workspace for key findings, experimental results, and conclusions from prior research sessions.
2. **Identify contribution claims**: What changed in understanding as a result of this research? These become the paper's contribution claims.
3. **Collect supporting evidence**: Identify key experimental results, figures, and data that support each claim.
4. **Review collected literature**: Use `literature-search` and check existing paper artifacts. These become Related Work citations.
5. **Identify the target venue**: If the user specified a venue, use that. If not, propose a venue with rationale and ask for confirmation.

Save a synthesis document as a note artifact before starting to write.

### Phase 1: Define the One-Sentence Contribution

Distill the accumulated findings into a single contribution statement:

- What is the single thing this research contributes?
- What was not obvious or present before this work?

Write this as the first line of the paper's working document. If the contribution is unclear from the evidence, flag this to the user — the research may not be ready for a paper yet.

### Phase 2: Draft the Paper

Write sections as .tex files in the workspace using the appropriate conference template.

**Writing order**:

```
1. Copy conference template to workspace (from @skill/templates/)
2. Draft Figure 1 — core idea or most compelling result
3. Draft Abstract (5-sentence formula)
4. Draft Introduction (1-1.5 pages max)
5. Draft Methods / System Design
6. Draft Experiments / Evaluation
7. Draft Related Work (from collected literature)
8. Draft Limitations
9. Complete conference checklist
10. Self-review pass
```

### Phase 3: Citation Assembly

Build the bibliography from verified sources:

1. **Primary source**: Paper artifacts already collected via `literature-search` across sessions. These are pre-verified.
2. **Fill gaps**: Use `literature-search` and `web-search` for any additional citations needed (e.g., baselines mentioned in experiments, recent concurrent work).
3. **Verify all entries**: Every citation in the .bib file must have a DOI or arXiv ID. No exceptions.
4. **Mark unknowns**: If a citation cannot be verified, mark it as `[PLACEHOLDER - VERIFY]` and flag it explicitly.

See @skill/references/citation-workflow.md for API details if you need to verify entries beyond what the tools provide.

### Phase 4: Review and Deliver

Once the full draft is complete:

1. Perform a self-review against the checklist below
2. Save the .tex file as an artifact
3. Present the draft to the user with:
   - Summary of the paper's contribution and target venue
   - List of any placeholder citations requiring verification
   - Key areas where user input is needed

---

## The Narrative Principle

**The single most critical insight**: Your paper is not a collection of experiments — it's a story with one clear contribution supported by evidence.

Every successful ML paper centers on what Neel Nanda calls "the narrative": a short, rigorous, evidence-based technical story with a takeaway readers care about.

**Three Pillars (must be crystal clear by end of introduction):**

| Pillar | Description |
|--------|-------------|
| **The What** | 1-3 specific novel claims within a cohesive theme |
| **The Why** | Rigorous empirical evidence supporting claims |
| **The So What** | Why readers should care |

**If you cannot state your contribution in one sentence, you don't yet have a paper.**

---

## Paper Structure Guide

### Writing the Abstract (5-Sentence Formula)

From Sebastian Farquhar (DeepMind):

```
1. What you achieved: "We introduce...", "We prove...", "We demonstrate..."
2. Why this is hard and important
3. How you do it (with specialist keywords for discoverability)
4. What evidence you have
5. Your most remarkable number/result
```

**Delete** generic openings like "Large language models have achieved remarkable success..."

### Writing the Introduction (1-1.5 pages max)

Must include:
- 2-4 bullet contribution list (max 1-2 lines each in two-column format)
- Clear problem statement
- Brief approach overview
- Methods should start by page 2-3 maximum

### Writing the Methods Section

Enable reimplementation:
- Conceptual outline or pseudocode
- All hyperparameters listed
- Architectural details sufficient for reproduction
- Present final design decisions; ablations go in experiments

### Writing the Experiments Section

For each experiment, explicitly state:
- What claim it supports
- How it connects to main contribution
- Experimental setting (details in appendix)
- What to observe: "the blue line shows X, which demonstrates Y"

Requirements:
- Error bars with methodology (standard deviation vs standard error)
- Hyperparameter search ranges
- Compute infrastructure (GPU type, total hours)
- Seed-setting methods

### Writing Related Work

Organize methodologically, not paper-by-paper:

**Good:** "One line of work uses Floogledoodle's assumption [refs] whereas we use Doobersnoddle's assumption because..."

**Bad:** "Snap et al. introduced X while Crackle et al. introduced Y."

Draw primarily from collected paper artifacts. Cite generously — reviewers likely authored relevant papers.

### Writing the Limitations Section (REQUIRED)

All major conferences require this. Counter-intuitively, honesty helps:
- Reviewers are instructed not to penalize honest limitation acknowledgment
- Pre-empt criticisms by identifying weaknesses first
- Explain why limitations don't undermine core claims

---

## Writing Philosophy for Top ML Conferences

### The Sources Behind This Guidance

| Source | Key Contribution |
|--------|-----------------|
| **Neel Nanda** (Google DeepMind) | The Narrative Principle, What/Why/So What framework |
| **Sebastian Farquhar** (DeepMind) | 5-sentence abstract formula |
| **Gopen & Swan** | 7 principles of reader expectations |
| **Zachary Lipton** | Word choice, eliminating hedging |
| **Jacob Steinhardt** (UC Berkeley) | Precision, consistent terminology |
| **Ethan Perez** (Anthropic) | Micro-level clarity tips |
| **Andrej Karpathy** | Single contribution focus |

**For deeper dives:** See @skill/references/writing-guide.md and @skill/references/sources.md.

### Time Allocation (From Neel Nanda)

Spend approximately **equal time** on each of:
1. The abstract
2. The introduction
3. The figures
4. Everything else combined

**Why?** Most reviewers form judgments before reaching your methods. Readers encounter your paper as: **title → abstract → introduction → figures → maybe the rest.**

### Writing Style Guidelines

#### Sentence-Level Clarity (Gopen & Swan's 7 Principles)

| Principle | Rule | Example |
|-----------|------|---------|
| **Subject-verb proximity** | Keep subject and verb close | "The model, which was trained on..., achieves" → "The model achieves... after training on..." |
| **Stress position** | Place emphasis at sentence ends | "Accuracy improves by 15% when using attention" → "When using attention, accuracy improves by **15%**" |
| **Topic position** | Put context first, new info after | "Given these constraints, we propose..." |
| **Old before new** | Familiar info → unfamiliar info | Link backward, then introduce new |
| **One unit, one function** | Each paragraph makes one point | Split multi-point paragraphs |
| **Action in verb** | Use verbs, not nominalizations | "We performed an analysis" → "We analyzed" |
| **Context before new** | Set stage before presenting | Explain before showing equation |

**Full 7 principles with detailed examples:** See @skill/references/writing-guide.md.

#### Micro-Level Tips (Ethan Perez)

- **Minimize pronouns**: "This shows..." → "This result shows..."
- **Verbs early**: Position verbs near sentence start
- **Unfold apostrophes**: "X's Y" → "The Y of X" (when awkward)
- **Delete filler words**: "actually," "a bit," "very," "really," "basically," "quite," "essentially"

#### Word Choice (Zachary Lipton)

- **Be specific**: "performance" → "accuracy" or "latency" (say what you mean)
- **Eliminate hedging**: Drop "may" and "can" unless genuinely uncertain
- **Avoid incremental vocabulary**: "combine," "modify," "expand" → "develop," "propose," "introduce"
- **Delete intensifiers**: "provides *very* tight approximation" → "provides tight approximation"

#### Precision Over Brevity (Jacob Steinhardt)

- **Consistent terminology**: Different terms for same concept creates confusion. Pick one and stick with it.
- **State assumptions formally**: Before theorems, list all assumptions explicitly
- **Intuition + rigor**: Provide intuitive explanations alongside formal proofs

---

## Conference Requirements Quick Reference

### ML/AI Conferences

| Conference | Page Limit | Extra for Camera-Ready | Key Requirement |
|------------|------------|------------------------|------------------|
| **NeurIPS 2025** | 9 pages | +0 | Mandatory checklist, lay summary for accepted |
| **ICML 2026** | 8 pages | +1 | Broader Impact Statement required |
| **ICLR 2026** | 9 pages | +1 | LLM disclosure required, reciprocal reviewing |
| **ACL 2025** | 8 pages (long) | varies | Limitations section mandatory |
| **AAAI 2026** | 7 pages | +1 | Strict style file adherence |
| **COLM 2025** | 9 pages | +1 | Focus on language models |

### Systems Conferences

| Conference | Page Limit | Extra for Camera-Ready | Key Requirement | Template |
|------------|------------|------------------------|-----------------|----------|
| **OSDI 2026** | 12 pages | +2 (14 pages) | Research + Operational Systems tracks | USENIX |
| **NSDI 2027** | 12 pages | varies | Prescreening via Introduction; 3 tracks | USENIX |
| **ASPLOS 2027** | 12 pages (ACM) | varies | Rapid review on first 2 pages; dual cycles | ACM SIGPLAN |
| **SOSP 2026** | 12 pages | varies | Optional artifact evaluation; author response | ACM SIGPLAN |

**Detailed Systems conference info**: See @skill/references/systems-conferences.md.

**Universal Requirements:**
- Double-blind review (anonymize submissions)
- References don't count toward page limit
- Appendices unlimited but reviewers not required to read
- LaTeX required for all venues
- **Systems venues**: USENIX uses custom `.sty`; ACM uses `acmart.cls`

**LaTeX Templates:** See @skill/templates/ directory for all conference templates.

---

## Using LaTeX Templates

### Setting Up from Template

**Always copy the entire template directory first, then write within it.**

```bash
# Copy template to workspace
cp -r @skill/templates/neurips2025/ paper/
cd paper/

# Verify template compiles as-is before any changes
latexmk -pdf main.tex
```

**Copy the ENTIRE directory**, not just `main.tex`. Templates include style files (`.sty`), bibliography styles (`.bst`), and Makefiles.

### Template Quick Reference

#### ML/AI Conferences

| Conference | Main File | Key Style File |
|------------|-----------|----------------|
| NeurIPS 2025 | `main.tex` | `neurips.sty` |
| ICML 2026 | `example_paper.tex` | `icml2026.sty` |
| ICLR 2026 | `iclr2026_conference.tex` | `iclr2026_conference.sty` |
| ACL | `acl_latex.tex` | `acl.sty` |
| AAAI 2026 | `aaai2026-unified-template.tex` | `aaai2026.sty` |
| COLM 2025 | `colm2025_conference.tex` | `colm2025_conference.sty` |

#### Systems Conferences

| Conference | Main File | Key Style File |
|------------|-----------|----------------|
| OSDI 2026 | `main.tex` | `usenix-2020-09.sty` |
| NSDI 2027 | `main.tex` | `usenix-2020-09.sty` |
| ASPLOS 2027 | `main.tex` | `acmart.cls` (`sigplan`) |
| SOSP 2026 | `main.tex` | `acmart.cls` (`sigplan`) |

### Template Pitfalls to Avoid

| Pitfall | Problem | Solution |
|---------|---------|----------|
| Copying only `main.tex` | Missing `.sty`, won't compile | Copy entire directory |
| Modifying `.sty` files | Breaks conference formatting | Never edit style files |
| Adding random packages | Conflicts, breaks template | Only add if necessary |
| Not compiling frequently | Errors accumulate | Compile after each section |

---

## Conference Resubmission & Format Conversion

When a paper is rejected or withdrawn from one venue and resubmitted to another.

### Key Template Differences

#### ML/AI Conversions

| From → To | Page Change | Key Adjustments |
|-----------|-------------|------------------|
| NeurIPS → ICML | 9 → 8 pages | Cut 1 page, add Broader Impact if missing |
| ICML → ICLR | 8 → 9 pages | Can expand experiments, add LLM disclosure |
| NeurIPS → ACL | 9 → 8 pages | Restructure for NLP conventions, add Limitations |
| ICLR → AAAI | 9 → 7 pages | Significant cuts needed, strict style adherence |
| Any → COLM | varies → 9 | Reframe for language model focus |

#### Systems Conference Conversions

| From → To | Key Adjustments |
|-----------|------------------|
| ML → OSDI/NSDI | USENIX template; add system design + implementation sections |
| ML → ASPLOS/SOSP | ACM SIGPLAN template; reframe for systems contribution |
| OSDI ↔ SOSP | USENIX ↔ ACM SIGPLAN; similar page limits, different style files |

**Full conversion guide**: See @skill/references/systems-conferences.md.

### Content Migration (NOT Template Merge)

**Never copy LaTeX preambles between templates.** Instead:

1. Start fresh with target template
2. Copy ONLY content sections from old paper (between `\section{}` commands)
3. Copy figures, tables, bibliography entries
4. Paste into target template structure

### Addressing Previous Reviews

When resubmitting after rejection:
- **Do** address reviewer concerns in the new version
- **Do** add experiments/clarifications reviewers requested
- **Don't** include a "changes from previous submission" section (blind review)
- **Don't** reference the previous submission or reviews

---

## Self-Review Checklist

Before presenting the draft to the user, verify:

**Narrative:**
- [ ] Can state contribution in one sentence
- [ ] Three pillars (What/Why/So What) clear in intro
- [ ] Every experiment supports a specific claim

**Structure:**
- [ ] Abstract follows 5-sentence formula
- [ ] Introduction ≤ 1.5 pages
- [ ] Methods start by page 2-3
- [ ] 2-4 contribution bullets included
- [ ] Limitations section present

**Writing:**
- [ ] Consistent terminology throughout
- [ ] No generic opening sentences
- [ ] Hedging removed unless necessary
- [ ] All figures have self-contained captions

**Technical:**
- [ ] All citations verified via `literature-search` (no memory-generated BibTeX)
- [ ] Error bars included with methodology
- [ ] Compute resources documented
- [ ] Code/data availability stated

**Conference-specific:**
- [ ] Correct template used
- [ ] Within page limit
- [ ] Double-blind anonymization
- [ ] Required checklist completed (see @skill/references/checklists.md)

---

## Reviewer Evaluation Criteria

Reviewers assess papers on four dimensions:

| Criterion | What Reviewers Look For |
|-----------|------------------------|
| **Quality** | Technical soundness, well-supported claims |
| **Clarity** | Clear writing, reproducible by experts |
| **Significance** | Community impact, advances understanding |
| **Originality** | New insights (doesn't require new method) |

**Scoring (NeurIPS 6-point scale):**
- 6: Strong Accept — Groundbreaking, flawless
- 5: Accept — Technically solid, high impact
- 4: Borderline Accept — Solid, limited evaluation
- 3: Borderline Reject — Solid but weaknesses outweigh
- 2: Reject — Technical flaws
- 1: Strong Reject — Known results or ethics issues

See @skill/references/reviewer-guidelines.md for detailed reviewer instructions.

---

## Tables and Figures

### Tables

Use `booktabs` LaTeX package for professional tables:

```latex
\usepackage{booktabs}
\begin{tabular}{lcc}
\toprule
Method & Accuracy ↑ & Latency ↓ \\
\midrule
Baseline & 85.2 & 45ms \\
\textbf{Ours} & \textbf{92.1} & 38ms \\
\bottomrule
\end{tabular}
```

**Rules:**
- Bold best value per metric
- Include direction symbols (↑ higher is better, ↓ lower is better)
- Right-align numerical columns
- Consistent decimal precision

### Figures

- **Vector graphics** (PDF, EPS) for all plots and diagrams
- **Raster** (PNG 600 DPI) only for photographs
- Use **colorblind-safe palettes** (Okabe-Ito or Paul Tol)
- Verify **grayscale readability** (8% of men have color vision deficiency)
- **No title inside figure** — the caption serves this function
- **Self-contained captions** — reader should understand without main text

---

## Common Issues and Solutions

**Issue: Abstract too generic**
Delete first sentence if it could be prepended to any ML paper. Start with your specific contribution.

**Issue: Introduction exceeds 1.5 pages**
Split background into Related Work. Front-load contribution bullets. Methods should start by page 2-3.

**Issue: Experiments lack explicit claims**
Add sentence before each experiment: "This experiment tests whether [specific claim]..."

**Issue: Reviewers find paper hard to follow**
- Add explicit signposting: "In this section, we show X"
- Use consistent terminology throughout
- Include figure captions that stand alone

**Issue: Missing statistical significance**
Always include: error bars (specify: std dev or std error), number of runs, statistical tests if comparing methods.

---

## References & Resources

### Reference Documents (Deep Dives)

| Document | Contents |
|----------|----------|
| @skill/references/writing-guide.md | Gopen & Swan 7 principles, Ethan Perez micro-tips, word choice |
| @skill/references/citation-workflow.md | Citation APIs, Python code, BibTeX management |
| @skill/references/checklists.md | NeurIPS 16-item, ICML, ICLR, ACL requirements |
| @skill/references/reviewer-guidelines.md | Evaluation criteria, scoring, rebuttals |
| @skill/references/systems-conferences.md | OSDI/NSDI/ASPLOS/SOSP deadlines, tracks, rules |
| @skill/references/sources.md | Complete bibliography of all sources |

### LaTeX Templates

Templates in @skill/templates/ directory:
- **ML/AI**: ICML 2026, ICLR 2026, NeurIPS 2025, ACL/EMNLP, AAAI 2026, COLM 2025
- **Systems**: OSDI 2026, NSDI 2027, ASPLOS 2027, SOSP 2026

### Key External Sources

**Writing Philosophy:**
- Neel Nanda: How to Write ML Papers — Narrative, "What/Why/So What"
- Farquhar: How to Write ML Papers — 5-sentence abstract
- Gopen & Swan: Science of Scientific Writing — 7 reader expectation principles
- Lipton: Heuristics for Scientific Writing — Word choice
- Perez: Easy Paper Writing Tips — Micro-level clarity
