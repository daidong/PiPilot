/**
 * Prompt composition for diagram generation.
 *
 * gpt-image-2 is much more responsive to **structured** specifications
 * than to long prose. We therefore frame every request as a production
 * brief ("制作单") with labeled sections in a fixed order — scene/use,
 * subject, composition, key details, text, must-keep, avoid. The model
 * parses each section independently and applies them in order, which
 * avoids the "flowery adjectives wash each other out" failure mode.
 *
 * Three composers share the same skeleton:
 *   - composeGenerationPrompt: first-iteration, no prior image
 *   - composeEditPrompt:       subsequent iteration after needs_edit
 *                              (surgical changes, preserve the rest)
 *   - composeRegenPrompt:      subsequent iteration after needs_regen
 *                              (redraw but do not repeat listed faults)
 */

import type { BlockingIssue, DiagramType } from './types.js'

// ─── Shared sections ────────────────────────────────────────────────────────

const QUALITY_AND_STYLE = `Clean white/light background, no textures or gradients. Flat vector illustration in the academic figure style used by DeepMind or OpenAI papers. High contrast for print and digital reading. No photorealism, no 3D shading artifacts, no sketchy lines, no cartoon mascots.`

const TYPOGRAPHY = `Sans-serif (Arial, Helvetica, or similar), minimum 10pt at intended size. All text horizontal. No overlapping text. Consistent sizing inside each group.`

const COLOUR_AND_ACCESSIBILITY = `Okabe-Ito palette preferred. Encode categories with BOTH shape and colour, never colour alone. Readable in grayscale.`

const VERBATIM_TEXT_RULE = `Render every quoted string EXACTLY as given — verbatim, character for character. Do not paraphrase, auto-correct, translate, or substitute. This includes counts like "n=350", identifiers like "EGFR", units like "1kΩ", and any symbols. If the request contains unfamiliar words or abbreviations, keep them as written.`

const UNIVERSAL_AVOID = [
  'Figure numbers or titles ("Figure 1:", "Fig 1.", etc.) anywhere in the image',
  'Captions or header bars that repeat information the slide/paper will add around the figure',
  'Photorealistic photographs, hand-drawn sketches, 3D shading, bevel/emboss/drop-shadow effects',
  'Watermarks, logos, signatures, or stylistic "AI" ornaments',
]

// ─── Diagram-type specific key details ───────────────────────────────────────

const DIAGRAM_TYPE_DETAILS: Record<Exclude<DiagramType, 'auto'>, string> = {
  flowchart: `Standard shapes: rectangle = process, diamond = decision, rounded rectangle = start/end. Arrows must point unambiguously from source to target. Every numeric count (n=…) and every branch label (yes/no, conditions) is MANDATORY when mentioned in the subject. Prefer vertical top-to-bottom flow unless specified.`,

  architecture: `Layered or blocked composition; each component is a labelled box. Show data flow direction with arrows; annotate protocols or interfaces on edges. Group related components (shared background tint or dashed boundary). Consistent box sizes within a layer.`,

  pathway: `Every molecule/gene/protein labelled with its exact symbol. Arrows distinguish activation (→) from inhibition (⊣ or ⊥). Preserve the exact order and directionality specified. Oval = molecule, rectangle = complex, rounded = process. Include cellular compartments (membrane, nucleus) when relevant.`,

  circuit: `Standard electronic symbols (IEEE/IEC): resistor zigzag, capacitor parallel lines, ground triangle, op-amp triangle with + and − inputs labelled. Component values carry units ("1kΩ", "10µF", "5V"). Wires: dot at crossing = connection, no dot = jump-over. Ground and supply rails explicitly marked.`,

  network: `Nodes are labelled entities; edges are relationships. Consistent node sizes unless hierarchy is intentional. For neural networks, label layer types and dimensions ("Dense 128", "Conv 3×3"). For hierarchies, root at top.`,

  conceptual: `Focus on clarity over strict notation. Group related ideas; use colour or shape to communicate categories. Light graphical flourishes (icons, gradients) are acceptable if they serve comprehension, not decoration.`,
}

// ─── Composition hints by diagram type ───────────────────────────────────────

const COMPOSITION_HINTS: Record<Exclude<DiagramType, 'auto'>, string> = {
  flowchart:    'Top-to-bottom vertical flow unless the subject specifies otherwise. Generous gutters between stages.',
  architecture: 'Left-to-right or layered horizontal composition. Align boxes to a common grid.',
  pathway:      'Directional cascade — usually top-to-bottom for signalling, left-to-right for metabolic. Group molecules by compartment.',
  circuit:      'Standard schematic layout: input on the left, output on the right, ground at the bottom.',
  network:      'For neural nets, encoder-left/decoder-right or input-at-top. For trees, root-up.',
  conceptual:   'Whatever composition makes the relationship obvious (radial, flow, Venn, concentric).',
}

// ─── Literal extraction ─────────────────────────────────────────────────────

/**
 * Pull literals out of the user's prompt that must survive verbatim:
 *   - any double- or single-quoted substring
 *   - n=NUMBER counts (CONSORT / PRISMA style)
 *   - numeric+unit tokens like "1kΩ", "10µF", "5V", "128 nodes"
 *
 * These are surfaced in MUST KEEP so the model has a checklist against
 * its own output. Extraction is best-effort; the verbatim text rule in
 * every prompt covers anything the regex misses.
 */
export function extractLiterals(prompt: string): string[] {
  const found = new Set<string>()

  // Quoted strings (double or single)
  for (const m of prompt.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const value = (m[1] ?? m[2] ?? '').trim()
    if (value) found.add(`"${value}"`)
  }

  // n=DIGITS counts
  for (const m of prompt.matchAll(/\bn\s*=\s*([\d,]+)/gi)) {
    found.add(`n=${m[1].replace(/,/g, '')}`)
  }

  // Number + unit (common units in science diagrams). Kept deliberately narrow
  // to avoid matching every bare number.
  for (const m of prompt.matchAll(/\b\d+(?:\.\d+)?\s*(?:kΩ|Ω|µF|uF|mF|nF|pF|kHz|MHz|GHz|Hz|mV|V|mA|A|pt|px|nm|µm|mm|cm|m|ns|µs|ms|s|nodes|layers)\b/gi)) {
    found.add(m[0].trim())
  }

  return Array.from(found)
}

// ─── Builders ───────────────────────────────────────────────────────────────

function resolveDiagramType(type: DiagramType): Exclude<DiagramType, 'auto'> {
  return type === 'auto' ? 'conceptual' : type
}

function buildBrief(options: {
  sceneUse: string
  subject: string
  composition: string
  keyDetails: string
  textRules: string
  mustKeep: string[]
  avoid: string[]
}): string {
  const lines: string[] = []
  lines.push(`【SCENE / USE】 ${options.sceneUse}`)
  lines.push(`【SUBJECT】 ${options.subject}`)
  lines.push(`【COMPOSITION】 ${options.composition}`)
  lines.push(`【KEY DETAILS】`)
  lines.push(options.keyDetails)
  lines.push(`【TEXT】 ${options.textRules}`)
  if (options.mustKeep.length > 0) {
    lines.push(`【MUST KEEP】`)
    for (const item of options.mustKeep) lines.push(`- ${item}`)
  }
  lines.push(`【AVOID】`)
  for (const item of options.avoid) lines.push(`- ${item}`)
  return lines.join('\n')
}

export function composeGenerationPrompt(
  userPrompt: string,
  diagramType: DiagramType
): string {
  const dt = resolveDiagramType(diagramType)
  const literals = extractLiterals(userPrompt)

  return buildBrief({
    sceneUse: `A publication-grade scientific ${dt} diagram.`,
    subject: userPrompt,
    composition: `${COMPOSITION_HINTS[dt]} ${QUALITY_AND_STYLE}`,
    keyDetails: [
      DIAGRAM_TYPE_DETAILS[dt],
      `Typography: ${TYPOGRAPHY}`,
      `Colour: ${COLOUR_AND_ACCESSIBILITY}`,
    ].join('\n'),
    textRules: VERBATIM_TEXT_RULE,
    mustKeep: literals,
    avoid: UNIVERSAL_AVOID,
  })
}

export function composeEditPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[],
  preservedFixes: BlockingIssue[] = []
): string {
  const dt = resolveDiagramType(diagramType)
  const literals = extractLiterals(userPrompt)
  const fixes = issues.length > 0
    ? issues.map((i, idx) => `${idx + 1}. [${i.kind}] ${i.fix}`).join('\n')
    : 'Tighten the details that needed tightening; keep the rest unchanged.'

  // When earlier iterations already resolved other problems, surface
  // those resolutions so the model keeps them intact. Without this the
  // edit pass can fix the current complaint while inadvertently
  // undoing earlier corrections (the regression we observed in
  // multi-iteration runs).
  const keyDetailLines: string[] = [
    `TARGETED FIXES (in priority order):`,
    fixes,
    `Apply ONLY these fixes. Every other element — including existing labels, arrows, boxes, and whitespace — must be preserved exactly as in the attached image.`,
  ]
  if (preservedFixes.length > 0) {
    const preservedLines = preservedFixes
      .map((p, idx) => `${idx + 1}. [${p.kind}] ${p.description} — already resolved; keep it that way`)
      .join('\n')
    keyDetailLines.push(
      `ALREADY-RESOLVED ITEMS (DO NOT regress these — they were broken in a previous draft and fixed):`,
      preservedLines,
    )
  }
  keyDetailLines.push(`Type-specific rules still apply: ${DIAGRAM_TYPE_DETAILS[dt]}`)

  return [
    buildBrief({
      sceneUse: `Surgical revision of an existing ${dt} diagram.`,
      subject: userPrompt,
      composition: `Keep the existing layout, sizing, colour palette, and element positions UNCHANGED unless a specific fix below requires otherwise. Do not redraw from scratch.`,
      keyDetails: keyDetailLines.join('\n'),
      textRules: VERBATIM_TEXT_RULE,
      mustKeep: literals,
      avoid: [
        ...UNIVERSAL_AVOID,
        'Any change to the overall composition, aspect ratio, or background',
        'Any change to elements that were already correct',
        'Regressing any item listed in ALREADY-RESOLVED ITEMS',
      ],
    }),
  ].join('\n\n')
}

export function composeRegenPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[]
): string {
  const base = composeGenerationPrompt(userPrompt, diagramType)
  if (issues.length === 0) return base
  const negatives = issues
    .map((i) => `- ${i.description} (fix: ${i.fix})`)
    .join('\n')
  return `${base}\n\n【PREVIOUS ATTEMPT HAD THESE PROBLEMS — DO NOT REPEAT】\n${negatives}`
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

/**
 * Exported only for tests and for the SVG fallback path — keeps the base
 * guidelines reachable from a non-image channel without re-deriving them.
 */
export const BASE_GUIDELINES = [
  QUALITY_AND_STYLE,
  `Typography: ${TYPOGRAPHY}`,
  `Colour: ${COLOUR_AND_ACCESSIBILITY}`,
  `Text: ${VERBATIM_TEXT_RULE}`,
  `Avoid: ${UNIVERSAL_AVOID.join('; ')}.`,
].join('\n\n')
