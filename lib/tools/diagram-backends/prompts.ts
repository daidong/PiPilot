/**
 * Prompt composition for diagram generation.
 *
 * gpt-image-2 is markedly more responsive to structured specifications
 * than to flowing prose. We therefore frame every request as a production
 * brief ("制作单") with labelled sections in a fixed order. The sections
 * intentionally mirror the HouseStyleProfile axes so the reviewer can be
 * asked to check the same axes the generator was told to honour:
 *
 *   SCENE → SUBJECT → COMPOSITION → KEY DETAILS (geometry + typography +
 *   palette + type-specific rules) → MOTIFS → TEXT → MUST KEEP → AVOID
 *
 * Three composers share the skeleton:
 *   - composeGenerationPrompt: first-iteration, no prior image
 *   - composeEditPrompt:       subsequent iteration after needs_edit
 *                              (surgical changes, preserve the rest)
 *   - composeRegenPrompt:      subsequent iteration after needs_regen
 *                              (redraw but do not repeat listed faults)
 */

import type { BlockingIssue, DiagramType } from './types.js'
import { DEFAULT_HOUSE_PROFILE, renderProfile, type HouseStyleProfile } from './house-style.js'

// ─── Diagram-type specific key details ───────────────────────────────────────

const DIAGRAM_TYPE_DETAILS: Record<Exclude<DiagramType, 'auto'>, string> = {
  flowchart: `Standard shapes: rectangle = process, diamond = decision, rounded rectangle = start/end. Arrows must point unambiguously from source to target. Every numeric count (n=…) and every branch label (yes/no, conditions) is MANDATORY when mentioned in the subject. Prefer vertical top-to-bottom flow unless specified.`,

  architecture: `Layered or blocked composition; each component is a labelled box. Show data flow direction with arrows; annotate protocols or interfaces on edges. Group related components (shared background tint or dashed boundary). Consistent box sizes within a layer.`,

  pathway: `Every molecule/gene/protein labelled with its exact symbol. Arrows distinguish activation (→) from inhibition (⊣ or ⊥). Preserve the exact order and directionality specified. Oval = molecule, rectangle = complex, rounded = process. Include cellular compartments (membrane, nucleus) when relevant.`,

  circuit: `Standard electronic symbols (IEEE/IEC): resistor zigzag, capacitor parallel lines, ground triangle, op-amp triangle with + and − inputs labelled. Component values carry units ("1kΩ", "10µF", "5V"). Wires: dot at crossing = connection, no dot = jump-over. Ground and supply rails explicitly marked.`,

  network: `Nodes are labelled entities; edges are relationships. Consistent node sizes unless hierarchy is intentional. For neural networks, label layer types and dimensions ("Dense 128", "Conv 3×3"). For hierarchies, root at top.`,

  // Previously this said "light graphical flourishes (icons, gradients)
  // are acceptable if they serve comprehension". That conflicted with
  // the global no-gradients rule. Conceptual diagrams now follow the
  // same geometry/colour discipline as the rest — identity is more
  // valuable than flourish.
  conceptual: `Focus on clarity. Group related ideas; use the house palette roles to communicate categories. Geometric shapes only — no decorative icons, no photographic inserts, no illustrations.`,
}

const COMPOSITION_HINTS: Record<Exclude<DiagramType, 'auto'>, string> = {
  flowchart:    'Top-to-bottom vertical flow unless the subject specifies otherwise. Generous gutters between stages.',
  architecture: 'Left-to-right or layered horizontal composition. Align boxes to a common grid.',
  pathway:      'Directional cascade — usually top-to-bottom for signalling, left-to-right for metabolic. Group molecules by compartment.',
  circuit:      'Standard schematic layout: input on the left, output on the right, ground at the bottom.',
  network:      'For neural nets, encoder-left/decoder-right or input-at-top. For trees, root-up.',
  conceptual:   'Choose a composition (flow / radial / Venn / concentric) that makes the relationship obvious, then keep it regular.',
}

// ─── Static universal text ───────────────────────────────────────────────────

const VERBATIM_TEXT_RULE = `Render every quoted string EXACTLY as given — verbatim, character for character. Do not paraphrase, auto-correct, translate, or substitute. This includes counts like "n=350", identifiers like "EGFR", units like "1kΩ", colour hex codes like "#2B6CB0", and any symbols. If the request contains unfamiliar words or abbreviations, keep them as written.`

const UNIVERSAL_AVOID = [
  'Figure numbers or titles ("Figure 1:", "Fig 1.", etc.) anywhere in the image',
  'Captions or header bars that repeat information the slide/paper will add around the figure',
  'Photorealistic photographs, hand-drawn sketches, 3D shading, bevel/emboss/drop-shadow effects',
  'Watermarks, logos, signatures, or stylistic "AI" ornaments',
]

// ─── Literal extraction ─────────────────────────────────────────────────────

/**
 * Pull literals out of the user's prompt that must survive verbatim:
 *   - double- or single-quoted substrings (labels, button text, etc.)
 *   - `n=NUMBER` counts (CONSORT / PRISMA style)
 *   - numeric+unit tokens (1kΩ, 10µF, 128 nodes, …)
 *   - unquoted colour literals: `#RRGGBB`, rgb(), rgba(), hsl(), hsla()
 *
 * Catches brand-colour directives expressed in plain prose
 * ("use #E30613 for the output node") alongside the usual quoted
 * identifiers. Surfaced in the MUST KEEP slot so the model has a
 * machine-readable checklist against its own output.
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

  // Number + unit (common units in science diagrams).
  for (const m of prompt.matchAll(/\b\d+(?:\.\d+)?\s*(?:kΩ|Ω|µF|uF|mF|nF|pF|kHz|MHz|GHz|Hz|mV|V|mA|A|pt|px|nm|µm|mm|cm|m|ns|µs|ms|s|nodes|layers)\b/gi)) {
    found.add(m[0].trim())
  }

  // Unquoted colour literals. Hex: #RGB, #RRGGBB, #RRGGBBAA.
  for (const m of prompt.matchAll(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g)) {
    found.add(m[0])
  }
  // Functional colour syntaxes.
  for (const m of prompt.matchAll(/\b(?:rgba?|hsla?)\([^)]+\)/gi)) {
    found.add(m[0])
  }

  return Array.from(found)
}

// ─── Builders ───────────────────────────────────────────────────────────────

function resolveDiagramType(type: DiagramType): Exclude<DiagramType, 'auto'> {
  return type === 'auto' ? 'conceptual' : type
}

interface BriefSections {
  sceneUse: string
  subject: string
  composition: string
  keyDetails: string
  motifs: string
  textRules: string
  mustKeep: string[]
  avoid: string[]
}

function buildBrief(s: BriefSections): string {
  const lines: string[] = []
  lines.push(`【SCENE / USE】 ${s.sceneUse}`)
  lines.push(`【SUBJECT】 ${s.subject}`)
  lines.push(`【COMPOSITION】 ${s.composition}`)
  lines.push(`【KEY DETAILS】`)
  lines.push(s.keyDetails)
  if (s.motifs) {
    lines.push(`【MOTIFS】`)
    lines.push(s.motifs)
  }
  lines.push(`【TEXT】 ${s.textRules}`)
  if (s.mustKeep.length > 0) {
    lines.push(`【MUST KEEP】`)
    for (const item of s.mustKeep) lines.push(`- ${item}`)
  }
  lines.push(`【AVOID】`)
  for (const item of s.avoid) lines.push(`- ${item}`)
  return lines.join('\n')
}

function buildKeyDetails(
  diagramTypeRules: string,
  rendered: ReturnType<typeof renderProfile>
): string {
  return [
    diagramTypeRules,
    '',
    'Typography',
    rendered.typography,
    '',
    'Colour palette',
    rendered.palette,
    '',
    'Geometry',
    rendered.geometry,
  ].join('\n')
}

function buildAvoid(profile: HouseStyleProfile): string[] {
  // Universal + profile-specific — the profile's avoid list is additive,
  // not a replacement. UNIVERSAL_AVOID items are about document conventions
  // (no figure numbers etc.); profile items are about visual identity.
  return [...UNIVERSAL_AVOID, ...profile.avoid]
}

export function composeGenerationPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  profile: HouseStyleProfile = DEFAULT_HOUSE_PROFILE
): string {
  const dt = resolveDiagramType(diagramType)
  const rendered = renderProfile(profile)
  const literals = extractLiterals(userPrompt)

  return buildBrief({
    sceneUse: `A publication-grade scientific ${dt} diagram in the house visual system. ${rendered.theme}`,
    subject: userPrompt,
    composition: COMPOSITION_HINTS[dt],
    keyDetails: buildKeyDetails(DIAGRAM_TYPE_DETAILS[dt], rendered),
    motifs: rendered.motifs,
    textRules: VERBATIM_TEXT_RULE,
    mustKeep: literals,
    avoid: buildAvoid(profile),
  })
}

export function composeEditPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[],
  preservedFixes: BlockingIssue[] = [],
  profile: HouseStyleProfile = DEFAULT_HOUSE_PROFILE
): string {
  const dt = resolveDiagramType(diagramType)
  const rendered = renderProfile(profile)
  const literals = extractLiterals(userPrompt)
  const fixes = issues.length > 0
    ? issues.map((i, idx) => `${idx + 1}. [${i.kind}] ${i.fix}`).join('\n')
    : 'Tighten the details that needed tightening; keep the rest unchanged.'

  const keyDetailLines: string[] = [
    `TARGETED FIXES (in priority order):`,
    fixes,
    `Apply ONLY these fixes. Every other element — including existing labels, arrows, boxes, whitespace, colours, and typography — must be preserved exactly as in the attached image.`,
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
  keyDetailLines.push(
    `Type-specific rules still apply: ${DIAGRAM_TYPE_DETAILS[dt]}`,
    '',
    `House-style tokens (unchanged from the original brief — do not drift from these):`,
    rendered.typography,
    '',
    rendered.palette,
    '',
    rendered.geometry,
  )

  return buildBrief({
    sceneUse: `Surgical revision of an existing ${dt} diagram in the house visual system.`,
    subject: userPrompt,
    composition: `Keep the existing layout, sizing, colour palette, and element positions UNCHANGED unless a specific fix below requires otherwise. Do not redraw from scratch.`,
    keyDetails: keyDetailLines.join('\n'),
    motifs: rendered.motifs,
    textRules: VERBATIM_TEXT_RULE,
    mustKeep: literals,
    avoid: [
      ...buildAvoid(profile),
      'Any change to the overall composition, aspect ratio, or background',
      'Any change to elements that were already correct',
      'Regressing any item listed in ALREADY-RESOLVED ITEMS',
      'Drifting away from the house-style tokens (typography, palette, geometry) listed above',
    ],
  })
}

export function composeRegenPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  issues: BlockingIssue[],
  profile: HouseStyleProfile = DEFAULT_HOUSE_PROFILE
): string {
  const base = composeGenerationPrompt(userPrompt, diagramType, profile)
  if (issues.length === 0) return base
  const negatives = issues
    .map((i) => `- ${i.description} (fix: ${i.fix})`)
    .join('\n')
  return `${base}\n\n【PREVIOUS ATTEMPT HAD THESE PROBLEMS — DO NOT REPEAT】\n${negatives}`
}

/**
 * Style-only brief for reference images: generate a fresh diagram for the
 * subject, treating the reference as style board only (colours, typography,
 * line weights, geometric language). Layout and content must not be
 * copied.
 */
export function composeStyleOnlyPrompt(
  userPrompt: string,
  diagramType: DiagramType,
  profile: HouseStyleProfile = DEFAULT_HOUSE_PROFILE
): string {
  const base = composeGenerationPrompt(userPrompt, diagramType, profile)
  return [
    'The attached image is provided as a STYLE REFERENCE ONLY.',
    'Match its visual idiom — colour palette, line weights, typography, corner radii, arrow style, spacing rhythm.',
    'Do NOT copy its layout, content, panel structure, or composition.',
    'Design a new diagram from scratch for the request below, expressed in that style.',
    '',
    base,
  ].join('\n')
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
