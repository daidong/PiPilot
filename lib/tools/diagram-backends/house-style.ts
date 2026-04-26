/**
 * House-style profile — the diagram system's visual identity as a
 * first-class configuration object.
 *
 * The previous design kept style as three free-floating prose constants
 * ("DeepMind/OpenAI paper style", "Okabe-Ito preferred", etc.), which
 * (a) pushed output toward an external public aesthetic instead of a
 * recognisable in-house one, and (b) made style impossible to reason
 * about consistently across the generation and review halves of the
 * loop. A profile is a structured object that both halves can consume:
 * the prompt composer renders it into labelled slots, and the reviewer
 * can be asked to check adherence against the same tokens.
 *
 * House style is intentionally NOT a user-facing tool parameter — the
 * whole point is consistency across figures. Profiles are swapped at
 * the system level (e.g., by shipping an override in a future
 * admin-only setting), not by end users per call.
 */

export type PaletteRole =
  | 'text'
  | 'stroke'
  | 'primaryStructure'
  | 'secondaryStructure'
  | 'contextFill'
  | 'resultAccent'
  | 'warningAccent'
  | 'grid'

export interface PaletteToken {
  role: PaletteRole
  value: string
  description: string
}

export interface TypographyHierarchy {
  sectionLabel: string
  nodeLabel: string
  edgeAnnotation: string
  footLabel: string
}

export interface TypographyPolicy {
  hierarchy: TypographyHierarchy
  /** Ordered font stack. SVG uses the first installed font; raster renderers emulate the top entry visually. */
  fontStack: string[]
  /** One-line voice description the prompt renders directly. */
  voice: string
}

export interface GeometryTokens {
  /** Primary vs secondary line weights, as CSS-style values. */
  strokeWidth: { primary: string; secondary: string }
  cornerRadius: string
  arrowheadStyle: string
  groupContainerStyle: string
  /** Outer padding inside the viewBox so content doesn't touch edges. */
  outerMargin: string
  /** Minimum gap between sibling elements. */
  minGutter: string
  /** Allowed box heights (keeps the figure feeling composed on a shared rhythm). */
  boxHeightSteps: string[]
}

export interface HouseStyleProfile {
  id: string
  /** High-level identity paragraph. Replaces the old "DeepMind/OpenAI paper style" anchor. */
  themeNarrative: string
  typography: TypographyPolicy
  palette: PaletteToken[]
  geometry: GeometryTokens
  /** Recurring visual elements the reviewer should see consistently. */
  motifs: string[]
  /** Style-specific additions to the universal avoid list. */
  avoid: string[]
}

// ---------------------------------------------------------------------------
// Default profile — editorial institutional identity, not AI-aesthetic, not
// startup-whitepaper, not DeepMind/OpenAI mimicry. The palette and
// geometry are concrete choices; they can be swapped wholesale by shipping
// a different profile, but the same profile must be used across all
// diagrams in a run so they look like siblings.
// ---------------------------------------------------------------------------

export const DEFAULT_HOUSE_PROFILE: HouseStyleProfile = {
  id: 'editorial-institutional-v1',

  themeNarrative: [
    'Editorial scientific figure with a fixed institutional identity.',
    'Off-white or warm-light background, graphite text and strokes, restrained contrast, disciplined whitespace.',
    'No generic "AI" aesthetic (no glow, no particles, no gradient backgrounds).',
    'No startup-whitepaper look (no flat-design pastels, no rounded-pill overloads).',
    'Every figure in this system should look like it belongs to the same visual family across papers, slides, and reports.',
  ].join(' '),

  typography: {
    hierarchy: {
      sectionLabel: '700 13px uppercase tracked',
      nodeLabel: '600 12px',
      edgeAnnotation: '500 10px',
      footLabel: '400 10px italic',
    },
    fontStack: ['Inter', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'sans-serif'],
    voice: 'Compact, disciplined, editorial. Hierarchy is fixed. No oversized headings, no micro-labels under 10px.',
  },

  palette: [
    { role: 'text', value: '#1F2937', description: 'Graphite text and primary strokes.' },
    { role: 'stroke', value: '#1F2937', description: 'Same graphite for structural outlines.' },
    { role: 'primaryStructure', value: '#2C5282', description: 'Primary structural entities — main nodes, canonical path.' },
    { role: 'secondaryStructure', value: '#718096', description: 'Secondary structural entities — supporting nodes, context.' },
    { role: 'contextFill', value: '#F7FAFC', description: 'Off-white background fill for grouping containers.' },
    { role: 'resultAccent', value: '#2B6CB0', description: 'Deep editorial blue, used sparingly on result/output elements.' },
    { role: 'warningAccent', value: '#C53030', description: 'Deep editorial red, used only for warnings or peak-state emphasis.' },
    { role: 'grid', value: '#E2E8F0', description: 'Soft graphite grid or axis line.' },
  ],

  geometry: {
    strokeWidth: { primary: '1.5px', secondary: '1px' },
    cornerRadius: '8px',
    arrowheadStyle: 'Filled triangle, width 8px, extending 9px along the stroke — never hollow arrows, never emoji.',
    groupContainerStyle: 'Dashed 1px secondary-structure border with contextFill background; no solid coloured group panels.',
    outerMargin: '5% of the viewBox on every side',
    minGutter: '32px between adjacent boxes',
    boxHeightSteps: ['48px', '72px', '96px'],
  },

  motifs: [
    'Labels sit above or to the left of the element they describe; never inside node boxes unless the box is a labelled region.',
    'Arrow stroke matches its source node colour.',
    'Consistent gutter rhythm across panels in multi-panel figures.',
    'Section labels (panel headers, region titles) always use the same section-label typography token.',
    'No more than two accent colours visible in a single figure.',
  ],

  avoid: [
    'Gradients, glow, blur, or filter effects of any kind',
    'Rounded-pill buttons, soft-shadow cards, or other app-UI tropes',
    'Neon or highly saturated colours',
    'Oversized emoji, cartoon icons, or mascot-style illustrations',
    'Display fonts, script fonts, or hand-lettering styles',
  ],
}

// ---------------------------------------------------------------------------
// Prompt rendering. Emits the profile as deterministic labelled blocks
// suitable for embedding in the 制作单 brief. Each block addresses one
// axis the reviewer will also evaluate.
// ---------------------------------------------------------------------------

export interface RenderedProfile {
  theme: string
  typography: string
  palette: string
  geometry: string
  motifs: string
  avoid: string[]
  /** Short one-line summary used in review prompts so the reviewer knows what identity to check against. */
  summaryForReviewer: string
}

function renderPalette(tokens: PaletteToken[]): string {
  const lines = [
    'Semantic role → colour mapping (house palette). Use these tokens as defaults; a user prompt may override any specific role.',
  ]
  for (const t of tokens) {
    lines.push(`- ${t.role}: ${t.value} — ${t.description}`)
  }
  lines.push('All category distinctions must remain readable in grayscale AND under colour-vision deficiency; fall back to an accessible substitute only if a house palette choice fails that test.')
  return lines.join('\n')
}

function renderGeometry(g: GeometryTokens): string {
  return [
    'Geometry language (house tokens — reuse across every diagram in the system):',
    `- Stroke widths: primary ${g.strokeWidth.primary}, secondary ${g.strokeWidth.secondary}.`,
    `- Corner radius: ${g.cornerRadius} for all rounded rectangles.`,
    `- Arrowheads: ${g.arrowheadStyle}`,
    `- Group container: ${g.groupContainerStyle}`,
    `- Outer margin: ${g.outerMargin}. Min gutter between elements: ${g.minGutter}.`,
    `- Node box heights: choose one of ${g.boxHeightSteps.join(' / ')} and keep it consistent within a panel.`,
  ].join('\n')
}

function renderTypography(t: TypographyPolicy): string {
  return [
    `Typographic voice: ${t.voice}`,
    `Font stack (first installed wins): ${t.fontStack.join(', ')}.`,
    `Hierarchy tokens (use these exact sizes/weights):`,
    `- Section label:      ${t.hierarchy.sectionLabel}`,
    `- Node label:         ${t.hierarchy.nodeLabel}`,
    `- Edge annotation:    ${t.hierarchy.edgeAnnotation}`,
    `- Foot label:         ${t.hierarchy.footLabel}`,
  ].join('\n')
}

function renderMotifs(motifs: string[]): string {
  if (motifs.length === 0) return ''
  return [
    'Recurring motifs (these are the "signature" details reviewers should see every time):',
    ...motifs.map((m) => `- ${m}`),
  ].join('\n')
}

export function renderProfile(profile: HouseStyleProfile = DEFAULT_HOUSE_PROFILE): RenderedProfile {
  return {
    theme: profile.themeNarrative,
    typography: renderTypography(profile.typography),
    palette: renderPalette(profile.palette),
    geometry: renderGeometry(profile.geometry),
    motifs: renderMotifs(profile.motifs),
    avoid: profile.avoid,
    summaryForReviewer: [
      `House profile: ${profile.id}.`,
      `Theme: ${profile.themeNarrative}`,
      `Palette roles: ${profile.palette.map((p) => `${p.role}=${p.value}`).join(', ')}.`,
      `Geometry: stroke ${profile.geometry.strokeWidth.primary}/${profile.geometry.strokeWidth.secondary}, corner ${profile.geometry.cornerRadius}, gutter ${profile.geometry.minGutter}.`,
      `Typography: ${profile.typography.voice} Stack: ${profile.typography.fontStack[0]}.`,
    ].join(' '),
  }
}
