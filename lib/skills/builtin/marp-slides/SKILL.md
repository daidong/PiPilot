---
name: marp-slides
description: "Create polished research presentation slides in Markdown using Marp. Use when the user needs conference talk slides, lab meeting decks, thesis defense presentations, research seminars, or poster-style overviews. Converts research artifacts (papers, notes, data) into visual narratives. For written documents use paper-writing or scientific-writing; for individual figures use scientific-visualization."
category: Presentation
tags: [Marp, Slides, Presentation, Conference Talk, Lab Meeting, Thesis Defense, Seminar, Research Talk, Markdown Slides, 做PPT, 演示文稿, 学术报告, 幻灯片]
triggers: [make slides, create presentation, conference talk, lab meeting slides, thesis defense, research presentation, seminar slides, marp, slide deck, 做幻灯片, 做报告, 学术演讲, PPT]
depends: [scientific-visualization]
license: MIT
metadata:
    skill-author: K-Dense Inc.
    based-on: robonuggets/marp-slides
---

# Research Presentation Slides with Marp

Expert guidance for creating effective research presentation slides using **Marp** — a Markdown-to-slides pipeline that exports to HTML, PDF, and PPTX. This skill focuses on academic and research contexts: conference talks, lab meetings, thesis defenses, seminars, and internal research reviews.

## Overview

Marp converts standard Markdown files into presentation slides. You write Markdown, separate slides with `---`, control appearance through YAML directives, and export via CLI. This skill provides research-specific design systems, slide templates, and composition strategies that turn complex research into clear visual narratives.

**Philosophy**: Research slides are not documents. They are visual aids for a spoken narrative. Every slide should answer one question, support one claim, or show one result. If a slide requires more than 15 seconds to parse visually, it has too much content.

## When to Use This Skill

- The user needs slides for a conference talk, invited talk, or workshop presentation.
- The user wants to present research findings at a lab meeting, group meeting, or seminar.
- The user is preparing a thesis defense or qualifying exam presentation.
- The user wants to convert a paper draft or research artifacts into a slide deck.
- The user explicitly asks for Marp slides or a Markdown presentation.

## When NOT to Use This Skill

- The user needs a **written document** (paper, report, grant proposal) — use `paper-writing`, `scientific-writing`, or `research-grants`.
- The user needs a **single publication figure** — use `scientific-visualization`, `matplotlib`, or `seaborn`.
- The user needs a **diagram or schematic** only — use `scientific-schematics`.
- The user needs a **poster** (static large-format) — while Marp can produce poster-like outputs, dedicated poster tools are better. Ask the user before proceeding.
- The user is still **running experiments** — finish the research first, then present it.

### Differentiation from Other Skills

| Need | Use This Skill | Use Instead |
|------|---------------|-------------|
| Conference talk slides | **marp-slides** | — |
| Written conference paper | — | `paper-writing` |
| Journal manuscript | — | `scientific-writing` |
| Individual data figure | — | `scientific-visualization` |
| Diagram / flowchart | — | `scientific-schematics` |
| Grant proposal | — | `research-grants` |

---

## Marp Syntax Quick Reference

### Document Structure

Every Marp file starts with YAML front matter and uses `---` to separate slides:

```markdown
---
marp: true
theme: default
paginate: true
style: |
  /* CSS customizations here */
---

# Slide 1: Title

Content here.

---

# Slide 2: Next Topic

More content.
```

### Essential Directives

**Global** (front matter — apply to entire deck):

| Directive | Purpose | Example |
|-----------|---------|---------|
| `marp: true` | Enable Marp rendering | Required |
| `theme` | Base theme | `default`, `gaia`, `uncover` |
| `paginate: true` | Show slide numbers | Usually enabled |
| `style` | Custom CSS block | See theme section below |
| `math: mathjax` | Enable math typesetting | For equations |
| `headingDivider: 2` | Auto-split at h2 headings | Useful for long content |
| `size: 16:9` | Slide aspect ratio | Default is 16:9 (1280x720) |

**Per-slide** (in HTML comments — inherited by subsequent slides):

```markdown
<!-- backgroundColor: #1a1a2e -->
<!-- color: #e0e0e0 -->
<!-- class: lead -->
<!-- header: "Section Name" -->
<!-- footer: "Author — Conference 2026" -->
```

**Single-slide only** (underscore prefix — no inheritance):

```markdown
<!-- _paginate: false -->
<!-- _backgroundColor: #000 -->
<!-- _header: "" -->
<!-- _class: lead -->
```

### Image Syntax

```markdown
![w:400](figure.png)              <!-- fixed width -->
![h:300](figure.png)              <!-- fixed height -->
![bg](image.jpg)                  <!-- full background -->
![bg right:40%](image.jpg)        <!-- split layout: image right 40% -->
![bg left:35%](image.jpg)         <!-- split layout: image left 35% -->
![bg contain](image.jpg)          <!-- fit without cropping -->
![bg brightness:0.3](image.jpg)   <!-- darkened background -->
```

### Math

```markdown
Inline: $E = mc^2$

Block:
$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\epsilon_0}
$$
```

### Code Blocks

````markdown
```python
def train(model, data):
    for batch in data:
        loss = model(batch)
        loss.backward()
```
````

---

## Design Principles for Research Slides

### Axiom: One Idea Per Slide

Marp clips overflowing content **silently** — there is no warning. If text overflows the slide boundary, the audience never sees it and you get no error. This makes "one idea per slide" not just good practice but a survival rule.

**Practical limits per slide:**
- Max 6 bullet points (prefer 3-4)
- Max 1 figure + 3 lines of explanation
- Max 1 table with 5 rows
- Max 1 code block of 12 lines

### Visual Hierarchy

| Element | Role | Styling |
|---------|------|---------|
| h1 | Slide title | Large, bold, accent or white |
| h2 | Subtitle or section | Lighter weight, grey |
| h3 | Label or category | Small, uppercase, muted |
| Body text | Supporting narrative | `#999` on dark, `#666` on light |
| Accent color | Key data, highlights | Used sparingly — 1-2 elements per slide |

### Color Discipline

- Body text should never be full black or full white — use `#999` (dark theme) or `#666` (light theme).
- Reserve the accent color for data highlights, key metrics, and important callouts. Not headings, not body text.
- Use semantic colors consistently: green for positive/improvement, red for negative/decline, yellow for caution/neutral.

### Typography for Research

Research presentations need legibility from a distance. Font size guidelines:
- Title: 2.5-3em
- Subtitle: 1.2-1.5em
- Body: 1-1.1em (Marp default is fine for most rooms)
- Code: 0.8-0.9em
- Footnotes/citations: 0.6-0.7em

---

## Theme System

### Dark Theme (Conference Talks, Invited Talks)

Dark backgrounds work well in conference halls, auditoriums, and dimmed rooms. High contrast makes figures and data pop.

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
  h1 { font-weight: 700; font-size: 2.8em; color: var(--light); margin-bottom: 0.2em; }
  h2 { font-weight: 300; font-size: 1.3em; color: var(--body); margin-top: 0; }
  h3 { font-weight: 600; font-size: 0.75em; color: var(--label); text-transform: uppercase; letter-spacing: 0.1em; }
  p, li { color: var(--body); line-height: 1.6; }
  strong { color: var(--light); font-weight: 600; }
  em { color: var(--accent); font-style: normal; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: var(--card); padding: 2px 6px; border-radius: 4px; }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { color: var(--label); font-weight: 600; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  td { color: var(--body); border-bottom: 1px solid var(--border); padding: 8px 12px; }
  a { color: var(--accent); text-decoration: none; }
  blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--muted); font-style: italic; }
  footer { color: var(--muted); font-size: 0.6em; }
```

### Light Theme (Lab Meetings, Seminars, Printed Handouts)

Light backgrounds work better in well-lit rooms, on printed handouts, and for casual internal presentations.

```yaml
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400&display=swap');
  :root {
    --accent: #2563eb;
    --dark: #f8fafc;
    --card: #ffffff;
    --border: #e2e8f0;
    --body: #64748b;
    --label: #94a3b8;
    --muted: #cbd5e1;
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
  h1 { font-weight: 700; font-size: 2.8em; color: var(--light); margin-bottom: 0.2em; }
  h2 { font-weight: 300; font-size: 1.3em; color: var(--body); margin-top: 0; }
  h3 { font-weight: 600; font-size: 0.75em; color: var(--label); text-transform: uppercase; letter-spacing: 0.1em; }
  p, li { color: var(--body); line-height: 1.6; }
  strong { color: var(--light); font-weight: 600; }
  em { color: var(--accent); font-style: normal; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: var(--card); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  table { width: 100%; border-collapse: collapse; }
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

---

## Workflow: From Research to Slides

### Phase 1: Outline the Narrative Arc

Before writing any slides, determine the **story** you are telling. A research presentation is not a paper read aloud — it is a narrative with tension, evidence, and resolution.

**Standard research talk structure** (20-25 minute conference talk):

| Slide Group | Slides | Purpose |
|-------------|--------|---------|
| Title + Motivation | 1-3 | Hook the audience. What problem? Why care? |
| Background | 2-4 | What does the audience need to know? Only essentials. |
| Approach / Method | 3-5 | What did you do? High-level, visual. |
| Results | 4-8 | What happened? One result per slide. |
| Analysis / Discussion | 2-3 | What does it mean? Compare, interpret. |
| Conclusion + Future Work | 1-2 | Takeaways. What's next? |
| Thank You / Questions | 1 | Contact info, key references. |

**Shorter formats:**

| Format | Duration | Total Slides | Strategy |
|--------|----------|-------------|----------|
| Lightning talk | 5 min | 5-8 | Problem → Approach → One key result → Takeaway |
| Short paper | 10-12 min | 10-15 | Cut background to 1 slide, 2-3 results max |
| Full talk | 20-25 min | 18-25 | Full arc as above |
| Thesis defense | 45-60 min | 35-50 | Extended motivation, comprehensive results, deeper discussion |
| Lab meeting | 15-30 min | 10-20 | Flexible — can include preliminary/negative results |

### Phase 2: Draft Slides

Start with the Marp file structure. Use the title slide template, then fill in each group from the outline.

**Rules during drafting:**
1. Write the **slide title as a claim**, not a topic label. "Our method reduces latency by 40%" beats "Latency Results".
2. For every data slide, state the **takeaway** in the title or as a bold line. The audience should know what to conclude without reading the axes.
3. Use `<!-- _class: lead -->` for section divider slides (just a centered heading).
4. Put figure citations in a small footer: `<!-- _footer: "Figure adapted from Smith et al., 2024" -->`.
5. Never put a figure on a slide without at least one sentence explaining what the audience should see.

### Phase 3: Add Figures and Data

For research figures, you have two options:

**Option A: Pre-generated figures** (recommended for publication-quality plots)
- Use the `scientific-visualization` skill to create figures separately.
- Export as PNG/SVG and embed: `![w:600](./figures/result_comparison.png)`
- This gives full control over styling, annotations, and publication quality.

**Option B: Inline SVG** (for simple charts, diagrams, metrics)
- For metric cards, simple bar charts, or status indicators, inline SVG directly in the Markdown.
- Keeps everything in one file, no external dependencies.
- See the Component Library section below for reusable SVG patterns.

**For equations:**
- Use MathJax/KaTeX: `$\mathcal{L} = \sum_i \ell(f(x_i), y_i)$`
- For complex derivations, show only the key steps. Put full derivations in backup slides.

### Phase 4: Polish and Preview

1. **Preview** in VS Code with the Marp extension or convert with CLI:
   ```bash
   npx @marp-team/marp-cli slides.md --html --allow-local-files
   ```
2. **Check overflow** — scan every slide visually. Marp clips silently.
3. **Test projector mode** — open the HTML file full-screen. Check contrast and readability.
4. **Add speaker notes** (HTML comments after slide content):
   ```markdown
   <!-- This slide: emphasize the 40% improvement, mention baseline is SOTA from 2024 -->
   ```
5. **Export final format:**
   ```bash
   npx @marp-team/marp-cli slides.md --pdf --allow-local-files
   npx @marp-team/marp-cli slides.md --pptx --allow-local-files
   ```

---

## Slide Templates

### Title Slide

```markdown
---
marp: true
theme: default
paginate: true
math: mathjax
style: |
  /* paste dark or light theme CSS here */
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Your Paper Title Here
## Subtitle or Conference Name

**Author Name**, Co-Author Name
*University / Lab Affiliation*

Conference Name 2026
```

### Section Divider

```markdown
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Methodology

```

### Key Result Slide

```markdown
---

# Our method achieves 40% lower latency than the baseline

![w:700](./figures/latency_comparison.png)

- Measured on **benchmark-X** across 1000 trials
- Baseline: best published result from Smith et al. (2024)
```

### Comparison Slide (Two-Column)

```markdown
---

# Before vs. After: Query Processing Pipeline

<div style="display: flex; gap: 40px;">
<div style="flex: 1;">

### Before
- Sequential processing
- *120ms* average latency
- No caching layer

</div>
<div style="flex: 1;">

### After
- Parallel pipeline
- *72ms* average latency (40% reduction)
- LRU cache with 94% hit rate

</div>
</div>
```

### Data Table Slide

```markdown
---

# Comparison across all benchmarks

| Method | Accuracy | Latency (ms) | Memory (GB) |
|--------|----------|--------------|-------------|
| Baseline A | 78.2% | 120 | 4.2 |
| Baseline B | 81.5% | 95 | 6.1 |
| **Ours** | **86.3%** | **72** | **3.8** |

- Bold values indicate best in column
- All measurements averaged over 5 runs with std < 0.3%
```

### Equation Slide

```markdown
---

# Loss Function: Contrastive Objective

Our training objective combines supervised and self-supervised losses:

$$
\mathcal{L} = \underbrace{\mathcal{L}_{\text{CE}}(f(x), y)}_{\text{supervised}} + \lambda \underbrace{\mathcal{L}_{\text{CL}}(z_i, z_j)}_{\text{contrastive}}
$$

- $\lambda = 0.1$ selected via validation
- $z_i, z_j$ are augmented representations of the same input
```

### Thank You / Questions Slide

```markdown
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Thank You

Questions?

**your.email@university.edu** | github.com/yourname

Paper: arxiv.org/abs/2026.xxxxx
Code: github.com/yourname/project
```

---

## Component Library

### Metric Card (Inline SVG)

Use for highlighting key results on a summary slide:

```html
<div style="display: flex; gap: 24px; margin-top: 24px;">
  <div style="flex: 1; background: var(--card); border: 1px solid var(--border); border-top: 3px solid var(--accent); border-radius: 8px; padding: 20px;">
    <div style="color: var(--label); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.1em;">Accuracy</div>
    <div style="font-size: 2.2em; font-weight: 700; color: var(--light); margin: 4px 0;">86.3%</div>
    <div style="color: var(--green); font-size: 0.8em;">+4.8% vs baseline</div>
  </div>
  <div style="flex: 1; background: var(--card); border: 1px solid var(--border); border-top: 3px solid var(--green); border-radius: 8px; padding: 20px;">
    <div style="color: var(--label); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.1em;">Latency</div>
    <div style="font-size: 2.2em; font-weight: 700; color: var(--light); margin: 4px 0;">72ms</div>
    <div style="color: var(--green); font-size: 0.8em;">-40% vs baseline</div>
  </div>
  <div style="flex: 1; background: var(--card); border: 1px solid var(--border); border-top: 3px solid var(--yellow); border-radius: 8px; padding: 20px;">
    <div style="color: var(--label); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.1em;">Memory</div>
    <div style="font-size: 2.2em; font-weight: 700; color: var(--light); margin: 4px 0;">3.8GB</div>
    <div style="color: var(--green); font-size: 0.8em;">-9.5% vs baseline</div>
  </div>
</div>
```

### Simple Bar Chart (Inline SVG)

```html
<svg viewBox="0 0 500 200" style="width: 100%; max-width: 600px; margin: 20px auto; display: block;">
  <!-- Axis -->
  <line x1="60" y1="170" x2="480" y2="170" stroke="var(--border)" stroke-width="1"/>
  <!-- Bars -->
  <rect x="80" y="90" width="60" height="80" fill="var(--muted)" rx="4"/>
  <rect x="180" y="60" width="60" height="110" fill="var(--muted)" rx="4"/>
  <rect x="280" y="30" width="60" height="140" fill="var(--accent)" rx="4"/>
  <!-- Labels -->
  <text x="110" y="190" fill="var(--label)" font-size="12" text-anchor="middle">Baseline A</text>
  <text x="210" y="190" fill="var(--label)" font-size="12" text-anchor="middle">Baseline B</text>
  <text x="310" y="190" fill="var(--light)" font-size="12" text-anchor="middle" font-weight="600">Ours</text>
  <!-- Values -->
  <text x="110" y="82" fill="var(--body)" font-size="12" text-anchor="middle">78.2%</text>
  <text x="210" y="52" fill="var(--body)" font-size="12" text-anchor="middle">81.5%</text>
  <text x="310" y="22" fill="var(--accent)" font-size="13" text-anchor="middle" font-weight="600">86.3%</text>
</svg>
```

### Timeline / Roadmap

```html
<div style="display: flex; align-items: flex-start; gap: 0; margin-top: 32px;">
  <div style="flex: 1; text-align: center; position: relative;">
    <div style="width: 24px; height: 24px; background: var(--green); border-radius: 50%; margin: 0 auto 8px;"></div>
    <div style="color: var(--light); font-weight: 600; font-size: 0.85em;">Phase 1</div>
    <div style="color: var(--body); font-size: 0.75em;">Data Collection</div>
    <div style="color: var(--green); font-size: 0.7em;">Complete</div>
  </div>
  <div style="flex: 1; text-align: center;">
    <div style="width: 24px; height: 24px; background: var(--accent); border-radius: 50%; margin: 0 auto 8px;"></div>
    <div style="color: var(--light); font-weight: 600; font-size: 0.85em;">Phase 2</div>
    <div style="color: var(--body); font-size: 0.75em;">Model Training</div>
    <div style="color: var(--accent); font-size: 0.7em;">In Progress</div>
  </div>
  <div style="flex: 1; text-align: center;">
    <div style="width: 24px; height: 24px; background: var(--muted); border-radius: 50%; margin: 0 auto 8px;"></div>
    <div style="color: var(--light); font-weight: 600; font-size: 0.85em;">Phase 3</div>
    <div style="color: var(--body); font-size: 0.75em;">Evaluation</div>
    <div style="color: var(--muted); font-size: 0.7em;">Planned</div>
  </div>
</div>
```

---

## Common Issues and Solutions

### Overflow / Clipped Content

**Problem**: Text or figures extend beyond the slide boundary and are silently clipped.
**Solution**: Reduce content. Split into two slides. Use smaller font sizes as a last resort (never below 0.7em for body text). Always preview.

### Figures Look Blurry

**Problem**: Raster images appear pixelated on high-DPI displays or when projected.
**Solution**: Use SVG where possible. For raster images, export at 2x resolution (e.g., 300 DPI) and specify display size with `![w:600](figure.png)`.

### Math Not Rendering

**Problem**: Equations appear as raw LaTeX.
**Solution**: Add `math: mathjax` (or `math: katex`) to front matter. Ensure `$` delimiters are correct (no spaces after opening `$` or before closing `$`).

### Fonts Not Loading

**Problem**: Google Fonts don't appear in exported PDF.
**Solution**: Use `--allow-local-files` flag with marp-cli. For offline environments, download fonts and reference them locally. The `--html` flag may also be needed for custom font imports.

### Background Image Fills Wrong

**Problem**: `![bg](image.jpg)` stretches or mispositions the image.
**Solution**: Use sizing keywords: `![bg contain](image.jpg)` to fit without cropping, `![bg cover](image.jpg)` to fill with cropping, or `![bg 80%](image.jpg)` for percentage scaling.

### PPTX Export Looks Different

**Problem**: Exported PPTX doesn't match HTML preview.
**Solution**: PPTX export has limited CSS support. Simplify layouts for PPTX — avoid complex flexbox, inline SVG, and CSS variables. PDF export is more faithful to the HTML rendering.

---

## Integration with Other Skills

| Task | Skill to Combine |
|------|-----------------|
| Generate publication-quality figures for slides | `scientific-visualization` → export PNG/SVG → embed in Marp |
| Create diagrams and schematics for slides | `scientific-schematics` → export SVG → embed in Marp |
| Convert a paper draft into a talk | `paper-writing` for structure context → `marp-slides` for slide creation |
| Present literature review findings | `literature-search` for gathering → `marp-slides` for presentation |
| Present data analysis results | `data-analyze` for computation → `marp-slides` for visualization narrative |

---

## Export Reference

```bash
# HTML (best fidelity, interactive)
npx @marp-team/marp-cli slides.md --html --allow-local-files

# PDF (for sharing, printing)
npx @marp-team/marp-cli slides.md --pdf --allow-local-files

# PPTX (for editing in PowerPoint)
npx @marp-team/marp-cli slides.md --pptx --allow-local-files

# Watch mode (live preview during authoring)
npx @marp-team/marp-cli slides.md --watch --html --allow-local-files
```
