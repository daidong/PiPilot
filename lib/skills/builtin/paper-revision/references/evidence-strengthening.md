# Evidence Strengthening Strategies

Minimum-cost additions that maximize reviewer persuasion, organized by ROI.

---

## Tier 1: Zero New Experiments (Writing Only)

These additions cost nothing but writing time and can dramatically improve reviewer perception.

### 1.1 Front-load key numbers into abstract and introduction
**Problem:** Claims are qualitative; reviewer doesn't know the magnitude of effects.
**Fix:** Extract 2-4 of the most important quantitative deltas from your results and insert them into the abstract and the introduction's central finding paragraph.
**Template:** "On [task category], [intervention] improves [metric] by [X points / X%] over [baseline], while on [other category], the same intervention changes [metric] by only [Y]."

### 1.2 Add a summary statistics table
**Problem:** Key numbers are scattered across different subsections.
**Fix:** Create a single small table that summarizes the end-to-end pipeline / reduction / efficiency story in one place.
**Columns might include:** raw input → filtered → reduced → final output → cost / samples / iterations

### 1.3 Add a capability comparison table
**Problem:** Reviewer can't quickly see what's new vs. prior work.
**Fix:** Create a table with prior systems as rows and capabilities as columns. Check marks show what each covers. Your system should have checks in columns no other system covers.

### 1.4 Add a failure taxonomy
**Problem:** Results show when things work but not when/why they fail.
**Fix:** Create a structured table of failure modes: type, where it occurs, which configuration is vulnerable, and what mitigates it.

### 1.5 Add deployment guidance
**Problem:** Results are interesting but reviewer asks "so what should practitioners do?"
**Fix:** Create a table mapping workload/task characteristics to recommended interventions. This turns findings into actionable advice.

### 1.6 Rewrite comparator section as necessity evidence
**Problem:** Baseline comparison exists but reads as "we beat baselines."
**Fix:** Rename and reframe as "Why simpler alternatives are insufficient." The question changes from "how much do we win?" to "is the full method actually necessary?"

---

## Tier 2: Small Diagnostic Experiments

These require running a few experiments but provide disproportionate persuasive value.

### 2.1 Diagnostic intervention (mechanism validation)
**Problem:** You claim failures are caused by [mechanism X] but only have observational evidence.
**Fix:** Design a minimal, controlled intervention that directly tests the mechanism:
- Change exactly one variable (e.g., add one sentence of expert clarification)
- Keep everything else fixed (same model, same tools, same scoring)
- Show the claimed mechanism is confirmed

**Critical framing rules:**
- Call it "diagnostic probe" or "mechanism validation," NOT "new method"
- State explicitly what the intervention does NOT reveal (no answer leakage)
- State that this is not a deployable solution but a test of the failure explanation
- Allow negative results — they strengthen credibility

### 2.2 Response fidelity check
**Problem:** You claim a surrogate / proxy preserves some property, but only show feature-level similarity.
**Fix:** On a small overlap set, show that the property you actually care about (e.g., tuning ranking, improvement direction) is preserved.

### 2.3 Stability / variance check
**Problem:** Results are single-run or low-K, and reviewer questions reliability.
**Fix:** For 2-3 representative configurations, increase K modestly and show that trends/rankings are stable. Can go in appendix.

### 2.4 Per-item breakdown
**Problem:** Aggregate results look strong but reviewer suspects cherry-picking.
**Fix:** Show per-task / per-workload results (even just in a compact table or appendix). This provides auditability and shows the effect is broad, not driven by outliers.

---

## Tier 3: Moderate Experiments

### 3.1 Budget-matched comparison
**Problem:** Reviewer asks "what if I gave the same budget to a simpler method?"
**Fix:** Run the simplest reasonable alternative under the same resource budget. Show that your method converges faster or reaches higher quality.

### 3.2 Ablation on the conservative constraints
**Problem:** Reviewer asks "would it work without [specific constraint]?"
**Fix:** Remove one constraint at a time and show degradation. This is the strongest form of necessity evidence.

### 3.3 Cross-condition generalization
**Problem:** Reviewer questions whether results hold under different conditions.
**Fix:** Run on a small number of alternative conditions (different scale, different workload family, different model). Even 2-3 additional conditions dramatically strengthen generalization claims.

---

## How to Prioritize

### Ask these questions in order:

1. **Are there claims without numbers?** → Tier 1.1 (front-load numbers)
2. **Is there a "so what" gap?** → Tier 1.4-1.5 (failure taxonomy / deployment guidance)
3. **Is there a mechanism claim without direct evidence?** → Tier 2.1 (diagnostic intervention)
4. **Could a reviewer say "simpler methods would work"?** → Tier 1.6 or 3.2 (necessity evidence)
5. **Are key numbers scattered?** → Tier 1.2 (summary table)
6. **Is novelty unclear vs. prior work?** → Tier 1.3 (capability comparison)

### Time budget rules of thumb:
- **< 2 hours:** Do all of Tier 1
- **< 1 day:** Add 1-2 from Tier 2
- **< 1 week:** Add 1 from Tier 3
- **No time at all:** At minimum, do Tier 1.1 (front-load numbers) — it's the single highest-ROI action
