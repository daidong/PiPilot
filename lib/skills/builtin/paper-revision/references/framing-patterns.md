# Framing Patterns for Paper Revision

Common reframing strategies that turn borderline papers into defensible submissions. Each pattern includes the problem it solves, the reframe, and an example.

---

## Pattern 1: From "Pipeline of Components" to "Protocol / Contract"

### When to use
Paper has multiple components that each exist in prior work. Reviewers will say "this is just integration."

### The reframe
Define the contribution not as the components but as the **conditions under which they must operate together**. The novelty is the contract, not the parts.

### Template
> "Prior work addresses [A], [B], and [C] separately. But [the problem] requires all four conditions to hold simultaneously: [condition 1], [condition 2], [condition 3], [condition 4]. Our contribution is the protocol that enforces these conditions together."

### Example (ParameterRec / MATRIX-IO)
- Before: "We cluster traces, synthesize surrogates, and train a recommender."
- After: "We define when historical traces may become reusable tuning evidence, by enforcing semantic partition, executable anchoring, validated transfer, and bounded serving together."

---

## Pattern 2: From "Benchmark Paper" to "Benchmark-Backed Measurement Study"

### When to use
Paper introduces a benchmark but the benchmark alone may not be seen as sufficient novelty.

### The reframe
Position the benchmark as an **evaluation substrate** that enables a measurement study. The paper's value is the measurement findings, not the benchmark artifact.

### Template
> "We use [benchmark name] not as an end in itself, but as the evaluation substrate for a controlled measurement study of [phenomenon]. Our central finding is [mechanism / finding]."

### Example (COIDI)
- Before: "We introduce CIODI-Bench for evaluating LLM agents on HPC telemetry."
- After: "We use CIODI-Bench as an evaluation substrate to measure how reliability bottlenecks in LLM agents shift with task structure."

---

## Pattern 3: From "Parallel Observations" to "Unified Mechanism"

### When to use
Paper has 2-4 separate findings that are individually reasonable but collectively feel like "result dump."

### The reframe
Identify a single mechanism that explains all findings as special cases. The paper's thesis becomes the mechanism, not the individual observations.

### Template
> "Our central finding is that [mechanism] shifts with [variable]. Specifically, for [regime A], [bottleneck A] dominates; for [regime B], [bottleneck B] dominates; for [regime C], [bottleneck C] dominates."

### Example (COIDI)
- Before: "Context helps on extraction. Verification helps on analysis. Strong models help on hard tasks."
- After: "The dominant reliability bottleneck shifts with task structure: semantic grounding on extraction, verification tractability on analysis, upstream hypothesis formation on hard tasks."

---

## Pattern 4: From "We Did X" to "Gap Chain"

### When to use
Paper solves a problem but the connection between the problem and the solution feels hand-wavy.

### The reframe
Identify the specific gaps that prevent the obvious/naive approach from working. Structure the contribution as closing those gaps.

### Template
> "[Resource] cannot directly become [goal] because of N gaps: [gap 1], [gap 2], ..., [gap N]. We close these gaps by [solution 1], [solution 2], ..., [solution N]."

### Example (ParameterRec / MATRIX-IO)
- Before: "We use production traces for I/O tuning."
- After: "Production traces cannot directly become reusable tuning evidence because: (1) they don't define a semantically valid evidence space, (2) they're descriptive not executable, (3) trace-level resemblance doesn't imply transfer validity, (4) serving needs a stopping rule. We close each gap."

---

## Pattern 5: Three-Layer Claim Hierarchy

### When to use
Collaborators disagree about what the core contribution is (common when system builders care about practical impact and advisors care about intellectual novelty).

### The reframe
Separate value, problem, and mechanism into three explicit layers. All appear in the paper, but the mechanism is the defensible novelty.

### Template
> "[Value statement: what practical benefit this delivers.] This is possible because [problem statement: what problem this solves and using what resources]. The technical mechanism that makes it work is [mechanism statement: the specific novelty]."

### Example (ParameterRec / MATRIX-IO)
- Value: "Reduces hardware-backed tuning cost."
- Problem: "Uses large production trace corpora for tuning."
- Mechanism: "Execution-backed conservative evidence-reuse protocol."
- Combined: "MATRIX-IO uses large production I/O trace corpora to reduce hardware-backed tuning cost, by turning trace history into execution-backed, conservatively reusable tuning evidence."

---

## Pattern 6: From "Method Paper" to "Design Principles Paper"

### When to use
Paper proposes a system or method, but the specific design may not generalize. The insights behind the design are more valuable than the design itself.

### The reframe
Position the paper as extracting design principles or deployment guidance, with the system as the vehicle for discovering and validating those principles.

### Template
> "Our system demonstrates that [design principle]. This yields practical guidance: [when to do X], [when to do Y], [when not to do Z]."

---

## Pattern 7: Lowering Secondary Contributions Without Removing Them

### When to use
A secondary result matters to some reviewers but shouldn't overshadow the primary claim.

### The reframe
Include the secondary contribution in the value layer but not the mechanism layer. Give it one clear bullet, positioned after primary contributions.

### Rules
- Never mention the secondary result before the primary claim in abstract/intro
- In evaluation, show it as a consequence of the primary mechanism
- In contribution bullets, use phrasing like "as a practical consequence" or "this additionally reduces"
- Do not create a separate evaluation section for it; embed it in the primary evaluation flow
