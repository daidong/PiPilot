/**
 * Diagram generation tool.
 *
 * Orchestrates the generate → review → iterate loop. Providers are pluggable
 * (see diagram-backends/). The tool is the stable contract the agent uses;
 * model IDs and credentials live in settings/env and never leak into the
 * schema.
 *
 * Iteration strategy is verdict-driven:
 *   - acceptable   → stop
 *   - needs_edit   → image-to-image edit on the previous image (when backend
 *                    supports it) so we preserve what's already correct
 *   - needs_regen  → redo text-to-image with issues appended as negatives
 */

import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'
import {
  composeEditPrompt,
  composeGenerationPrompt,
  composeRegenPrompt,
  detectDiagramType,
} from './diagram-backends/prompts.js'
import { resolveProviders, type DiagramProviderPrefs } from './diagram-backends/registry.js'
import type {
  DiagramType,
  DocType,
  ReferenceMode,
  ReviewResult,
} from './diagram-backends/types.js'

const VALID_DOC_TYPES: DocType[] = [
  'journal', 'conference', 'thesis', 'grant',
  'preprint', 'report', 'poster', 'presentation', 'default',
]

const VALID_DIAGRAM_TYPES: DiagramType[] = [
  'flowchart', 'architecture', 'pathway', 'circuit',
  'network', 'conceptual', 'auto',
]

// All modes the schema advertises. Only `revise_layout` is plumbed end-to-end
// today; the other two are planned but the tool intentionally rejects them
// rather than accept them silently (see execute body below).
const VALID_REFERENCE_MODES: ReferenceMode[] = [
  'revise_layout', 'style_only', 'local_edit',
]
const SUPPORTED_REFERENCE_MODES: ReferenceMode[] = ['revise_layout']

const GenerateDiagramSchema = Type.Object({
  prompt: Type.String({
    description: 'Natural-language description of the diagram to generate. Be specific about components, labels, layout, and quantities.',
  }),
  output: Type.String({
    description: 'Workspace-relative output path (e.g. "figures/consort.png"). Parent directories are created if missing.',
  }),
  doc_type: Type.Optional(Type.String({
    description: `Target publication venue. One of: ${VALID_DOC_TYPES.join(' | ')}. Controls quality threshold.`,
  })),
  diagram_type: Type.Optional(Type.String({
    description: `Diagram category. One of: ${VALID_DIAGRAM_TYPES.join(' | ')}. Defaults to auto (keyword-detected).`,
  })),
  iterations: Type.Optional(Type.Number({
    description: 'Maximum refinement iterations (1-3). Each costs one generation + one review. Default: 2.',
  })),
  reference_path: Type.Optional(Type.String({
    description: 'Optional workspace-relative path to a reference image the first iteration edits instead of drawing from scratch. Requires reference_mode: revise_layout (other modes are not yet implemented).',
  })),
  reference_mode: Type.Optional(Type.String({
    description: `How to use the reference image. Only "revise_layout" is implemented in this version; "style_only" and "local_edit" are reserved and currently rejected. Default: revise_layout.`,
  })),
})

interface IterationRecord {
  iteration: number
  imagePath: string
  usedEdit: boolean
  review: ReviewResult
  /** The verdict the reviewer originally emitted, before tool-side reconciliation. */
  rawVerdict: ReviewResult['verdict']
  /** Populated when the reviewer's verdict was overridden due to contradictory fields. */
  verdictOverrideReason?: string
  promptSnippet: string
}

interface DiagramToolPayload {
  outputPath: string
  absoluteOutputPath: string
  iterations: IterationRecord[]
  finalScore: number
  finalVerdict: ReviewResult['verdict']
  threshold: number
  provider: { image: string; review: string }
  reviewLogPath: string
  stoppedEarly: boolean
}

function sanitizeDocType(value: unknown): DocType {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (VALID_DOC_TYPES as string[]).includes(v) ? (v as DocType) : 'default'
}

function sanitizeDiagramType(value: unknown, prompt: string): DiagramType {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  if ((VALID_DIAGRAM_TYPES as string[]).includes(v)) {
    return v === 'auto' ? detectDiagramType(prompt) : (v as DiagramType)
  }
  return detectDiagramType(prompt)
}

function sanitizeIterations(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(3, Math.round(n)))
}

type ReferenceModeResult =
  | { ok: true; mode: ReferenceMode }
  | { ok: false; reason: string; value: string }

function sanitizeReferenceMode(value: unknown): ReferenceModeResult {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return { ok: true, mode: 'revise_layout' }
  }
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!(VALID_REFERENCE_MODES as string[]).includes(v)) {
    return {
      ok: false,
      value: typeof value === 'string' ? value : String(value),
      reason: `Unknown reference_mode. Must be one of: ${VALID_REFERENCE_MODES.join(' | ')}.`,
    }
  }
  if (!(SUPPORTED_REFERENCE_MODES as string[]).includes(v)) {
    return {
      ok: false,
      value: v,
      reason: `reference_mode "${v}" is reserved but not yet implemented. Only ${SUPPORTED_REFERENCE_MODES.join(', ')} is available in this version.`,
    }
  }
  return { ok: true, mode: v as ReferenceMode }
}

/**
 * Refuse to early-stop when the reviewer's fields contradict the verdict.
 * A reviewer that returns `acceptable` together with blocking_issues or
 * a score below the threshold is either confused or adversarial; in
 * either case we should not silently trust the `verdict` field.
 */
function reconcileVerdict(
  review: ReviewResult,
  threshold: number
): { final: ReviewResult; override?: string } {
  if (review.verdict !== 'acceptable') {
    return { final: review }
  }
  if (review.score < threshold) {
    return {
      final: { ...review, verdict: 'needs_edit' },
      override: `reviewer said acceptable but score ${review.score} < threshold ${threshold}`,
    }
  }
  if (review.blockingIssues.length > 0) {
    // Kind-sensitive: if a blocking issue is structural, needs_regen; else needs_edit.
    const hasStructural = review.blockingIssues.some(
      (i) => i.kind === 'wrong_content' || i.kind === 'missing_element'
    )
    return {
      final: { ...review, verdict: hasStructural ? 'needs_regen' : 'needs_edit' },
      override: `reviewer said acceptable but listed ${review.blockingIssues.length} blocking issues`,
    }
  }
  return { final: review }
}

function ensureInsideWorkspace(workspace: string, target: string): string {
  const abs = path.resolve(workspace, target)
  const rel = path.relative(workspace, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Output path must live inside the workspace: ${target}`)
  }
  return abs
}

export function createGenerateDiagramTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'generate_diagram',
    label: 'Generate Diagram',
    description:
      'Generate a publication-quality scientific diagram from a natural-language description. ' +
      'The tool runs a verdict-driven generate → review → (optional) edit loop using the configured ' +
      'image provider (OpenAI) and review provider (OpenAI or Anthropic). Supports flowcharts, ' +
      'architecture, pathways, circuits, networks, and conceptual frameworks. ' +
      'Prompt guidance: be specific about components, labels, exact counts/values, and layout direction.',
    parameters: GenerateDiagramSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>

      const userPrompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
      const outputArg = typeof params.output === 'string' ? params.output.trim() : ''

      if (!userPrompt) {
        return toAgentResult('generate_diagram', toolError('MISSING_PARAMETER', 'Missing prompt.', {
          suggestions: ['Describe the diagram: type, components, labels, layout.'],
        }))
      }
      if (!outputArg) {
        return toAgentResult('generate_diagram', toolError('MISSING_PARAMETER', 'Missing output.', {
          suggestions: ['Provide a workspace-relative output path, e.g. figures/diagram.png.'],
        }))
      }

      const docType = sanitizeDocType(params.doc_type)
      const diagramType = sanitizeDiagramType(params.diagram_type, userPrompt)
      const iterations = sanitizeIterations(params.iterations)

      // Only validate reference_mode when a reference_path was supplied.
      // The schema advertises three modes for forward compatibility but
      // we refuse to silently ignore the unimplemented two; an explicit
      // error is more honest than pretending we did what we were asked.
      const hasReference = typeof params.reference_path === 'string' && !!params.reference_path.trim()
      let referenceMode: ReferenceMode = 'revise_layout'
      if (hasReference || params.reference_mode !== undefined) {
        const parsed = sanitizeReferenceMode(params.reference_mode)
        if (!parsed.ok) {
          return toAgentResult('generate_diagram', toolError('INVALID_PARAMETER', parsed.reason, {
            suggestions: [
              `Use reference_mode: ${SUPPORTED_REFERENCE_MODES.join(' or ')}.`,
              'Omit reference_path to draw without a reference image.',
            ],
            context: { provided: parsed.value },
          }))
        }
        referenceMode = parsed.mode
      }

      let absOutput: string
      try {
        absOutput = ensureInsideWorkspace(ctx.workspacePath, outputArg)
      } catch (err) {
        return toAgentResult('generate_diagram', toolError('PATH_OUTSIDE_WORKSPACE', (err as Error).message, {
          suggestions: ['Use a path relative to the workspace root.'],
        }))
      }

      const outDir = path.dirname(absOutput)
      const baseName = path.basename(absOutput, path.extname(absOutput))
      const extension = path.extname(absOutput) || '.png'
      fs.mkdirSync(outDir, { recursive: true })

      // Read live settings (hot-reload) — falls back to the static snapshot.
      // Note: `ctx.settings.diagram` is set by resolveSettings(); older
      // snapshots without the field default to 'auto'.
      const liveSettings = ctx.getSettings?.() ?? ctx.settings
      const reviewPref = liveSettings?.diagram?.reviewProvider ?? 'auto'
      const prefs: DiagramProviderPrefs = {
        generation: 'openai',
        review: reviewPref,
      }
      // Auth is also read fresh — user may have just signed in to Claude
      // subscription or saved a new OPENAI_API_KEY from Settings.
      const auth = ctx.getDiagramAuth?.()
      let providers
      try {
        providers = resolveProviders(prefs, auth)
      } catch (err) {
        return toAgentResult('generate_diagram', toolError('LLM_UNAVAILABLE', (err as Error).message, {
          suggestions: [
            'Ask the user to add OPENAI_API_KEY under Settings → API Keys. ChatGPT / Codex subscription tokens are scoped to the Codex endpoint and do NOT grant Images API access, so subscription-only users must supply a real sk-… API key for diagram generation.',
            'While the user is adding the key, offer to draft an inline SVG placeholder or ASCII sketch so the surrounding document is not blocked.',
            'Alternatively, leave a "figure TBD" caption with a textual description of what the figure should show, so the user can regenerate later without re-explaining the intent.',
            'For review (separate from generation), ANTHROPIC_API_KEY or a Claude subscription login is also sufficient — but both paths require OPENAI_API_KEY for the generation step itself.',
          ],
        }))
      }

      // Optional reference image — read bytes for later use.
      let referenceBytes: Buffer | null = null
      if (hasReference) {
        try {
          const refAbs = ensureInsideWorkspace(ctx.workspacePath, (params.reference_path as string).trim())
          if (!fs.existsSync(refAbs)) {
            return toAgentResult('generate_diagram', toolError('FILE_NOT_FOUND', `Reference image not found: ${params.reference_path}`, {
              suggestions: ['Check the reference_path is relative to the workspace root.'],
            }))
          }
          referenceBytes = fs.readFileSync(refAbs)
        } catch (err) {
          return toAgentResult('generate_diagram', toolError('PATH_OUTSIDE_WORKSPACE', (err as Error).message))
        }
      }

      const threshold = providers.review.thresholds[docType] ?? providers.review.thresholds.default
      const history: IterationRecord[] = []
      let prevImage: Buffer | null = referenceBytes && referenceMode !== 'style_only' ? referenceBytes : null
      let stoppedEarly = false

      for (let i = 1; i <= iterations; i++) {
        // Pick generation strategy.
        const canEdit = !!providers.image.imageToImage && providers.image.capabilities.has('image_to_image')
        const lastReview = history[history.length - 1]?.review

        let image: Buffer
        let usedEdit = false
        let promptForThisIter: string

        if (i === 1) {
          promptForThisIter = composeGenerationPrompt(userPrompt, diagramType)
          // Reference image on first iteration: if revise_layout + backend supports edit, use it.
          if (prevImage && canEdit && referenceMode === 'revise_layout') {
            image = await providers.image.imageToImage!(promptForThisIter, prevImage)
            usedEdit = true
          } else {
            image = await providers.image.textToImage(promptForThisIter)
          }
        } else if (lastReview?.verdict === 'needs_edit' && prevImage && canEdit) {
          promptForThisIter = composeEditPrompt(userPrompt, diagramType, lastReview.blockingIssues)
          image = await providers.image.imageToImage!(promptForThisIter, prevImage)
          usedEdit = true
        } else {
          promptForThisIter = composeRegenPrompt(userPrompt, diagramType, lastReview?.blockingIssues ?? [])
          image = await providers.image.textToImage(promptForThisIter)
        }

        const iterPath = path.join(outDir, `${baseName}_v${i}${extension}`)
        fs.writeFileSync(iterPath, image)

        let rawReview: ReviewResult
        try {
          rawReview = await providers.review.review({
            image,
            prompt: userPrompt,
            docType,
            diagramType,
            iteration: i,
            maxIterations: iterations,
          })
        } catch (err) {
          return toAgentResult('generate_diagram', toolError('API_ERROR', `Review failed: ${(err as Error).message}`, {
            retryable: true,
            suggestions: ['Retry the tool call.', 'Switch the review provider in Settings.'],
            context: { imagePath: path.relative(ctx.workspacePath, iterPath) },
            data: { partialPath: path.relative(ctx.workspacePath, iterPath) },
          }))
        }

        // Guard the verdict against reviewer output that says "acceptable"
        // while contradicting itself with a low score or non-empty blocking
        // issues. Without this check the loop could stop early on a
        // structurally wrong image just because the reviewer mislabelled
        // its own verdict.
        const reconciled = reconcileVerdict(rawReview, threshold)
        const review = reconciled.final

        history.push({
          iteration: i,
          imagePath: path.relative(ctx.workspacePath, iterPath),
          usedEdit,
          review,
          rawVerdict: rawReview.verdict,
          verdictOverrideReason: reconciled.override,
          promptSnippet: promptForThisIter.slice(0, 400),
        })

        prevImage = image

        if (review.verdict === 'acceptable') {
          stoppedEarly = i < iterations
          break
        }
      }

      const last = history[history.length - 1]
      if (!last) {
        return toAgentResult('generate_diagram', toolError('EXECUTION_FAILED', 'No iterations completed.', {
          retryable: true,
        }))
      }

      // Copy final image to canonical output path.
      const finalAbsIter = path.resolve(ctx.workspacePath, last.imagePath)
      if (finalAbsIter !== absOutput) {
        fs.copyFileSync(finalAbsIter, absOutput)
      }

      // Write review log alongside the output.
      const reviewLogPath = path.join(outDir, `${baseName}_review_log.json`)
      const logPayload = {
        prompt: userPrompt,
        docType,
        diagramType,
        threshold,
        provider: {
          image: providers.image.id,
          review: providers.review.id,
        },
        iterations: history.map((h) => ({
          iteration: h.iteration,
          imagePath: h.imagePath,
          usedEdit: h.usedEdit,
          review: h.review,
          rawVerdict: h.rawVerdict,
          verdictOverrideReason: h.verdictOverrideReason,
        })),
        stoppedEarly,
      }
      fs.writeFileSync(reviewLogPath, JSON.stringify(logPayload, null, 2), 'utf-8')

      const payload: DiagramToolPayload = {
        outputPath: path.relative(ctx.workspacePath, absOutput),
        absoluteOutputPath: absOutput,
        iterations: history,
        finalScore: last.review.score,
        finalVerdict: last.review.verdict,
        threshold,
        provider: {
          image: providers.image.id,
          review: providers.review.id,
        },
        reviewLogPath: path.relative(ctx.workspacePath, reviewLogPath),
        stoppedEarly,
      }

      return toAgentResult('generate_diagram', { success: true, data: payload })
    },
  }
}
