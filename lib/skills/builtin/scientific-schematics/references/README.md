# Scientific Schematics - OpenRouter API

**Generate any scientific diagram by describing it in natural language.**

AI image models create publication-quality diagrams automatically via OpenRouter - no coding, no templates, no manual drawing required.

## Quick Start

Default image model: `google/gemini-3-pro-image-preview`. Normal skill usage does not require model selection.

### Generate Any Diagram

```bash
# Set your OpenRouter API key
export OPENROUTER_API_KEY='your-openrouter-api-key'

# Generate any scientific diagram
python @skill/scripts/generate_schematic.py "CONSORT participant flow diagram" -o @ws/figures/consort.png

# Neural network architecture
python @skill/scripts/generate_schematic.py "Transformer encoder-decoder architecture" -o @ws/figures/transformer.png

# Biological pathway
python @skill/scripts/generate_schematic.py "MAPK signaling pathway" -o @ws/figures/pathway.png
```

### Path Conventions

- Shell commands in this document use scoped paths:
  - `@skill/...` points to skill-owned files.
  - `@ws/...` points to workspace files.
- Python API examples and generated review logs use raw filesystem paths (often workspace-relative like `figures/...`).

### What You Get

- **Up to two iterations** (v1, v2) with progressive refinement
- **Automatic quality review** after each iteration
- **Detailed review log** with scores and critiques (JSON format)
- **Publication-ready images** following scientific standards

## Features

### Iterative Refinement Process

1. **Generation 1**: Create initial diagram from your description
2. **Review 1**: AI evaluates clarity, labels, accuracy, accessibility
3. **Decision**: If quality meets threshold → DONE; otherwise continue
4. **Generation 2**: Improve based on critique
5. **Review 2**: Second evaluation with specific feedback

### Automatic Quality Standards

All diagrams automatically follow:
- Clean white/light background
- High contrast for readability
- Clear labels (minimum 10pt font)
- Professional typography
- Colorblind-friendly colors
- Proper spacing between elements
- Scale bars, legends, axes where appropriate

## Installation

```bash
# Set OpenRouter API key
export OPENROUTER_API_KEY='your-openrouter-api-key'

# Install Python dependencies (if not already installed)
pip install requests
```

## Usage Examples

### Example 1: CONSORT Flowchart

```bash
python @skill/scripts/generate_schematic.py \
  "CONSORT participant flow diagram for RCT. \
   Assessed for eligibility (n=500). \
   Excluded (n=150): age<18 (n=80), declined (n=50), other (n=20). \
   Randomized (n=350) into Treatment (n=175) and Control (n=175). \
   Lost to follow-up: 15 and 10 respectively. \
   Final analysis: 160 and 165." \
  -o @ws/figures/consort.png
```

**Output:**
- `@ws/figures/consort_v1.png` - Initial generation
- `@ws/figures/consort_v2.png` - After review (if needed)
- `@ws/figures/consort.png` - Copy of final version
- `@ws/figures/consort_review_log.json` - Detailed review log

### Example 2: Neural Network Architecture

```bash
python @skill/scripts/generate_schematic.py \
  "Transformer architecture with encoder on left (input embedding, \
   positional encoding, multi-head attention, feed-forward) and \
   decoder on right (masked attention, cross-attention, feed-forward). \
   Show cross-attention connection from encoder to decoder." \
  -o @ws/figures/transformer.png \
  --iterations 2
```

### Example 3: Biological Pathway

```bash
python @skill/scripts/generate_schematic.py \
  "MAPK signaling pathway: EGFR receptor → RAS → RAF → MEK → ERK → nucleus. \
   Label each step with phosphorylation. Use different colors for each kinase." \
  -o @ws/figures/mapk.png
```

### Example 4: System Architecture

```bash
python @skill/scripts/generate_schematic.py \
  "IoT system block diagram: sensors (bottom) → microcontroller → \
   WiFi module and display (middle) → cloud server → mobile app (top). \
   Label all connections with protocols." \
  -o @ws/figures/iot_system.png
```

## Command-Line Options

```bash
python @skill/scripts/generate_schematic.py [OPTIONS] "description" -o @ws/output.png

Options:
  --iterations N          Number of AI refinement iterations (default: 2, max: 2)
  --doc-type TYPE         Document type for quality threshold (journal, poster, etc.)
  --image-model MODEL     Override image generation model
  --review-model MODEL    Override review model
  -v, --verbose          Verbose output
  -h, --help             Show help message
```

## Supported Automation Interface

Use the CLI wrapper as the supported interface:

```bash
python @skill/scripts/generate_schematic.py \
  "CONSORT flowchart" \
  -o @ws/figures/consort.png \
  --iterations 2
```

This skill does not ship as an installable Python package, so avoid direct
`import scripts.generate_schematic_ai` patterns.

## Prompt Engineering Tips

### Be Specific About Layout
- "Flowchart with vertical flow, top to bottom"
- "Architecture diagram with encoder on left, decoder on right"
- Avoid: "Make a diagram" (too vague)

### Include Quantitative Details
- "Neural network: input (784), hidden (128), output (10)"
- "Flowchart: n=500 screened, n=150 excluded, n=350 randomized"

### Specify Visual Style
- "Minimalist block diagram with clean lines"
- "Detailed biological pathway with protein structures"
- "Technical schematic with engineering notation"

### Request Specific Labels
- "Label all arrows with activation/inhibition"
- "Include layer dimensions in each box"
- "Show time progression with timestamps"

### Mention Color Requirements
- "Use colorblind-friendly colors"
- "Grayscale-compatible design"
- "Color-code by function: blue=input, green=processing, red=output"

## Review Log Format

Each generation produces a JSON review log:

```json
{
  "user_prompt": "CONSORT participant flow diagram...",
  "doc_type": "default",
  "quality_threshold": 7.5,
  "iterations": [
    {
      "iteration": 1,
      "image_path": "figures/consort_v1.png",
      "score": 7.0,
      "critique": "Score: 7/10. Issues: font too small...",
      "success": true
    },
    {
      "iteration": 2,
      "image_path": "figures/consort_v2.png",
      "score": 8.5,
      "critique": "Much improved. Publication ready."
    }
  ],
  "final_image": "figures/consort_v2.png",
  "final_score": 8.5,
  "success": true,
  "early_stop": true,
  "early_stop_reason": "Quality score 8.5 meets threshold 7.5 for default"
}
```

Note: in review log JSON, file paths are stored as raw workspace-relative paths (`figures/...`), not scoped command prefixes.

## Why Use AI Image Generation

**Simply describe what you want - AI creates it:**

- **Fast**: Results in minutes
- **Easy**: Natural language descriptions (no coding)
- **Quality**: Automatic review and refinement
- **Universal**: Works for all diagram types
- **Publication-ready**: High-quality output immediately

**Just describe your diagram, and it's generated automatically.**

## Troubleshooting

### API Key Issues

```bash
# Check API key is set
echo $OPENROUTER_API_KEY

# Set it if missing
export OPENROUTER_API_KEY='your-api-key'
```

### Import Errors

```bash
# Install requests library
pip install requests
```

### Generation Fails

```bash
# Use verbose mode to see detailed errors
python @skill/scripts/generate_schematic.py "diagram" -o @ws/out.png -v
```

### Low Quality Scores

If iterations consistently score below 7/10:
1. Make your prompt more specific
2. Include more details about layout and labels
3. Specify visual requirements explicitly
4. Increase iterations: `--iterations 2`

## Testing

Run a simple smoke test:

```bash
python @skill/scripts/generate_schematic.py "test diagram" -o @ws/test.png -v
```

## Cost Considerations

Costs depend on the models used via OpenRouter. Typical costs per diagram:
- Simple diagram (1 iteration): ~$0.05-0.15
- Complex diagram (2 iterations): ~$0.10-0.30

## Examples Gallery

See the full SKILL.md for extensive examples including:
- CONSORT flowcharts
- Neural network architectures (Transformers, CNNs, RNNs)
- Biological pathways
- Circuit diagrams
- System architectures
- Block diagrams

## Support

For issues or questions:
1. Check SKILL.md for detailed documentation
2. Run a verbose smoke test with `python @skill/scripts/generate_schematic.py "test diagram" -o @ws/test.png -v`
3. Use verbose mode (-v) to see detailed errors
4. Review the review_log.json for quality feedback

## License

Part of the scientific-schematics skill. See main repository for license information.
