# Scientific Schematics - Quick Reference

**How it works:** Describe your diagram → AI generates it via OpenRouter automatically

Path convention: use `@skill/...` for skill files and `@ws/...` for workspace inputs/outputs in shell commands.

## Setup (One-Time)

Default image model: `google/gemini-3-pro-image-preview`. Normal skill usage does not require choosing a model.

```bash
# Required
export OPENROUTER_API_KEY='your-openrouter-api-key'
```

## Basic Usage

```bash
# Describe your diagram, AI creates it
python @skill/scripts/generate_schematic.py "your diagram description" -o @ws/output.png

# That's it! Automatic:
# - Iterative refinement (up to 2 rounds)
# - Quality review and improvement
# - Publication-ready output
```

## Common Examples

### CONSORT Flowchart
```bash
python @skill/scripts/generate_schematic.py \
  "CONSORT flow: screened n=500, excluded n=150, randomized n=350" \
  -o @ws/consort.png
```

### Neural Network
```bash
python @skill/scripts/generate_schematic.py \
  "Transformer architecture with encoder and decoder stacks" \
  -o @ws/transformer.png
```

### Biological Pathway
```bash
python @skill/scripts/generate_schematic.py \
  "MAPK pathway: EGFR → RAS → RAF → MEK → ERK" \
  -o @ws/mapk.png
```

### Circuit Diagram
```bash
python @skill/scripts/generate_schematic.py \
  "Op-amp circuit with 1kΩ resistor and 10µF capacitor" \
  -o @ws/circuit.png
```

## Command Options

| Option | Description | Example |
|--------|-------------|---------|
| `-o, --output` | Output file path | `-o @ws/figures/diagram.png` |
| `--iterations N` | Number of refinements (1-2) | `--iterations 2` |
| `-v, --verbose` | Show detailed output | `-v` |

## Prompt Tips

### Good Prompts (Specific)
- "CONSORT flowchart with screening (n=500), exclusion (n=150), randomization (n=350)"
- "Transformer architecture: encoder on left with 6 layers, decoder on right, cross-attention connections"
- "MAPK signaling: receptor → RAS → RAF → MEK → ERK → nucleus, label each phosphorylation"

### Avoid (Too Vague)
- "Make a flowchart"
- "Neural network"
- "Pathway diagram"

## Output Files

For input `@ws/diagram.png`, you get:
- `@ws/diagram_v1.png` - First iteration
- `@ws/diagram_v2.png` - Second iteration
- `@ws/diagram.png` - Copy of final
- `@ws/diagram_review_log.json` - Quality scores and critiques

## Review Log

```json
{
  "iterations": [
    {
      "iteration": 1,
      "score": 7.0,
      "critique": "Good start. Font too small..."
    },
    {
      "iteration": 2,
      "score": 8.5,
      "critique": "Much improved. Minor spacing issues..."
    },
  ],
  "final_score": 8.5
}
```

## Supported Automation Interface

```bash
python @skill/scripts/generate_schematic.py "diagram description" -o @ws/output.png --iterations 2
```

Use the CLI wrapper inside workflows. Do not rely on importing private
skill modules directly from Python.

## Troubleshooting

### API Key Not Found
```bash
# Set your OpenRouter API key
export OPENROUTER_API_KEY='your-api-key'
```

### Import Error
```bash
# Install requests
pip install requests
```

### Low Quality Score
- Make prompt more specific
- Include layout details (left-to-right, top-to-bottom)
- Specify label requirements
- Increase iterations: `--iterations 2`

## Testing

```bash
# Smoke test
python @skill/scripts/generate_schematic.py "test diagram" -o @ws/test.png -v
```

## Cost

Typical cost per diagram (max 2 iterations):
- Simple (1 iteration): $0.05-0.15
- Complex (2 iterations): $0.10-0.30

## How It Works

**Simply describe your diagram in natural language:**
- No coding required
- No templates needed
- No manual drawing
- Automatic quality review
- Publication-ready output
- Works for any diagram type

**Just describe what you want, and it's generated automatically.**

## Getting Help

```bash
# Show help
python @skill/scripts/generate_schematic.py --help

# Verbose mode for debugging
python @skill/scripts/generate_schematic.py "diagram" -o @ws/out.png -v
```

## Quick Start Checklist

- [ ] Set `OPENROUTER_API_KEY`
- [ ] Run `python @skill/scripts/generate_schematic.py "test diagram" -o @ws/test.png -v`
- [ ] Review output files (test_v1.png, test_v2.png, review_log.json)
- [ ] Read SKILL.md for detailed documentation
- [ ] Check README.md for examples

## Resources

- Full documentation: `@skill/SKILL.md`
- Detailed guide: `@skill/references/README.md`
- Example script: `@skill/scripts/example_usage.sh`
