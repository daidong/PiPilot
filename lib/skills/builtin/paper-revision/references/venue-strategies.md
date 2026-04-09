# Venue-Specific Revision Strategies

Guidance for adapting revision strategy to the values, expectations, and reviewer culture of specific conference types.

---

## SC / HPDC (HPC Systems)

### What reviewers value most
- Real systems on real hardware with real workloads
- Operational relevance to HPC facilities
- Reproducibility and artifact descriptions
- Conservative, well-bounded claims
- Performance at scale

### What gets papers rejected
- "Demo paper" feel without clear intellectual contribution
- Overclaimed generalization from limited evaluation
- Missing limitations section or dishonest scope
- Ignoring prior HPC-specific work
- Benchmarks without explaining why the benchmark design matters

### Revision priorities for SC
1. **Operational framing:** Connect findings to what HPC facility operators / administrators would actually do differently
2. **Scope honesty:** Be explicit about single-site vs. multi-site, production vs. testbed, application-specific vs. general
3. **Reproducibility signals:** Mention artifact availability, exact configurations, hardware specs
4. **Performance context:** Always explain whether speedups are over reasonable baselines (not just defaults)
5. **Community significance paragraph:** Translate technical findings into HPC deployment implications

### Style notes
- Direct, technical prose; avoid promotional language
- Prefer concrete mechanisms over abstract frameworks
- Include compute/cost/resource details
- Limitations section is expected and respected

---

## OSDI / SOSP / NSDI (Systems)

### What reviewers value most
- Clean problem formulation with clear design invariants
- Systems that address a real deployment pain point
- Strong evaluation methodology (not just "it's faster")
- Safety boundaries and failure modes
- Design lessons that generalize beyond the specific system

### What gets papers rejected
- "Engineering effort" without clear intellectual contribution
- Evaluation that only shows the happy path
- Missing discussion of failure modes / edge cases
- Claims that don't match the evaluated scope
- Poor writing quality (OSDI/SOSP have very high presentation bar)

### Revision priorities for OSDI/SOSP
1. **Design invariants:** State what your system always guarantees, not just what it usually achieves
2. **Necessity evidence:** Prove that simpler approaches don't work (ablation, controlled comparisons)
3. **Failure mode analysis:** Show what happens when assumptions are violated
4. **Scalability and cost:** Include deployment overhead, not just throughput
5. **Design lessons section:** Extract 2-3 takeaways that other system builders can use

### Style notes
- Very strong problem formulation expected in first 2 pages
- "Rapid review" culture: reviewers decide quickly based on intro quality
- Design section should explain *why*, not just *what*
- Evaluation should answer specific research questions, not demonstrate features

---

## NeurIPS / ICML / ICLR (ML/AI)

### What reviewers value most
- Clear, novel contribution (method, theory, or empirical finding)
- Rigorous ablation studies
- Reproducible experimental setup
- Positioning relative to a well-defined problem
- Statistical rigor (error bars, significance tests, multiple seeds)

### What gets papers rejected
- "Bag of tricks" without clear insight
- Evaluation on only one dataset/setting
- Missing ablations for key design choices
- Overclaimed novelty that is actually incremental
- Poor related work coverage

### Revision priorities for NeurIPS/ICML
1. **One clear contribution:** Can you state it in one sentence? If not, the paper isn't ready
2. **Ablation rigor:** Every non-obvious design choice needs an ablation or justification
3. **Statistical reporting:** Error bars, number of seeds, significance tests where appropriate
4. **Related work density:** Cite generously; reviewers may have authored related papers
5. **Abstract formula:** Use the 5-sentence structure (what/why hard/how/evidence/best number)

### Style notes
- More theoretical framing expected than systems venues
- "Broader Impact" or similar statement may be required
- Appendix can be extensive but reviewers aren't required to read it
- Checklist compliance is mandatory at most venues

---

## Cross-Venue Patterns

### Universal high-ROI actions
1. Ensure title accurately signals the paper type
2. Ensure abstract contains at least 2 concrete numbers
3. Ensure introduction has clear contribution bullets
4. Ensure evaluation opening states what questions are being answered
5. Ensure limitations section exists and is honest

### Universal revision traps
1. Revising front matter but not evaluation (or vice versa)
2. Adding more results instead of fixing the narrative
3. Over-defending minor points while leaving major gaps unaddressed
4. Changing terminology mid-revision without propagating everywhere
5. Cutting limitations to save space (this always backfires)
