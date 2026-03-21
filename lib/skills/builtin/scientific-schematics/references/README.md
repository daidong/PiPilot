# Scientific Schematics - Vertex AI

**Generate any scientific diagram by describing it in natural language.**

Vertex AI image models create publication-quality diagrams automatically - no coding, no templates, no manual drawing required.

## Quick Start

Default image model: `gemini-3-pro-image-preview`. Normal skill usage does not require model selection.

### Generate Any Diagram

```bash
# Set your Google Cloud project
export GOOGLE_CLOUD_PROJECT='your-project-id'
export GOOGLE_CLOUD_LOCATION='global'

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
3. **Generation 2**: Improve based on critique
4. **Review 2**: Second evaluation with specific feedback
5. **Generation 3**: Final polished version

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

### For AI Generation

```bash
# Set Google Cloud project and location
export GOOGLE_CLOUD_PROJECT='your-project-id'
export GOOGLE_CLOUD_LOCATION='global'
export GOOGLE_CLOUD_IMAGE_LOCATION='us-central1'   # optional; needed for Imagen

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
- `@ws/figures/consort_v2.png` - After first review
- `@ws/figures/consort_v3.png` - Final version
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
  -v, --verbose          Verbose output
  -h, --help             Show help message
```

## Supported Automation Interface

Use the CLI wrapper as the supported interface inside RAM:

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
✓ "Flowchart with vertical flow, top to bottom"  
✓ "Architecture diagram with encoder on left, decoder on right"  
✗ "Make a diagram" (too vague)

### Include Quantitative Details
✓ "Neural network: input (784), hidden (128), output (10)"  
✓ "Flowchart: n=500 screened, n=150 excluded, n=350 randomized"  
✗ "Some numbers" (not specific)

### Specify Visual Style
✓ "Minimalist block diagram with clean lines"  
✓ "Detailed biological pathway with protein structures"  
✓ "Technical schematic with engineering notation"

### Request Specific Labels
✓ "Label all arrows with activation/inhibition"  
✓ "Include layer dimensions in each box"  
✓ "Show time progression with timestamps"

### Mention Color Requirements
✓ "Use colorblind-friendly colors"  
✓ "Grayscale-compatible design"  
✓ "Color-code by function: blue=input, green=processing, red=output"

## Review Log Format

Each generation produces a JSON review log:

```json
{
  "user_prompt": "CONSORT participant flow diagram...",
  "iterations": [
    {
      "iteration": 1,
      "image_path": "figures/consort_v1.png",
      "prompt": "Full generation prompt...",
      "critique": "Score: 7/10. Issues: font too small...",
      "score": 7.0,
      "success": true
    },
    {
      "iteration": 2,
      "image_path": "figures/consort_v2.png",
      "score": 8.5,
      "critique": "Much improved. Remaining issues..."
    },
    {
      "iteration": 3,
      "image_path": "figures/consort_v3.png",
      "score": 9.5,
      "critique": "Excellent. Publication ready."
    }
  ],
  "final_image": "figures/consort_v3.png",
  "final_score": 9.5,
  "success": true
}
```

Note: in review log JSON, file paths are stored as raw workspace-relative paths (`figures/...`), not scoped command prefixes.

## Why Use Vertex AI Image Generation

**Simply describe what you want - Vertex AI creates it:**

- ✓ **Fast**: Results in minutes
- ✓ **Easy**: Natural language descriptions (no coding)
- ✓ **Quality**: Automatic review and refinement
- ✓ **Universal**: Works for all diagram types
- ✓ **Publication-ready**: High-quality output immediately

**Just describe your diagram, and it's generated automatically.**

## Troubleshooting

### Vertex Credential Issues

```bash
# Check project / ADC state
echo $GOOGLE_CLOUD_PROJECT
gcloud auth application-default print-access-token

# Set the project explicitly
export GOOGLE_CLOUD_PROJECT='your-project-id'
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

# Check Vertex auth + project
gcloud config get-value project
gcloud auth print-access-token | head -c 20
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

Vertex AI image generation pricing varies by Gemini image model or Imagen backend:
- **Vertex AI image generation**: varies by Gemini image model or Imagen backend

Typical costs per diagram:
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

Part of the scientific-writer package. See main repository for license information.
