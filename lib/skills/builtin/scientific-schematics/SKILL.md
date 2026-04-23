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

- `iterations: 1` — use only when you want the first-pass output without
  review-driven rework.
- `iterations: 2` (default) — one draft plus one review-driven revision.
  The second pass uses image-to-image editing when the reviewer judges
  issues are cosmetic (needs_edit). When the reviewer flags structural
  problems (needs_regen) the second pass redraws from scratch with the
  blocking issues appended as negatives.
- `iterations: 3` — use for journal-quality figures where the first two
  passes are likely to leave blocking issues.

The tool stops early the moment a review comes back with verdict
`acceptable`, so higher `iterations` only costs API calls when needed.

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

The **output file extension decides the format**:

- `output: figures/foo.png` → raster via gpt-image-2 (needs
  `OPENAI_API_KEY`). Falls back to SVG-via-chat-model automatically
  when the key is missing; the file gets renamed to `.svg` in that
  case and the result payload reports `extensionChanged`.
- `output: figures/foo.svg` → **always** goes through the SVG-via-chat
  path, even when `OPENAI_API_KEY` is present. Choose this when you
  specifically want vector output (scales infinitely, small filesize,
  editable after the fact). Requires a chat model that can produce
  SVG — any configured model works, since the SVG path uses whichever
  model is driving the conversation.

### SVG fallback

The same verdict-driven iteration loop runs for both formats. In SVG
mode, generation and review both go through the chat model (the
reviewer reads the SVG source as text):

- `mode: "svg_fallback"` appears in the tool result and review log.
- Quality depends on the chat model's spatial reasoning. Claude Opus
  and GPT-4o / GPT-5 produce usable output for flowcharts, simple
  architecture, and box-and-arrow schemas. Pathway illustrations and
  complex circuits will be noticeably weaker than gpt-image-2.
- Self-grading bias is real: the generator and reviewer are usually
  the same model, so thresholds are set marginally higher to
  compensate. Scores across raster and SVG modes are not directly
  comparable.

To embed an SVG in Markdown:

```markdown
![Figure 1: workflow](figures/workflow.svg)
```

Most Markdown renderers (GitHub, typical preview extensions) and
Milkdown render SVG inline just like PNG.
