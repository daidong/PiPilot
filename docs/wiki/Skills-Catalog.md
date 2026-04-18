Research Copilot ships with **14 builtin skills** — lazy-loaded Markdown modules that give the agent domain expertise. Skills auto-activate when the coordinator detects a matching intent or when you invoke them by name.

For how skills work and how to write your own, see [Getting Started → Add custom skills](Getting-Started#5-add-custom-skills-optional).

## Writing & Review

### `paper-writing`
Publication-ready ML/AI/Systems conference papers (NeurIPS, ICML, ICLR, ACL, AAAI, COLM, OSDI, NSDI, ASPLOS, SOSP). Venue-specific templates, LaTeX, citations.
> *"Draft a NeurIPS-style introduction for <topic>, with related work citations."*

### `paper-revision`
Strategically revise an existing CS/AI/Systems draft for resubmission. Framing diagnosis, claim crystallization, reviewer defense, venue-aware polish.
> *"Help me revise this paper based on the reviewer comments in REVIEWS.md."*

### `research-grants`
Competitive proposals for NSF, NIH, DOE, DARPA, and Taiwan NSTC. Agency-specific formatting, review criteria, broader impacts.
> *"Draft NSF specific aims for a project on <topic>."*

### `rewrite-humanize`
Rewrite AI-sounding drafts to feel natural while preserving facts, numbers, and citations. Flow and cadence, not content.
> *"Humanize this paragraph — reduce AI tone, keep the meaning."*

### `scholar-evaluation`
ScholarEval framework: structured quality assessment across problem formulation, methodology, analysis, and writing with quantitative scoring.
> *"Evaluate this paper draft using ScholarEval and give me a score breakdown."*

### `scientific-writing`
IMRAD manuscripts in full paragraphs (never bullets). Two-stage: outline → flowing prose. Citations (APA/AMA/Vancouver), CONSORT/STROBE/PRISMA.
> *"Write the Methods section for a journal manuscript on <topic>."*

## Visualization

### `matplotlib`
Low-level plotting for full customization — novel plot types, integration with specific workflows, PNG/PDF/SVG export.
> *"Plot a custom dashboard with matplotlib showing <metrics> over time."*

### `seaborn`
Statistical visualization with pandas integration — distributions, relationships, categorical comparisons with attractive defaults.
> *"Make a pair plot and correlation heatmap for this dataset."*

### `scientific-visualization`
Meta-skill for journal-ready multi-panel figures. Orchestrates matplotlib/seaborn with Nature/Science/Cell styling, significance annotations, colorblind-safe palettes.
> *"Create a 4-panel figure for Nature Methods with significance bars."*

### `scientific-schematics`
Publication-quality diagrams via OpenRouter (Gemini 3 Pro Image + review). Iterative refinement, only regenerates below quality threshold. Requires `OPENROUTER_API_KEY`.
> *"Generate a system architecture diagram for <topic>."*

### `marp-slides`
Polished research presentation slides in Markdown via Marp — conference talks, lab meetings, thesis defense, posters.
> *"Turn this paper draft into a 12-slide conference talk."*

## Research Ideation

### `brainstorming-research-ideas`
Structured ideation frameworks for high-impact research directions. Use when exploring new topics, pivoting focus, or hitting diminishing returns.
> *"Brainstorm five research directions at the intersection of <A> and <B>."*

### `creative-thinking-for-research`
Eight cognitive-science frameworks for breakthrough ideas. Use when stuck in a local optimum and `brainstorming-research-ideas` alone yields only incremental candidates.
> *"I'm stuck — reframe this problem using analogical reasoning and two other cognitive lenses."*

## General

### `coding`
Systematic coding workflow: test-first, 300-line generation limits, edit-over-rewrite, error-feedback loops, incremental verification.
> *"Implement this function and add tests; fix iteratively until the suite passes."*

## Adding your own

Drop a Markdown file at `<workspace>/.pi/skills/<name>/SKILL.md` or `~/.research-pilot/skills/<name>/SKILL.md` — see [Getting Started](Getting-Started#5-add-custom-skills-optional) for the frontmatter format. Project-local skills override user-global, which override builtins.
