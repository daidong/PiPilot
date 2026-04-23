---
name: scientific-schematics
description: Prompt guidance for the generate_diagram tool — how to describe different scientific diagram types (flowcharts, pathways, architecture, circuits, networks, conceptual) so the tool produces publication-grade output on the first iteration.
category: Visualization
tags: [science, visualization, diagrams]
triggers: [diagram, schematic, flowchart, architecture diagram, pathway, circuit, 示意图, 流程图]
allowed-tools: [Read, Write, Edit]
license: MIT license
metadata:
    skill-author: Dong Dai
---

# Scientific Schematics

## Scope of this skill

This skill **does not generate images**. Image generation is owned by the
`generate_diagram` tool, which runs a provider-backed generate → review →
(optional) edit loop. The tool is always available; this skill is only
loaded to sharpen the prompt the tool receives.

Use this skill to:
1. Pick the right `diagram_type` parameter for the request.
2. Write a description that names components, labels, quantities, and
   flow direction unambiguously (LLM image models hallucinate when these
   are vague).
3. Choose an appropriate `doc_type` so the reviewer applies the right
   quality threshold.
4. Embed the resulting image in the document correctly.

Do not write custom Python, shell, or SVG — the tool produces the image.

---

## Tool usage

Call the `generate_diagram` tool with:

```
prompt:         <description crafted using the guidance below>
output:         figures/<name>.png
doc_type:       journal | conference | thesis | grant | preprint |
                report | poster | presentation | default
diagram_type:   flowchart | architecture | pathway | circuit |
                network | conceptual | auto
iterations:     1 | 2 | 3   (default 2)
aspect:         auto | square | landscape | portrait   (default auto)
quality:        low | medium | high | auto   (default derived from doc_type)
format:         auto | png | svg   (default auto — inferred from output extension)
```

**aspect guidance** — the default `auto` lets the model pick, but
when you already know the figure's shape, set it explicitly:
- `landscape` for wide architecture diagrams, left-to-right pipelines,
  multi-panel (3+ columns) layouts
- `portrait` for CONSORT/PRISMA flows, top-to-bottom pathway cascades,
  tall hierarchies
- `square` for single-concept schematics, cycles, small callouts
- `auto` when the shape is genuinely ambiguous or the prompt already
  describes the layout strongly

**quality guidance** — gpt-image-2 exposes four tiers; the cost and
render time roughly follow low < medium < high. Omitting the field
selects a sensible default from `doc_type`:

| doc_type                             | default quality |
|--------------------------------------|-----------------|
| journal / conference / thesis / grant| high            |
| preprint / report / poster           | medium          |
| presentation                         | low             |
| default                              | medium          |

The loop automatically bumps one tier on a `needs_edit` verdict, so the
first iteration runs cheap and refinement only spends more compute when
the reviewer signals the draft was close-but-not-there. Override with
`quality: "low"` for explicit exploration / drafts, or `"high"` to force
camera-ready on the first pass.

The tool returns the final image path, per-iteration review scores,
the quality tier used for each iteration, the verdict trail
(acceptable / needs_edit / needs_regen), and a JSON review log at
`<name>_review_log.json`.

When `diagram_type: auto`, the tool infers from keywords in the prompt.
Explicit types beat inference when you know what you want.

### Internal prompt structure

Under the hood the tool converts your `prompt` into a fixed-slot
production brief that gpt-image-2 parses reliably:

```
【SCENE / USE】  publication-grade scientific <diagram_type>
【SUBJECT】      <your prompt verbatim>
【COMPOSITION】  <derived from diagram_type and aspect>
【KEY DETAILS】  <type-specific rules + typography + colour>
【TEXT】          render every quoted literal verbatim
【MUST KEEP】    <auto-extracted: quoted strings, n=X, numeric+unit>
【AVOID】         no figure numbers, titles, captions, 3D, mascots
```

Two practical consequences for **how you write the prompt**:

1. **Put every label, number, and identifier in quotes.** The tool
   auto-extracts quoted strings (and `n=...`, `1kΩ` / `10µF` / `128
   nodes` style numeric+unit tokens) into a `MUST KEEP` checklist the
   model must render verbatim. `"EGFR"` survives better than just
   EGFR; `"n=350"` survives better than just n=350.
2. **Describe in fixed-slot order when you can** — scene/use → subject
   → key details → composition → text → must-keep → avoid. The tool
   will structure whatever you write, but pre-structured prose rewrites
   less aggressively.

### Iterative refinement

To revise an already-good diagram, pass `reference_path` (and
`reference_mode: revise_layout` — the default) pointing at the
existing image. The tool treats iteration 1 as a surgical edit:
it tells gpt-image-2 to keep layout, colour, and positions unchanged
unless the specific blocking issues from review require otherwise.

---

## Diagram types and how to describe them

### flowchart
Use for CONSORT, PRISMA, study-design flow, decision trees, swimlanes.

Required in prompt:
- Every node's label (exact text)
- Every arrow's source and target
- Exact counts (n = …), conditions, yes/no labels
- Flow direction (top-to-bottom default)

Example:
> CONSORT participant flow, vertical top-to-bottom. Boxes:
> "Assessed for eligibility (n=500)" → split into
> "Excluded (n=150): age<18 n=80, declined n=50, other n=20"
> (right branch) and "Randomized (n=350)" (down). "Randomized" splits to
> "Treatment (n=175)" and "Control (n=175)". Each arm shows
> "Lost to follow-up (n=15 / n=10)" then "Analyzed (n=160 / n=165)".
> Colour: blue for process, orange for exclusion, green for analysis.

### architecture
Use for system diagrams, microservices, data pipelines, block diagrams.

Required in prompt:
- Every block's label and role
- Layering or grouping (what belongs together)
- Connection direction + protocol/interface labels on edges
- Any shared boundaries (VPC, cluster, device)

Example:
> IoT monitoring architecture, three layers stacked vertically.
> Bottom layer (sensors): "Temperature", "Humidity", "Motion" in green
> boxes. Middle layer: "ESP32 microcontroller" in blue; connects up via
> "WiFi" and sideways to "Local display". Top layer: "Cloud server" in
> grey, connected to "Mobile app" in light blue. Edges labelled with
> protocols (I2C, UART, WiFi, HTTPS).

### pathway
Use for signalling cascades, metabolic pathways, gene regulation,
protein-protein interaction maps.

Required in prompt:
- Every molecule by its symbol
- Arrow type: activation (→) vs inhibition (⊣)
- Exact order and compartments (cytoplasm, nucleus, membrane)
- Post-translational modifications if relevant

Example:
> MAPK signalling pathway, top-to-bottom. Cell membrane at top with
> "EGFR receptor" embedded. Below: "RAS-GTP" (oval) → "RAF" → "MEK" →
> "ERK" (all kinases, rectangles). "ERK" arrow crosses nuclear envelope
> (dashed line) to "Transcription factors" in the nucleus. Label each
> arrow "phosphorylation". Okabe-Ito palette.

### circuit
Use for analogue/digital circuits, signal chains, power systems.

Required in prompt:
- Every component type with value + unit (1kΩ, 10µF, 5V)
- Ground and supply nets
- Wire crossings: dot = connection, no dot = jump

Example:
> Non-inverting op-amp amplifier. Input signal on left connects via
> 1kΩ resistor (R1) to the + input of an op-amp. Feedback: output
> through 10kΩ (R2) to − input, and 1kΩ (R3) from − input to ground.
> Supply rails ±12V. Output on the right. Standard IEEE symbols.

### network
Use for neural network architectures, graphs, trees, org charts.

Required in prompt:
- Node types and dimensions where applicable (Dense 128, Conv 3×3)
- Edge semantics (data flow vs attention vs skip)
- Hierarchy direction

Example:
> Transformer encoder-decoder, two stacks side by side. Encoder (left,
> light blue): "Input embedding" → "Positional encoding" → 6× {Multi-head
> self-attention, Add & Norm, Feed-forward, Add & Norm}. Decoder (right,
> light red): "Output embedding" → "Positional encoding" → 6× {Masked
> self-attention, Add & Norm, Cross-attention (dashed edge from encoder
> top to decoder cross-attention), Add & Norm, Feed-forward, Add & Norm}.
> → Linear → Softmax. Label every block.

### conceptual
Use for frameworks, theoretical models, idea maps, whiteboard-style
diagrams. Looser rules, more artistic licence.

Required in prompt:
- Core concepts grouped by category
- Relationships between categories
- Any visual metaphor you want (layers, concentric rings, Venn)

---

## doc_type thresholds

| doc_type      | Behaviour |
|---------------|-----------|
| journal       | Strictest threshold; accept only near-camera-ready output. |
| conference    | Strict; small cosmetic issues allowed. |
| thesis, grant | Same bar as conference. |
| preprint, report | Standard threshold. |
| poster        | Tolerates larger labels and bolder colours. |
| presentation  | Lowest threshold; optimised for first-pass speed. |
| default       | Middle of the range. |

Exact numeric thresholds depend on the review provider and are not
directly comparable across providers (see the tool's review log for the
applied threshold on each run).

---

## Iteration strategy

Default is **2 iterations** for almost every case. Do not bump to 3
without concrete evidence — the third iteration frequently *regresses*
a fix from the second, and the tool now detects this and stops early
anyway (see "Regression detection" below).

- `iterations: 1` — only when you want the first-pass output without
  any review-driven rework.
- `iterations: 2` (default) — one draft plus one review-driven revision.
  The second pass uses image-to-image editing when the reviewer judges
  issues are cosmetic (needs_edit). When the reviewer flags structural
  problems (needs_regen) the second pass redraws from scratch.
- `iterations: 3` — only when iter 2 is expected to still be below
  threshold. Good signals: `doc_type: journal | conference` AND the
  prompt asks for something dense (many labels, multi-panel, intricate
  relationships). Bad signals: `doc_type: presentation | poster`,
  single-concept diagrams, simple flowcharts.

The tool stops early the moment a review comes back with verdict
`acceptable`, so higher `iterations` costs nothing when not needed —
but each *unnecessary* iteration risks the model undoing earlier
corrections.

### Relaxed acceptance

When the reviewer returns `needs_edit` but the score is comfortably
above threshold (**≥ threshold + 1.0**) and no critical issues remain
(`wrong_content`, `missing_element`, `illegible_text`), the tool
promotes the verdict to `acceptable` and stops. Cosmetic notes
(`layout_collision`, `style_mismatch`) do not force another round
when the diagram is already well past the bar.

### Regression detection

The tool tracks which blocking issues the reviewer stops complaining
about between iterations — those are the corrections we want to keep.
Each subsequent edit prompt explicitly reminds the model of the
already-fixed items and forbids regressing them. If the reviewer in a
later draft nevertheless re-introduces an issue from that fixed set,
the loop terminates early with `stoppedReason: "regression_detected"`
and the current best draft is returned. Two common causes of
regression:

- Too many iterations on a diagram that is already good enough (ships
  a new cosmetic flaw while fixing an old cosmetic flaw).
- Prompt overspecification — the original request listed dozens of
  tiny details, and the model keeps dropping a different one each
  round.

When you see `regressedIssues` or `stoppedReason: "regression_detected"`
in the review log, prefer the current output over re-running with
more iterations; re-running usually makes it worse.

---

## Embedding the result in documents

The tool saves the final image to the exact `output` path you specified
(plus versioned `_v1.png`, `_v2.png`, … siblings for debugging, and a
`_review_log.json` next to them).

Embed with markdown image syntax. **The path is relative to the markdown
file you are writing, not the workspace root.**

Markdown at workspace root (`paper.md`) and tool output at `figures/consort.png`:
```markdown
![Figure 2: CONSORT participant flow](figures/consort.png)
```

Markdown in a subdirectory (`workspace/paper_draft.md`):
```markdown
![Figure 2: CONSORT participant flow](../figures/consort.png)
```

Rule of thumb: prepend `../` per directory the markdown file is below
the workspace root.

Always include the `![...](...)` embed — do not only reference the
figure in prose ("see Figure 1"), or the rendered document will not
show the image.

---

## What the tool does NOT do

- It does not embed figures into your document — you must add the
  markdown image syntax yourself.
- It does not cite figures in text — write the narrative reference too.
- It does not deduplicate across iterations; the `_v1.png` and `_v2.png`
  intermediates are left on disk for inspection.

---

## Configuration

Raster image generation (gpt-image-2) requires `OPENAI_API_KEY`
(set under Settings → API Keys). Review uses either OpenAI or
Anthropic based on Settings → Diagrams. The `auto` setting prefers
Claude when both keys are available, so the generator does not grade
its own family.

### Output format selection (png vs svg)

Format intent flows through two redundant channels — either is enough,
and when they disagree the explicit `format` parameter wins:

1. **Explicit `format` parameter** — use this when the user said
   something format-specific in the prompt:
   - "SVG / 矢量图 / vector / 向量图" → `format: "svg"`
   - "PNG / 图片 / raster / bitmap" → `format: "png"`
   - Otherwise omit (defaults to `auto`).
2. **Output filename extension** — `output: figures/foo.svg` implies
   `format: "svg"`, `output: figures/foo.png` implies `format: "png"`.
   The tool will rewrite the extension to match `format` if they
   disagree (and report `extensionChanged` in the result so you know
   to update any Markdown embed).

Behavioural summary:

- `format: "svg"` (or `.svg` extension) → **always** synthesises SVG
  via the chat model, even when `OPENAI_API_KEY` is present. Choose
  this for vector output (scales infinitely, small filesize, editable).
- `format: "png"` (or `.png` extension, the default) → raster via
  `gpt-image-2` when `OPENAI_API_KEY` is configured. Falls back to
  SVG-via-chat-model automatically when the key is missing; the file
  is renamed `.svg` and `extensionChanged` is reported.

### SVG fallback

The same verdict-driven iteration loop runs for both formats. In SVG
mode, generation goes through the chat model, and review picks the
strongest option available at runtime:

1. **Rasterise-then-vision (preferred)** — when an offscreen renderer
   is available (Electron main process) and a real vision reviewer
   (OpenAI or Anthropic) is configured, the generated SVG is
   rendered to PNG and passed to the vision model. This catches text
   overflow, element overlap, and other problems invisible at the
   SVG-source level.
2. **Source-level fallback** — when rasterisation is unavailable (e.g.
   running outside Electron) or no vision reviewer auth is present,
   the reviewer reads the SVG markup as text. Structural checks work;
   visual-layout checks do not.

Other SVG-mode notes:

- `mode: "svg_fallback"` appears in the tool result and review log.
  The provider id distinguishes the two review paths:
  `rasterize+openai:…` or `rasterize+anthropic:…` vs
  `svg-fallback:…`.
- Quality of the SVG itself depends on the chat model's spatial
  reasoning. Claude Opus and GPT-4o / GPT-5 produce usable output for
  flowcharts, simple architecture, and box-and-arrow schemas. Pathway
  illustrations and complex circuits will be noticeably weaker than
  gpt-image-2.
- Self-grading bias only applies in the source-level path (same model
  reads back its own SVG). The rasterise-then-vision path sends the
  rendered image to a different model, so bias is negligible.
- Scores across raster and SVG modes are still not directly
  comparable — thresholds are calibrated per reviewer and per path.

To embed an SVG in Markdown:

```markdown
![Figure 1: workflow](figures/workflow.svg)
```

Most Markdown renderers (GitHub, typical preview extensions) and
Milkdown render SVG inline just like PNG.
