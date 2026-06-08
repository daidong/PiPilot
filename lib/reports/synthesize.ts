/**
 * Theme synthesis via a single LLM call (RFC-007 PR-B).
 *
 * This is the ONE place we burn LLM tokens in report generation. The
 * call asks the model to:
 *   1. Cluster the papers into 3-6 named themes
 *   2. Write a 2-3 sentence synthesis for each theme, citing every
 *      claim with `[citeKey]`
 *   3. Surface 3-5 lab-meeting talking points, each cited
 *
 * Why ONE prompt and not six:
 *   - The aha moment is "this app read my papers and saw themes" —
 *     that's exactly one model decision. The rest of the report is
 *     deterministic aggregation over wiki sidecars (see aggregate.ts).
 *   - Single-call is ~$0.05 instead of $0.40 for 100 papers, ~30s
 *     instead of 2-4min, fewer race conditions on partial failure.
 *   - The model has the full pack in context simultaneously when
 *     deciding theme boundaries, which is what we want — themes
 *     drawn from N independent calls would be inconsistent.
 *
 * Output is JSON-formatted to keep parsing trivial; cite-key
 * validation runs post-parse.
 */

import type {
  CallLlm,
  ReportInput,
  SynthesisOutput,
  ThemeBlock,
  TalkingPoint,
} from './types.js'
import { citeKeysOf } from './input-builder.js'
import { parseJsonObjectFromText } from '../utils/llm-json.js'

// ─── Prompts ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior research analyst writing a synthesis of a researcher's paper pack for use in lab meetings and student onboarding.

Your task: cluster the provided papers into 3-6 coherent themes, write a synthesis paragraph per theme, and surface 3-5 talking points worth raising at a lab meeting.

Hard requirements:
1. Every factual claim MUST cite at least one paper using \`[citeKey]\` syntax. Multiple citations: \`[smith2024, jones2023]\`.
2. Only use citeKeys that appear in the provided pack — never invent them.
3. Theme names: short noun phrases (2-5 words), not sentences.
4. Theme synthesis: 2-4 sentences each. Be specific — name the technique, dataset, or claim. Avoid filler like "many papers explore...".
5. Each paper should appear in exactly ONE theme.
6. Talking points: surprising / controversial / actionable findings across the pack. Each is one sentence with citation.
7. Output strictly valid JSON wrapped in a single \`\`\`json fenced block. No prose outside the block.

JSON schema:
{
  "themes": [
    {
      "name": "string",
      "papers": ["citeKey1", "citeKey2", ...],
      "synthesis": "string with [citeKey] inline citations"
    }
  ],
  "talking_points": [
    {
      "point": "string with [citeKey] inline citations",
      "cite_keys": ["citeKey1", ...]
    }
  ]
}`

// ─── Input formatter ─────────────────────────────────────────────────────

/**
 * Format the report input for the prompt. We pass per-paper:
 *   citeKey, title, year, tldr, task[], methods (top-3), concepts (top-3)
 * Skipping limitations / negative_results / findings — those would
 * inflate the token budget and the model doesn't need them for
 * theme clustering (it just needs to know what each paper is *about*).
 *
 * Papers without wiki data are listed with just title+abstract-first-
 * sentence so they can still be clustered, with a `[source: thin]`
 * marker so the model knows the input is shallow.
 */
function formatInputForPrompt(input: ReportInput): string {
  const lines: string[] = []
  lines.push(`Paper pack — ${input.papers.length} papers in project "${input.projectName}".`)
  lines.push('')
  lines.push('Each paper below: citeKey, title, year, then (if available) tldr, task tags, methods, concept tags.')
  lines.push('')

  for (const entry of input.papers) {
    const { paper, wiki } = entry
    const citeKey = paper.citeKey
    if (!citeKey) continue

    const yearStr = paper.year != null ? ` (${paper.year})` : ''
    lines.push(`## ${citeKey}: ${paper.title}${yearStr}`)
    if (!wiki) {
      // Thin source — only paper-artifact-level data.
      const first = (paper.abstract ?? '').trim().split(/(?<=[.!?])\s+/)[0]
      if (first) lines.push(`  abstract-snippet: ${truncate(first, 200)}`)
      lines.push(`  [source: thin — no wiki extraction yet]`)
      lines.push('')
      continue
    }

    if (wiki.tldr) lines.push(`  tldr: ${truncate(wiki.tldr, 240)}`)
    if (wiki.task && wiki.task.length > 0) {
      lines.push(`  task: ${wiki.task.slice(0, 4).join(', ')}`)
    }
    if (wiki.methods && wiki.methods.length > 0) {
      lines.push(`  methods: ${wiki.methods.slice(0, 3).join(', ')}`)
    }
    if (wiki.concept_edges && wiki.concept_edges.length > 0) {
      const concepts = wiki.concept_edges.slice(0, 3).map((e) => e.slug).join(', ')
      lines.push(`  concepts: ${concepts}`)
    }
    if (wiki.source_tier === 'abstract-only') {
      lines.push(`  [source: abstract-only — findings are from abstract, not full text]`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('Now produce the JSON synthesis. Remember: every factual claim must carry at least one [citeKey] citation, and citeKeys must match exactly.')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// ─── Output parser + validator ───────────────────────────────────────────

// `type` (not `interface`) so it satisfies the `T extends Record<string, unknown>`
// constraint on parseJsonObjectFromText — interfaces lack an implicit index
// signature (they can be augmented), object-literal type aliases do not.
type RawSynthesis = {
  themes?: Array<{ name?: string; papers?: string[]; synthesis?: string }>
  talking_points?: Array<{ point?: string; cite_keys?: string[] }>
}

/**
 * Pull the JSON out of the model's response. Tolerant of:
 *   - JSON wrapped in ```json fenced block
 *   - JSON wrapped in plain ``` block
 *   - Raw JSON (no fence)
 *   - Trailing prose after the block (`} \n\nNotes: ...`)
 *
 * Returns null when nothing parseable was found. Caller then falls
 * back to an empty synthesis (see synthesizeThemes).
 */
export function extractJsonFromResponse(raw: string): RawSynthesis | null {
  return parseJsonObjectFromText<RawSynthesis>(raw)
}

/**
 * Strip cite-keys that aren't in the pack, then verify each theme
 * and talking point still has at least one valid citation. Themes /
 * points with zero valid citations are dropped — better to under-
 * deliver than show users hallucinated references.
 */
export function validateAndCleanSynthesis(
  raw: RawSynthesis,
  validCiteKeys: Set<string>
): { themes: ThemeBlock[]; talkingPoints: TalkingPoint[] } {
  const themes: ThemeBlock[] = []
  for (const t of raw.themes ?? []) {
    const name = (t.name ?? '').trim()
    const synthesis = (t.synthesis ?? '').trim()
    if (!name || !synthesis) continue

    // Strip cite-keys from `papers` array that aren't in the pack.
    const papers = (t.papers ?? []).filter((k) => validCiteKeys.has(k))

    // Strip inline [citeKey] references that aren't in the pack.
    const cleanedSynthesis = stripUnknownCiteKeys(synthesis, validCiteKeys)
    if (!hasAtLeastOneCiteKey(cleanedSynthesis)) continue  // no valid citations → drop

    themes.push({ name, papers, synthesis: cleanedSynthesis })
  }

  const talkingPoints: TalkingPoint[] = []
  for (const p of raw.talking_points ?? []) {
    const point = (p.point ?? '').trim()
    if (!point) continue
    const citeKeys = (p.cite_keys ?? []).filter((k) => validCiteKeys.has(k))
    const cleanedPoint = stripUnknownCiteKeys(point, validCiteKeys)
    if (!hasAtLeastOneCiteKey(cleanedPoint)) continue
    talkingPoints.push({ point: cleanedPoint, citeKeys })
  }

  return { themes, talkingPoints }
}

// ─── Citation utilities ──────────────────────────────────────────────────

/** Matches `[citeKey]` or `[citeKey1, citeKey2]`. */
const CITE_RE = /\[([a-zA-Z][a-zA-Z0-9_:\-]*(?:\s*,\s*[a-zA-Z][a-zA-Z0-9_:\-]*)*)\]/g

function stripUnknownCiteKeys(text: string, validKeys: Set<string>): string {
  return text.replace(CITE_RE, (match, inside: string) => {
    const keys = inside.split(',').map((s) => s.trim()).filter((k) => validKeys.has(k))
    if (keys.length === 0) return ''   // drop entirely
    return `[${keys.join(', ')}]`
  }).replace(/\s+/g, ' ').replace(/\s+\./g, '.').replace(/\s+,/g, ',').trim()
}

function hasAtLeastOneCiteKey(text: string): boolean {
  return CITE_RE.test(text)
}

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Run the synthesis. Single LLM call, JSON output, cite-key validation.
 *
 * Returns `{ themes: [], talkingPoints: [] }` (empty arrays, not null)
 * if the call or parse fails — the rest of the report still renders
 * with deterministic content. The aha moment is degraded but not absent
 * when the LLM misbehaves.
 */
export async function synthesizeThemes(
  input: ReportInput,
  callLlm: CallLlm
): Promise<SynthesisOutput> {
  const userContent = formatInputForPrompt(input)
  const raw = await callLlm(SYSTEM_PROMPT, userContent)

  const parsed = extractJsonFromResponse(raw)
  if (!parsed) {
    return { themes: [], talkingPoints: [], rawResponse: raw }
  }

  const valid = citeKeysOf(input)
  const { themes, talkingPoints } = validateAndCleanSynthesis(parsed, valid)
  return { themes, talkingPoints, rawResponse: raw }
}
