/**
 * Prompt composition for diagram generation.
 *
 * Three inputs merge into the final prompt:
 *   - base scientific-diagram guidelines (constant)
 *   - diagram-type-specific emphasis (varies by DiagramType)
 *   - user's natural-language description
 *
 * When skill guidance is loaded, the agent may replace this layer by crafting
 * its own prompt; when not, this fallback produces publication-grade output.
 */

import type { BlockingIssue, DiagramType } from './types.js'

export const BASE_GUIDELINES = `Create a high-quality scientific diagram with these requirements:

VISUAL QUALITY:
- Clean white or light background, no textures or gradients.
- Flat vector illustration, academic aesthetic (DeepMind / OpenAI paper figure style).
- High contrast for print and digital reading.
- Sharp, clear lines and text; no anti-aliasing artifacts.
- Adequate spacing between elements.

TYPOGRAPHY:
- Sans-serif fonts (Arial or Helvetica style), minimum 10pt.
- Consistent sizes; all text horizontal.
- No overlapping text.

SCIENTIFIC STANDARDS:
- Accurate concept representation.
- Clear labels on every component.
- Standard notation and symbols; units included where applicable.

ACCESSIBILITY:
- Okabe-Ito palette preferred for colour.
- Redundant encoding (shape + colour, not colour alone).
- Readable in grayscale.

LAYOUT:
- Logical flow (left-to-right, top-to-bottom, or deliberate circular/radial).
- Clear visual hierarchy, balanced composition, appropriate whitespace.

IMPORTANT — NO FIGURE NUMBERS OR CAPTIONS:
- Do not embed "Figure 1:", "Fig. 1", titles, or captions in the image.
- Figure numbers and captions are added separately in the document.

NEGATIVE CONSTRAINTS:
- No photorealistic images, no sketchy lines, no 3D shading artifacts, no unreadable text.`

const DIAGRAM_TYPE_GUIDANCE: Record<Exclude<DiagramType, 'auto'>, string> = {
  flowchart: `FLOWCHART EMPHASIS:
- Use standard shapes: rectangle = process, diamond = decision, rounded rectangle = start/end.
- Arrows must point unambiguously from source to target.
- Numeric counts (n=…), conditions, and yes/no labels on branches are MANDATORY when mentioned.
- Vertical top-to-bottom flow is preferred unless specified otherwise.`,

  architecture: `SYSTEM ARCHITECTURE EMPHASIS:
- Layered or blocked composition; each component is a labelled box.
- Show data flow direction with arrows; annotate protocols/interfaces on edges.
- Group related components visually (shared background tint or dashed boundary).
- Consistent box sizes within a layer.`,

  pathway: `BIOLOGICAL PATHWAY EMPHASIS:
- Every molecule/gene/protein is labelled with its symbol.
- Arrows must distinguish activation (→) from inhibition (⊣ or ⊥).
- Preserve the exact order and directionality specified.
- Use standard shapes: oval for molecules, rectangle for complexes, rounded for processes.
- Include compartments (cell membrane, nucleus) when relevant.`,

  circuit: `CIRCUIT DIAGRAM EMPHASIS:
- Use standard electronic symbols (IEEE/IEC): resistor zigzag, capacitor parallel lines, ground triangle.
- Label component values with units (1kΩ, 10µF, 5V).
- Wires cross with dot = connection, no dot = jump-over.
- Ground references and power rails should be clearly marked.`,

  network: `NETWORK / HIERARCHY EMPHASIS:
- Nodes represent entities; edges represent relationships.
- Use consistent node sizes unless hierarchy is intended.
- For neural networks: label layer types and dimensions (e.g., "Dense 128", "Conv 3x3").
- For hierarchies: root at top, children below.`,

  conceptual: `CONCEPTUAL / FRAMEWORK EMPHASIS:
- Focus on clarity over strict technical notation.
- Group related ideas; use colour/shape to communicate categories.
- Light graphical flourishes (icons, gradients) are acceptable if they serve comprehension.`,
}

export function composeGenerationPrompt(
  userPrompt: string,
  diagramType: DiagramType
): string {
  const typeGuidance = diagramType !== 'auto' ? DIAGRAM_TYPE_GUIDANCE[diagramType] : ''
  return [
    BASE_GUIDELINES,
    typeGuidance,
    '',
    `USER REQUEST: ${userPrompt}`,
    '',
    'Generate a publication-quality scientific diagram that satisfies all guidelines above.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function composeEditPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[]
): string {
  const fixes = issues.map((i, idx) => `${idx + 1}. [${i.kind}] ${i.fix}`).join('\n')
  const typeGuidance = diagramType !== 'auto' ? DIAGRAM_TYPE_GUIDANCE[diagramType] : ''

  return [
    'Revise the attached diagram to fix the issues below while preserving everything that already works.',
    'Do NOT redraw from scratch — keep the overall layout, style, and correct elements intact.',
    '',
    'SPECIFIC FIXES (in priority order):',
    fixes,
    '',
    typeGuidance,
    '',
    `ORIGINAL INTENT: ${userPrompt}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function composeRegenPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[]
): string {
  const base = composeGenerationPrompt(userPrompt, diagramType)
  if (issues.length === 0) return base
  const critique = issues.map((i) => `- ${i.description} (fix: ${i.fix})`).join('\n')
  return `${base}\n\nPREVIOUS ATTEMPT HAD THESE PROBLEMS — DO NOT REPEAT THEM:\n${critique}`
}

/**
 * Extremely light-weight diagram-type classifier when `auto` is chosen.
 * Keyword-based; intentionally simple. Falls back to `conceptual`.
 */
export function detectDiagramType(prompt: string): Exclude<DiagramType, 'auto'> {
  const p = prompt.toLowerCase()
  const match = (keywords: string[]): boolean => keywords.some((k) => p.includes(k))

  if (match(['consort', 'prisma', 'flowchart', 'flow chart', 'flow diagram', 'swimlane', 'decision tree'])) return 'flowchart'
  if (match(['architecture', 'system diagram', 'microservice', 'pipeline', 'data flow', 'block diagram'])) return 'architecture'
  if (match(['pathway', 'signaling', 'signalling', 'cascade', 'mapk', 'egfr', 'phosphoryl', 'receptor', 'kinase'])) return 'pathway'
  if (match(['circuit', 'resistor', 'capacitor', 'op-amp', 'opamp', 'transistor', 'voltage', 'schematic circuit'])) return 'circuit'
  if (match(['neural network', 'transformer', 'cnn', 'rnn', 'lstm', 'attention', 'encoder-decoder', 'graph', 'tree', 'hierarchy'])) return 'network'

  return 'conceptual'
}
