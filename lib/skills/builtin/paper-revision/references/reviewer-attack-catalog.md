# Reviewer Attack Catalog

Common reviewer objections organized by category, with defense strategies and preemptive text templates. Use this to anticipate and address attacks before submission.

---

## Category 1: Novelty Attacks

### Attack 1.1: "This is just integration"
**When it comes:** Paper has multiple components that each exist in prior work.

**Defense strategy:** Reframe as protocol/contract (see framing-patterns.md Pattern 1). Add a capability comparison table showing no prior work satisfies all conditions simultaneously.

**Preemptive text template:**
> "The contribution is not any individual component in isolation — [X], [Y], and [Z] each have precedents. Rather, it is the protocol that couples them: [goal] becomes possible only when [conditions] are enforced together. No prior system enforces all of these simultaneously (Table N)."

---

### Attack 1.2: "This is incremental over [specific prior work]"
**When it comes:** A closely related system exists.

**Defense strategy:** Identify the specific capability delta. If the delta is small, acknowledge it and reframe around the unique combination. If the delta is large, make it more visible.

**Preemptive text template:**
> "[Prior work] addresses [X] but assumes [limitation]. In our setting, [limitation does not hold] because [reason]. [Our approach] removes this assumption by [mechanism]."

---

### Attack 1.3: "The findings are obvious / expected"
**When it comes:** Results align with intuition (e.g., "of course more context helps").

**Defense strategy:** Emphasize that the contribution is not the direction of the effect but its quantification, boundary conditions, and mechanism. Add quantitative deltas and identify where the effect does NOT hold.

**Preemptive text template:**
> "While the direction of this effect may be intuitive, our study provides the first controlled quantification: [effect size]. Importantly, the effect reverses under [condition], demonstrating that [nuance]."

---

## Category 2: Scope and Generalization Attacks

### Attack 2.1: "Single site / single dataset / narrow domain"
**When it comes:** Experiments use data from one source.

**Defense strategy:** Do NOT claim broad universality. Instead, claim "controlled realism" and position the single site as a high-fidelity first step.

**Preemptive text template:**
> "We scope the validated path to [site/dataset] because it provides [specific advantages: production data, complete metadata, etc.]. We do not claim that quantitative results transfer unchanged to all [domains]. Rather, we provide a controlled, realistic substrate for studying [phenomenon], and we expect the qualitative patterns to generalize to settings with similar [characteristics]."

---

### Attack 2.2: "Would this work on a different [system/domain/scale]?"
**When it comes:** The approach seems tied to specific infrastructure.

**Defense strategy:** Identify what the approach actually depends on (e.g., "feature availability" not "specific hardware") and state that dependency explicitly.

**Preemptive text template:**
> "Extension to other [systems/domains] requires [specific conditions], not merely more data. We discuss this requirement in Section N and leave multi-[site/domain] validation to future work."

---

### Attack 2.3: "N is too small" (tasks, samples, runs, etc.)
**When it comes:** Dataset/benchmark size seems insufficient.

**Defense strategy:** Do not compete on scale. Compete on quality, realism, and control. Explain why N is sufficient for the claims being made.

**Preemptive text template:**
> "We emphasize [quality/realism/expert curation/control] over scale. Each of the N [items] involves [complexity]. Our claims are at the [regime/family/category] level, not at the level of fine-grained ranking between near-tied methods, and the observed effects are consistent across [groupings]."

---

## Category 3: Methodology Attacks

### Attack 3.1: "How were thresholds / hyperparameters chosen?"
**When it comes:** Paper uses thresholds or design choices without clear justification.

**Defense strategy:** State the thresholds explicitly. Explain the design rationale (conservative, validated on held-out data, or sensitivity-analyzed). If sensitivity analysis exists, reference it.

**Preemptive text template:**
> "We set [threshold] = [value] based on [rationale]. The system is intentionally [conservative/asymmetric]: [explanation of design choice]. We report sensitivity to this choice in [appendix/section]."

---

### Attack 3.2: "This relies on manual / hand-crafted rules"
**When it comes:** Paper has expert-defined categories, rules, or heuristics.

**Defense strategy:** Reframe rules as "operational constraints" or "semantic priors" rather than "heuristics." Emphasize that they define the scope of safe operation, not universal truth.

**Preemptive text template:**
> "[Rules/categories] encode operational constraints rather than universal taxonomy. They define the scope within which [reuse/transfer/recommendation] is safe. We prioritize [conservative correctness] over [full automation], and we expect these constraints to be refined as [domain knowledge / deployment experience] grows."

---

### Attack 3.3: "Baseline comparison is unfair"
**When it comes:** Baselines are weak, adapted from different settings, or cherry-picked.

**Defense strategy:** Explain why each baseline was chosen and what question it answers. If adaptation was necessary, explain what was preserved and what was changed.

**Preemptive text template:**
> "We compare against [baselines] not as straw men but as a progression: [baseline 1] tests whether [simple approach] suffices; [baseline 2] tests whether [moderate approach] closes the gap; [our method] tests whether the full [path/protocol] is necessary. This ladder structure isolates the contribution of each design element."

---

### Attack 3.4: "K / number of runs is too low for reliable conclusions"
**When it comes:** Stochastic experiments with limited repetitions.

**Defense strategy:** Acknowledge the budget constraint, explain what level of conclusion the data supports, and state what you do NOT claim.

**Preemptive text template:**
> "We run K=[value] trials per configuration, yielding [metric] as our primary reliability estimate. We do not claim fine-grained ranking between near-tied methods; rather, we focus on [regime-level / family-level] conclusions where the observed effects are consistent across [categories/tasks]. Larger K would sharpen uncertainty estimates but is unlikely to reverse the broader trends observed."

---

## Category 4: Presentation Attacks

### Attack 4.1: "The paper is hard to follow"
**When it comes:** Narrative is unclear, inconsistent terminology, or poor section transitions.

**Defense strategy:** Apply Phase 3 (Narrative Unification) systematically. Ensure every section opening answers "what is this section's job?"

---

### Attack 4.2: "Claims in abstract/intro don't match evaluation"
**When it comes:** Front matter was revised but evaluation wasn't updated (or vice versa).

**Defense strategy:** Do a claim-echo audit: for each claim in the abstract, find the exact evaluation paragraph that supports it.

---

### Attack 4.3: "Figure/table doesn't support the claimed conclusion"
**When it comes:** Captions are generic, or the text interprets the figure differently than what it shows.

**Defense strategy:** Rewrite captions to include the key takeaway. Ensure text references to figures state what to observe and why it matters.

---

## Category 5: Significance Attacks

### Attack 5.1: "So what? Why should [community] care?"
**When it comes:** Paper is technically sound but doesn't connect to community values.

**Defense strategy:** Add a "community significance" paragraph in the introduction that translates technical findings into operational/deployment/practical terms.

**SC-specific template:**
> "For the HPC [storage/computing] community, this means [practical implication]. The path to [goal] requires not [naive approach] but [principled approach that our work demonstrates]."

---

### Attack 5.2: "This is a nice dataset/tool but not a research contribution"
**When it comes:** Paper's primary artifact is a benchmark, tool, or dataset.

**Defense strategy:** Reframe as measurement study or design study (see framing-patterns.md Pattern 2). The artifact is the instrument; the findings are the contribution.

---

## Using This Catalog

### Before submission
1. Read through the catalog and identify 3-5 attacks most relevant to your paper
2. For each, check whether the paper already addresses it
3. If not, add preemptive defense using the templates above
4. Prioritize attacks by likelihood and severity

### During revision
- When a collaborator or internal reviewer raises a concern, check if it maps to a catalog entry
- If yes, apply the corresponding defense strategy
- If no, consider adding a new entry for future reference

### After reviews
- Map each reviewer comment to a catalog entry
- Use the defense strategy to draft rebuttal responses
- Strengthen the paper text for resubmission
