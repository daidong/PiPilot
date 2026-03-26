---
name: brainstorming-research-ideas
description: Structured ideation frameworks for discovering high-impact research directions. Use when exploring new topics, pivoting research focus, or when current investigation yields diminishing returns.
category: Research Ideation
depends: []
tags: [Research Ideation, Brainstorming, Problem Discovery, Research Strategy]
triggers: [brainstorm, research ideas, new direction, explore topics, ideation, pivot research, research questions, 头脑风暴, 研究方向, 选题]
---

# Research Idea Brainstorming

Ten complementary ideation lenses for moving from vague curiosity to concrete, defensible research proposals. Each framework targets a different cognitive mode — use them individually or combine them via the Integrated Workflow below for a full diverge-converge cycle.

## Overview

This skill provides structured frameworks for generating and evaluating research directions. It is most valuable during the exploratory phase of research — when you need to identify promising questions, broaden your scope, or escape a local optimum in your thinking.

## When to Use This Skill

- You need to explore new research directions or pivot from a current topic.
- Your current line of investigation has stalled or yields diminishing returns.
- The user asks for new research ideas and you need to generate and rank candidates.
- You have a vague area of interest but no specific research question yet.

**Do NOT use this skill when**:
- You already have a well-defined research question and need execution guidance — proceed with normal task execution.
- You need a literature survey — use the `literature-search` tool directly.
- You are mid-task with productive work in progress — finish current work first.

---

## Core Ideation Frameworks

### 1. Problem-First vs. Solution-First Thinking

Research ideas originate from two distinct modes. Knowing which mode you are in prevents building solutions that lack real problems, or chasing problems without feasible approaches.

**Problem-First** (pain point → method):
- Start with a concrete failure, bottleneck, or unmet need
- Naturally yields impactful work because the motivation is intrinsic
- Risk: may converge on incremental fixes rather than paradigm shifts

**Solution-First** (new capability → application):
- Start with a new tool, insight, or technique seeking application
- Often drives breakthroughs by unlocking previously impossible approaches
- Risk: "hammer looking for a nail" — solution may lack genuine demand

**Application**: When generating candidate directions, classify each as problem-first or solution-first. Problem-first candidates need a feasibility check; solution-first candidates need at least two genuine problems they address.

---

### 2. The Abstraction Ladder

Every research problem sits at a particular level of abstraction. Deliberately moving up or down reveals ideas invisible at your current level.

| Direction | Action | Outcome |
|-----------|--------|---------|
| **Move Up** (generalize) | Turn a specific result into a broader principle | Framework papers, theoretical contributions |
| **Move Down** (instantiate) | Test a general paradigm under concrete constraints | Empirical papers, surprising failure analyses |
| **Move Sideways** (analogize) | Apply same abstraction level to adjacent domain | Cross-pollination, transfer papers |

**Application**: For any candidate direction, generate the up/down/sideways variants. Each variant is a potential research topic. Use the `literature-search` tool to validate the most promising variants.

---

### 3. Tension and Contradiction Hunting

Breakthroughs often come from resolving tensions between widely accepted but seemingly conflicting goals. These contradictions are the research opportunity.

**Common Research Tensions**:

| Tension Pair | Research Opportunity |
|-------------|---------------------|
| Performance ↔ Efficiency | Can we match SOTA with 10x less compute? |
| Privacy ↔ Utility | Can federated/encrypted methods close the accuracy gap? |
| Generality ↔ Specialization | When does fine-tuning beat prompting, and why? |
| Safety ↔ Capability | Can alignment improve rather than tax capability? |
| Interpretability ↔ Performance | Do mechanistic insights enable better architectures? |
| Scale ↔ Accessibility | Can small models replicate emergent behaviors? |

**Application**: List the top 3-5 desiderata in your research area. Identify pairs treated as trade-offs. For each pair: is the trade-off fundamental or an artifact of current methods? If artifact → the reconciliation IS the research direction. If fundamental → characterizing the Pareto frontier is itself valuable.

---

### 4. Cross-Pollination (Analogy Transfer)

Borrowing structural ideas from other disciplines is one of the most generative research heuristics. Attention mechanisms from cognitive science, genetic algorithms from biology, adversarial training from game theory.

**Requirements for a Valid Analogy**:
- **Structural fidelity**: The mapping must hold at the level of underlying mechanisms, not just surface similarity
- **Non-obvious connection**: If the link is well-known, the novelty is gone
- **Testable predictions**: The analogy should generate concrete hypotheses

**High-Yield Source Fields**:

| Source Field | Transferable Concepts |
|-------------|----------------------|
| Neuroscience | Attention, memory consolidation, hierarchical processing |
| Physics | Energy-based models, phase transitions, renormalization |
| Economics | Mechanism design, auction theory, incentive alignment |
| Ecology | Population dynamics, niche competition, co-evolution |
| Linguistics | Compositionality, pragmatics, grammatical induction |
| Control Theory | Feedback loops, stability, adaptive regulation |

**Application**: Describe the problem in domain-agnostic language (strip jargon). Identify which other field solves a structurally similar problem. Use the `literature-search` tool to search that field's solution at the mechanism level. Save the analogy as a note artifact before building on it.

---

### 5. The "What Changed?" Principle

Strong ideas often come from revisiting old problems under new conditions. Advances in hardware, scale, data availability, or regulations can invalidate prior assumptions.

**Categories of Change to Monitor**:

| Change Type | Example | Research Implication |
|------------|---------|---------------------|
| **Compute** | GPUs 10x faster | Methods dismissed as too expensive become feasible |
| **Scale** | Trillion-token datasets | Statistical arguments that failed at small scale may now hold |
| **Regulation** | EU AI Act, GDPR | Creates demand for compliant alternatives |
| **Tooling** | New frameworks, APIs | Reduces implementation barrier for complex methods |
| **Failure** | High-profile system failures | Exposes gaps in existing approaches |
| **Cultural** | New user behaviors | Shifts what problems matter most |

**Application**: Pick a well-known negative result or abandoned approach (3-10 years old) from the literature. List the assumptions that led to its rejection. For each: is this still true today? If any assumption is invalidated → frame the direction as "X was previously impractical because Y, but Z has changed." Use `literature-search` to check whether anyone already revisited it.

---

### 6. Failure Analysis and Boundary Probing

Understanding where a method breaks is often as valuable as showing where it works. Boundary probing systematically exposes the conditions under which accepted techniques fail.

**Types of Boundaries to Probe**:
- **Distributional**: What happens with out-of-distribution inputs?
- **Scale**: Does the method degrade at 10x or 0.1x the typical scale?
- **Adversarial**: Can the method be deliberately broken?
- **Compositional**: Does performance hold when combining multiple capabilities?
- **Temporal**: Does the method degrade over time (concept drift)?

**Application**: Select a widely-used method in your research area. Identify the implicit assumptions in its evaluation. Design experiments that systematically violate each assumption. The failure mode often reveals both the root cause and a constructive path forward.

---

### 7. The Simplicity Test

Before accepting complexity, ask whether a simpler approach suffices. Fields sometimes over-index on elaborate solutions when a streamlined baseline performs competitively.

**Warning Signs of Unnecessary Complexity**:
- The method has many hyperparameters with narrow optimal ranges
- Ablations show most components contribute marginally
- A simple baseline was never properly tuned or evaluated
- The improvement over baselines is within noise on most benchmarks

**Application**: For any research direction, strip the current approach to its simplest core. If the gap vs. full method is small → the contribution is the simplicity itself. If the gap is large → you now understand what the complexity buys. Either outcome sharpens the direction.

---

### 8. Stakeholder Rotation

Viewing a system from multiple perspectives reveals distinct classes of research questions.

| Stakeholder | Key Questions |
|-------------|---------------|
| **End User** | Is this usable? What errors are unacceptable? What is the latency tolerance? |
| **Developer** | Is this debuggable? What is the maintenance burden? How does it compose? |
| **Theorist** | Why does this work? What are the formal guarantees? Where are the gaps? |
| **Adversary** | How can this be exploited? What are the attack surfaces? |
| **Ethicist** | Who is harmed? What biases are embedded? Who is excluded? |
| **Regulator** | Is this auditable? Can decisions be explained? Is there accountability? |
| **Operator** | What is the cost? How does it scale? What is the failure mode? |

**Application**: When evaluating candidate directions, cycle through at least 3 stakeholder perspectives. Unaddressed concerns with broad impact are high-value research questions.

---

### 9. Composition and Decomposition

Novelty often emerges from recombination or modularization.

**Composition** (combining existing techniques):
- Identify two methods that solve complementary subproblems
- Ask: What emergent capability arises from combining them?

**Decomposition** (breaking apart monolithic systems):
- Identify a complex system with entangled components
- Ask: Which component is the actual bottleneck?

**Application**: List the 5-10 key techniques in your research area. For compositions: pick pairs and hypothesize emergent capabilities. For decompositions: isolate each component's contribution. Save promising combinations as note artifacts for further exploration.

---

### 10. The Two-Sentence Pitch Test

A strong research direction should be defensible in two sentences.

**Template**:
> **Sentence 1** (Problem): "[Domain] currently struggles with [specific problem], which matters because [concrete consequence]."
> **Sentence 2** (Insight): "We [approach] by [key mechanism], which works because [reason]."

**If you cannot fill this template**:
- Problem not well-defined → return to Framework 1
- Insight not clear → return to Framework 7 (simplify)
- Significance not established → return to Framework 3 (find the tension)

---

## Integrated Workflow: Diverge → Converge → Refine

Use this when a full exploration cycle is needed to generate and rank multiple candidate directions.

### Phase 1: Diverge (Generate Candidates)

**Goal**: Produce 10-20 candidate directions without filtering.

1. **Scan for tensions** (F3): List 5 trade-offs in the research area
2. **Check what changed** (F5): Use `literature-search` to identify 3 recent shifts
3. **Probe boundaries** (F6): Pick 2 popular methods and find where they break
4. **Cross-pollinate** (F4): Pick 1 idea from an adjacent field
5. **Compose/decompose** (F9): Combine 2 existing techniques or split 1 apart
6. **Climb the abstraction ladder** (F2): For each candidate, generate up/down/sideways variants

Save the full candidate list as a note artifact so it persists across sessions.

### Phase 2: Converge (Filter and Rank)

**Goal**: Narrow to 3-5 strongest candidates.

Apply these filters to each candidate:

| Filter | Question | Kill Criterion |
|--------|----------|----------------|
| **Two-Sentence Test** (F10) | Can you state this in two sentences? | If no → idea is not yet clear enough |
| **Problem-First Check** (F1) | Is the problem genuine and important? | If no one suffers from this → drop it |
| **Simplicity Test** (F7) | Is the complexity justified? | If a simpler approach works → simplify or drop |
| **Stakeholder Check** (F8) | Who benefits? Who might object? | If no clear beneficiary → drop it |
| **Feasibility** | Can this be executed within project constraints? | If clearly infeasible given budget/compute → park it |

### Phase 3: Refine (Sharpen the Winner)

**Goal**: Turn the top candidate into a concrete research plan.

1. Write the two-sentence pitch (F10)
2. Identify the core tension being resolved (F3)
3. Specify the abstraction level (F2)
4. Draft 3 concrete validation questions that would confirm or refute the direction
5. Anticipate the strongest objection and prepare a response
6. Present the refined direction to the user for approval

**Output mapping**:
- Winning direction → concrete research plan for the user
- Top 3 candidates → literature search tasks to validate each
- Validation questions → next steps for the research
- Full candidate list + analysis → saved as note artifact for future reference

---

## Framework Selection Guide

| Your Situation | Start With |
|---------------|------------|
| No clear area, exploring broadly | Tension Hunting (F3) → What Changed (F5) |
| Vague area but no specific direction | Abstraction Ladder (F2) → Failure Analysis (F6) |
| Have a direction but unsure of its value | Two-Sentence Test (F10) → Simplicity Test (F7) |
| Good direction but need a fresh angle | Cross-Pollination (F4) → Stakeholder Rotation (F8) |
| Want to combine existing findings | Composition/Decomposition (F9) |
| Found a technique, seeking application | Problem-First Check (F1) → Stakeholder Rotation (F8) |
| Want to challenge current approach | Failure Analysis (F6) → Simplicity Test (F7) |

---

## Common Pitfalls in Research Ideation

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| **Novelty without impact** | "No one has done X" but no one needs X | Apply Problem-First Check (F1) |
| **Incremental by default** | Idea is +2% on a benchmark | Climb the Abstraction Ladder (F2) |
| **Complexity worship** | Method has 8 components, each helping marginally | Apply Simplicity Test (F7) |
| **Echo chamber** | All ideas come from the same literature cluster | Use Cross-Pollination (F4) with `literature-search` on adjacent fields |
| **Stale assumptions** | "This was tried and didn't work" (years ago) | Apply What Changed (F5) |
| **Single-perspective bias** | Only considering one stakeholder | Use Stakeholder Rotation (F8) |
| **Premature convergence** | Committed to first idea without exploring | Run full Diverge phase |
