---
name: paper-revision
description: "Strategically revise an existing CS/AI/Systems conference paper draft for resubmission or submission readiness. Focuses on framing diagnosis, claim crystallization, narrative unification, evidence strengthening, reviewer defense, and venue-aware polish."
category: Writing & Review
depends: []
tags: [Paper Revision, Conference Paper, Resubmission, Reviewer Defense, Framing, LaTeX, Academic Writing, Systems, NeurIPS, ICML, OSDI, NSDI, ASPLOS, SOSP, SC]
triggers: [revise paper, improve paper, strengthen paper, paper revision, reframe paper, reviewer defense, improve draft, resubmit paper, camera-ready prep, 修改论文, 改论文, 论文修改, 论文返修, 返修投稿]
---

# Strategic Paper Revision

Systematic methodology for revising an existing paper draft to maximize acceptance probability at a target venue. This skill is for **strengthening a draft that already exists**, not for writing from scratch.

## Overview

Paper revision is fundamentally different from paper writing. Writing assembles findings into a narrative. Revision asks: *given what we have, what is the strongest defensible story, and how do we make it hardest for reviewers to reject?*

The core principle: **Reviewer-adversarial thinking drives all decisions.** Every revision choice — from framing to figure captions — should be evaluated by asking: "How would the most skeptical reviewer read this?"

This skill is optimized for conference-style peer review in CS/AI/Systems venues, where framing, reviewer defense, and claim-evidence alignment determine acceptance more than sentence-level polish alone.

## When to Use This Skill

Use this skill when:
- The user has an existing CS/AI/Systems conference paper draft and wants to strengthen it for a target venue
- A conference paper was rejected and needs strategic revision for resubmission
- The user wants to reframe the core contribution, strengthen evidence, or prepare reviewer defense

Do NOT use this skill when:
- No draft exists yet — use `paper-writing` instead
- The user only wants language polish without structural changes — use `rewrite-humanize` instead
- The user only wants an evaluation score — use `scholar-evaluation` instead
- The user is writing or revising a journal manuscript, technical report, or general scientific manuscript — use `scientific-writing` instead
- The user mainly needs literature collection or citation discovery — use the `literature-search` tool first

### paper-revision vs paper-writing: Which to Use

| Situation | Use This Skill | Why |
|-----------|---------------|-----|
| Have a draft, want to strengthen it | `paper-revision` | Strategic framing, claim alignment, reviewer defense |
| No draft yet, need to write from scratch | `paper-writing` | Narrative assembly, section drafting, template setup |
| Rejected paper, need to resubmit | `paper-revision` | Diagnose what went wrong, reframe, address reviews |
| Draft exists but only needs language cleanup | `rewrite-humanize` | Pure prose polish, no structural changes |

---

## How This Skill Is Used in Practice

**This skill is NOT a linear pipeline that must run end-to-end every time.** It is a structured toolbox with a recommended order. In practice, users enter at whatever phase matches their current need, work on that phase, and stop or continue as needed.

### Entry Point Detection

Determine which phase to enter based on the user's request:

| User says | Enter at | What to do |
|-----------|----------|------------|
| "Review this draft" / "How should I improve this paper?" / "Is this ready for SC?" | **Phase 1** | Full strategic diagnosis, then recommend next steps |
| "Is our core claim right?" / "How should we frame this?" / "Brainstorm framings" | **Phase 2** | Claim crystallization and framing selection |
| "Unify the narrative" / "Fix intro/abstract/conclusion" / "Make it consistent" | **Phase 3** | Propagate framing through all sections |
| "What evidence do we need?" / "Design an experiment" / "Add numbers" | **Phase 4** | Evidence audit and strengthening |
| "What will reviewers attack?" / "Add limitations" / "Reviewer defense" | **Phase 5** | Anticipate objections and write defenses |
| "Polish for SC" / "Remove AI tone" / "Final cleanup" | **Phase 6** | Venue-appropriate language polish (delegates to `rewrite-humanize`) |
| "Do a literature search for this paper" | **Use `literature-search` tool directly** | Then return to Phase 3 or 4 to integrate |

### Progressive Engagement

A typical revision unfolds over multiple conversations:

1. **First session:** Phase 1 diagnosis → user decides on framing direction
2. **Second session:** Phase 2-3, crystallize claim and propagate through intro/abstract
3. **Third session:** Phase 3 continued, unify methods/results/conclusion
4. **Fourth session:** Phase 4-5, strengthen evidence and add reviewer defense
5. **Final session:** Phase 6, language polish

But many sessions only touch one phase. That is normal and expected.

### After Each Phase

Always end with a concrete "suggested next step" so the user can decide whether to continue, jump to a different phase, or stop. Do not assume the user wants the full pipeline.

## Revision Philosophy

### Five axioms that govern all revision decisions

1. **Framing > Structure > Evidence > Language.** Fix the highest layer first. No amount of polish saves a misframed paper.

2. **One paper, one thesis.** Every section, subsection, figure, and table must serve a single identifiable main claim. If a component doesn't serve the thesis, it either needs repositioning or removal.

3. **Claim-evidence alignment.** Never let claims exceed evidence. A paper that claims less but proves it convincingly beats a paper that claims more but leaves gaps.

4. **Proactive defense beats reactive rebuttal.** Address likely attacks in the paper itself. Reviewer goodwill drops sharply between "they anticipated this" and "they didn't think of this."

5. **Minimum change, maximum persuasion.** The goal is not to rewrite the paper; it is to find the highest-leverage changes that shift reviewer perception from reject to accept.

---

## The Six-Phase Revision Workflow

### Phase 1: Strategic Diagnosis

**Goal:** Determine whether the paper's core claim is defensible at the target venue, and identify the strongest possible framing given existing evidence.

**Steps:**

1. **Read the full draft end-to-end.** Do not start revising until you understand the complete argument.

2. **Identify what the paper currently claims.** Extract:
   - The implicit thesis (what the paper acts like it's about)
   - The explicit thesis (what the contribution bullets say)
   - Whether these two match

3. **Stress-test the core claim.** Ask:
   - If the most hostile reviewer attacks the main claim, can it survive?
   - Is the claim too broad for the evidence? Too narrow to be interesting?
   - Is the claim positioned as the paper's strongest point, or is it buried?
   - Does the claim fit the target venue's values?

4. **Generate 2-3 alternative framings.** For each, evaluate:
   - How well does existing evidence support it?
   - How hard is it for reviewers to dismiss?
   - How relevant is it to the target venue's community?

5. **Select the strongest framing.** The best framing is the one where:
   - Existing evidence most directly supports the claim
   - The claim is hardest to decompose into "just integration" or "just incremental"
   - The venue's reviewers would find it most relevant

**Key pattern: The Gap Chain.**
For papers that risk being seen as "pipeline integration," crystallize the contribution as a chain of necessary conditions. Example:

> "Prior work solves A, B, and C separately. But the problem requires A+B+C+D simultaneously. Our contribution is not any single component, but the protocol that enforces all four conditions together."

This makes the novelty architectural rather than algorithmic, which is much harder for reviewers to dismiss.

**Key pattern: The Bottleneck Shift.**
For measurement/evaluation papers, organize findings not as parallel observations but as a unified mechanism:

> "The dominant bottleneck shifts from X on task type A, to Y on task type B, to Z on task type C."

This turns "three separate findings" into "one mechanistic result."

**Key pattern: Three-Layer Claim Hierarchy.**
When collaborators disagree about the core contribution, resolve it by separating:

- **Value layer** (what practical benefit does this deliver?)
- **Problem layer** (what problem does this solve, and using what resources?)
- **Mechanism layer** (what is the technical novelty that makes it work?)

All three layers should appear in the paper, but the mechanism layer is the defensible novelty, while the value layer is what makes reviewers care.

**When to delegate:**
- If the user wants a structured quality score before strategic diagnosis, use `scholar-evaluation` first, then return here to interpret the scores as revision priorities.
- If alternative framings need deeper exploration, use `brainstorming-research-ideas` (Tension Hunting, Stakeholder Rotation, and Simplicity Test lenses are most relevant).

**Output:** A written decision on the paper's revised framing, including the main thesis, contribution hierarchy, and what NOT to claim.

---

### Phase 2: Claim Crystallization

**Goal:** Compress the revised framing into precise, quotable language that will propagate through the entire paper.

**Steps:**

1. **Write the one-sentence thesis.** This sentence must be:
   - Specific enough that no prior work obviously satisfies it
   - Broad enough to capture the paper's full contribution
   - Stated in terms of what the paper *shows*, not what it *does*

2. **Write the contribution bullets (2-3 max).** Each bullet should be:
   - A falsifiable claim
   - Supported by a specific section of the paper
   - Not decomposable into "this existed before"

3. **Write the "what we do NOT claim" boundary.** This is critical for:
   - Preventing reviewer from attacking claims you never made
   - Demonstrating maturity and scope awareness
   - Pre-empting "overgeneralization" criticisms

4. **Define the key terminology.** Pick one term for each core concept and commit to it across the entire paper. Common revision failure: the same concept called three different things in different sections.

**Key pattern: Necessity Framing.**
For systems papers, the strongest claim form is often:

> "Deployment-facing X becomes possible only when conditions A, B, C, and D are enforced together."

This "only when enforced together" framing is much harder to attack than "we combine A, B, C, and D."

**Key pattern: Secondary Contribution Blending.**
When a secondary result (e.g., sample efficiency, cost reduction) matters but shouldn't dominate:

- Include it in the value layer of the hierarchy
- Give it one clear contribution bullet, positioned after the primary contribution
- Mention it in abstract/intro/conclusion, but never before the primary claim
- In evaluation, show it as a consequence of the primary mechanism, not a separate result

**Output:** Final thesis sentence, contribution bullets, scope boundary, and terminology glossary.

---

### Phase 3: Narrative Unification

**Goal:** Propagate the revised framing through every high-weight position in the paper, eliminating inconsistencies.

**Propagation order (do not skip steps):**

1. **Title.** Does it convey the right paper type? (Measurement study? Systems contribution? Benchmark?)

2. **Abstract.** Rewrite to match the new framing. The abstract should:
   - State the problem (not the solution) first
   - Position the contribution as the mechanism, not just the artifact
   - Include 2-3 key numbers for quantitative punch
   - End with practical significance, not just "we release X"

3. **Introduction.** This is where most revision energy should go. Check:
   - Does the opening paragraph establish why the problem matters?
   - Does the gap paragraph explain what's missing (not just "no one did this")?
   - Does the contribution paragraph match the crystallized claims?
   - Is there a clear forward pointer to the rest of the paper?

4. **Section openings.** Every section's first paragraph should answer: "What is this section's job in supporting the main thesis?"

5. **Methods/Design section.** Redefine each subsection's role:
   - Not "what component we built" but "what condition this enforces"
   - Not "how clever our algorithm is" but "why this step is necessary"

6. **Results/Evaluation section.** Rewrite the opening as a proof roadmap:
   - "We evaluate N questions: (1)... (2)... (3)..."
   - Each subsection should map to one question

7. **Related work.** The ending paragraph must create a gap statement that maps directly to your contribution bullets.

8. **Conclusion.** Structure as: what was missing → what we enforced → what we demonstrated → what remains.

**Key pattern: Section Role Redefinition.**
For each section, write a one-sentence "job description." Example:

- Methods section: "This section's job is not to describe benchmark components but to build measurement credibility."
- Evaluation section: "This section's job is not to rank agents but to isolate which design choices materially change reliability."

If a section's content doesn't match its job description, revise the content.

**Key pattern: Figure Captions as Narrative.**
Figure captions are often the most-read text after abstract and introduction. Revise captions to:
- Serve the main thesis, not just describe the figure
- Include the key takeaway, not just "X vs Y"
- Use terminology consistent with the rest of the paper

**Output:** Revised title, abstract, intro, section openings, and conclusion — all telling the same story.

---

### Phase 4: Evidence Strengthening

**Goal:** Ensure every claim has quantitative support, and identify the highest-ROI experiments or analyses to add.

**Steps:**

1. **Audit claim-evidence pairs.** For each contribution bullet:
   - What specific result supports it?
   - Is there a number? (Qualitative claims are weaker than quantitative ones.)
   - Is there a comparison? (Absolute numbers are weaker than deltas.)

2. **Front-load key numbers.** The abstract and intro should contain 2-4 of the most important quantitative results. Not all results — just the ones that make the thesis concrete.

3. **Identify evidence gaps.** Common gaps:
   - Mechanism claimed but only observational evidence provided
   - Comparison to "default" but not to reasonable alternatives
   - Aggregate results but no per-category breakdown
   - Single-run results but no stability/variance information

4. **Design minimum-cost evidence additions.** Prioritize by ROI:
   - **Highest ROI:** Add numbers to claims that currently lack them
   - **High ROI:** Add a small diagnostic experiment to validate a mechanism claim
   - **Medium ROI:** Add an ablation or controlled comparison
   - **Lower ROI:** Add more baselines or larger-scale experiments

5. **Add structured artifacts.** High-value, low-cost additions:
   - **Failure taxonomy table:** What fails, where, and what mitigates it
   - **Deployment guidance table:** What to invest in for each workload regime
   - **Summary statistics table:** End-to-end reduction / cost / efficiency numbers in one place
   - **Capability comparison table:** What prior work covers vs. what you add

**Key pattern: Diagnostic Intervention.**
When you claim a mechanism (e.g., "failures are caused by semantic grounding gaps"), design a minimal experiment that tests the mechanism directly:
- Change one variable (e.g., add one sentence of expert clarification)
- Keep everything else fixed
- Show the claimed mechanism is confirmed or refuted
- Frame it as "mechanism validation," not "new method"

**Key pattern: Necessity Evidence.**
For systems papers, prove that simpler alternatives are insufficient:
- Compare against progressively simpler baselines
- Show that each removed component degrades the result
- Frame the comparison section as "Why simpler alternatives are insufficient" rather than "Baseline comparison"

**Key pattern: Method Auditability.**
For any non-trivial algorithm or heuristic, make the method reviewer-auditable:
- State exact metrics, thresholds, and decision rules
- Explain how thresholds were chosen
- Define what happens in ambiguous cases
- Describe recovery/fallback behavior

**When to delegate:**
- If literature gaps are identified, use `literature-search` to find missing references, then return here to integrate them into the gap-framing strategy.
- If a diagnostic experiment needs to be designed, use `paper-writing` experiment-design patterns as a reference.

**Output:** List of evidence gaps, prioritized additions, and any new tables or figures.

---

### Phase 5: Reviewer Defense

**Goal:** Preemptively address the most likely reviewer attacks in the paper itself.

**Steps:**

1. **List the 3-5 most likely reviewer objections.** Common categories:
   - **Novelty:** "This is just integration / incremental / obvious"
   - **Scope:** "Single site / small dataset / narrow domain"
   - **Generalization:** "Would this work elsewhere?"
   - **Baselines:** "Comparison is unfair / baseline too weak"
   - **Methodology:** "How were thresholds chosen? Is this reproducible?"
   - **Overclaim:** "The conclusion goes beyond what the evidence shows"

2. **For each objection, decide: defend in text or acknowledge as limitation?**
   - If you have evidence: defend in the relevant section
   - If you don't but the claim still holds: acknowledge scope and explain why it doesn't invalidate the claim
   - If it's a genuine limitation: put it in limitations/discussion

3. **Write preemptive defense paragraphs.** For scope limitations:
   - "We do not claim X. We claim Y, which is a controlled, high-fidelity first step."
   - "The goal is not broad universality but controlled realism."

4. **Calibrate claim language throughout.** Remove:
   - Absolute words where hedging is warranted ("always" → "typically")
   - Emotion/rhetoric ("just an illusion," "trivial")
   - Overclaims that exceed evidence

   But also remove:
   - Excessive hedging that weakens solid claims ("may perhaps suggest" → "suggests")

5. **Ensure limitations section exists and is honest but strategic.**
   - Acknowledge real limitations before reviewers find them
   - Explain why each limitation doesn't undermine the core claim
   - Position future work as natural extensions, not missing pieces

**Output:** Revised limitations section, preemptive defense paragraphs, and calibrated claim language.

---

### Phase 6: Venue-Appropriate Polish

**Goal:** Make the paper read like a mature submission to the target venue.

**Steps:**

1. **Terminology consistency pass.** Check that each core concept uses exactly one term throughout.

2. **Remove AI-generated prose patterns.** Common tells:
   - Formulaic transitions ("First and foremost," "It is worth noting that")
   - Redundant self-commentary ("The key insight here is...")
   - List-heavy structure where paragraphs are expected
   - Inflated vocabulary ("leverage" → "use," "delve into" → "investigate")
   - Mechanical "总分总" (general-specific-general) paragraph structure

3. **Venue-specific style.** Apply `rewrite-humanize` with venue awareness:
   - **SC/HPDC:** Direct claims, reproducibility details, restrained rhetoric, operational relevance
   - **OSDI/SOSP:** Strong problem formulation, safety boundaries, design invariants, deployment considerations
   - **NeurIPS/ICML:** Contribution clarity, ablation rigor, theoretical grounding where possible

   See `@skill/references/venue-strategies.md` for detailed guidance.

4. **Page budget check.** If over limit:
   - Compress related work first (it's the easiest to shorten without losing substance)
   - Move method details to appendix
   - Tighten figure/table spacing
   - Do NOT cut limitations or evaluation

5. **Final compilation check.** Verify LaTeX compiles cleanly. Fix:
   - Undefined references
   - Missing citations
   - Overfull/underfull boxes that affect readability
   - BibTeX warnings on critical entries

**When to delegate:**
- For language-level polish, use `rewrite-humanize` with the venue context from `@skill/references/venue-strategies.md`.
- `rewrite-humanize` handles sentence-level naturalization; this phase handles terminology consistency, page budget, and compilation — the structural polish that `rewrite-humanize` does not cover.

**Output:** Polished, venue-ready manuscript.

---

## Decision Framework: What to Change and What to Leave

### Always change (high ROI, low risk)
- Misaligned title/abstract/intro framing
- Missing numbers in claims
- Inconsistent terminology
- Obvious overclaims
- Missing limitations section

### Usually change (high ROI, moderate effort)
- Section opening sentences that don't serve the thesis
- Figure captions that don't convey the takeaway
- Related work that doesn't create a gap for your contribution
- Evaluation opening that doesn't state what's being proven

### Change only if needed (moderate ROI, higher risk)
- Section structure / reordering
- Adding new experiments
- Changing the core claim itself
- Major terminology overhaul

### Almost never change (high risk, diminishing returns)
- Adding entirely new sections
- Changing the paper's fundamental direction
- Adding features/methods not already evaluated
- Rewriting code/experiments from scratch

---

## Common Revision Anti-Patterns

### 1. "Fix the writing, not the framing"
Polishing prose on a misframed paper is like painting a house with foundation problems. Always diagnose framing first.

### 2. "Add more results to compensate for weak claims"
More results don't fix a weak thesis. They make the paper longer and the weakness harder to find but still present.

### 3. "Emphasize everything equally"
A paper with five equal contributions has zero memorable contributions. Commit to one primary claim.

### 4. "Hide limitations"
Reviewers always find them. Acknowledged limitations are forgiven; hidden limitations are punished.

### 5. "Respond to every possible criticism"
Over-defending makes the paper sound insecure. Address the 3-5 most likely attacks. Trust the rest to rebuttal.

### 6. "The abstract/intro tells a different story than the results"
This happens when revision modifies the front matter but not the evaluation framing (or vice versa). Always propagate changes end-to-end.

---

## Integration with Other Skills

Supporting skills below are optional collaborators, not prerequisites. Load them only when the current revision phase requires them.

| Phase | When to load a supporting skill | Which skill |
|-------|-------------------------------|-------------|
| Diagnosis | User wants a structured quality score before strategic diagnosis | `scholar-evaluation` |
| Claim crystallization | Alternative framings need deeper brainstorming | `brainstorming-research-ideas` |
| Evidence strengthening | Missing references identified during evidence audit | `literature-search` tool |
| Evidence strengthening | Need experiment-design patterns or checklist guidance | `paper-writing` (reference only) |
| Reviewer defense | Want to simulate a full reviewer evaluation | `scholar-evaluation` |
| Language polish | Sentence-level naturalization and de-AI-ification | `rewrite-humanize` |

---

## References

Load these as needed:

- `@skill/references/framing-patterns.md`: Common reframing strategies with examples
- `@skill/references/reviewer-attack-catalog.md`: Typical reviewer objections and defense templates
- `@skill/references/evidence-strengthening.md`: Minimum-cost evidence addition strategies
- `@skill/references/venue-strategies.md`: Venue-specific revision guidance (SC, OSDI, NeurIPS, etc.)
