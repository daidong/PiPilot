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
import { fixedBetween, regressionsAgainst } from './diagram-backends/issue-tracking.js'
import type {
  BlockingIssue,
  BlockingIssueKind,
  DiagramType,
  DocType,
  Quality,
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

// Aspect → OpenAI size string. 'auto' lets the model pick based on prompt
// content; the other three map to the three sizes gpt-image-2 accepts.
// Exposed as a named knob so the agent can lock an aspect when it knows the
// diagram is clearly horizontal/vertical (agents otherwise tend to describe
// the figure without signalling shape, and 'auto' then picks conservatively).
type Aspect = 'auto' | 'square' | 'landscape' | 'portrait'
const VALID_ASPECTS: Aspect[] = ['auto', 'square', 'landscape', 'portrait']

function aspectToSize(aspect: Aspect): string {
  switch (aspect) {
    case 'square':    return '1024x1024'
    case 'landscape': return '1536x1024'
    case 'portrait':  return '1024x1536'
    case 'auto':      return 'auto'
  }
}

function sanitizeAspect(value: unknown): Aspect {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  return (VALID_ASPECTS as string[]).includes(v) ? (v as Aspect) : 'auto'
}

// Output format handling.
// Agents carry the user's "I want SVG" / "I want PNG" intent into the tool
// via TWO redundant channels:
//   - an explicit `format` parameter, and
//   - the extension of the `output` path.
// Either one is enough; when both are present and disagree, `format` wins
// and we rewrite the output extension to match (reported via
// `extensionChanged` in the result payload so the agent can correct any
// follow-up Markdown embed).
type Format = 'auto' | 'png' | 'svg'
const VALID_FORMATS: Format[] = ['auto', 'png', 'svg']

function sanitizeFormat(value: unknown): Format {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  return (VALID_FORMATS as string[]).includes(v) ? (v as Format) : 'auto'
}

type EffectiveFormat = 'png' | 'svg'

function resolveEffectiveFormat(format: Format, extension: string): EffectiveFormat {
  if (format === 'svg') return 'svg'
  if (format === 'png') return 'png'
  // auto → infer from extension; anything that is not .svg falls to raster.
  return extension.toLowerCase() === '.svg' ? 'svg' : 'png'
}

// Quality tier handling.
// Default mapping balances cost against the minimum fidelity each document
// type can tolerate: strict venues (journal / conference / thesis / grant)
// start at 'high'; mid-tier docs at 'medium'; presentations default to
// 'low' so the first draft is cheap and the agent can upgrade if needed.
const VALID_QUALITIES: Quality[] = ['low', 'medium', 'high', 'auto']
const QUALITY_ORDER: Quality[] = ['low', 'medium', 'high']

function defaultQualityForDocType(docType: DocType): Quality {
  switch (docType) {
    case 'journal':
    case 'conference':
    case 'thesis':
    case 'grant':
      return 'high'
    case 'preprint':
    case 'report':
    case 'poster':
      return 'medium'
    case 'presentation':
      return 'low'
    default:
      return 'medium'
  }
}

function sanitizeQuality(value: unknown): Quality | undefined {
  if (value === undefined || value === null) return undefined
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (VALID_QUALITIES as string[]).includes(v) ? (v as Quality) : undefined
}

/**
 * Bump one tier up the ladder on a `needs_edit` iteration — 'needs_edit'
 * means the draft was close but needs polish, which is exactly where
 * extra compute pays off. 'auto' is treated as 'medium' for bumping
 * since we cannot introspect what the model actually chose.
 */
function bumpedQuality(current: Quality): Quality {
  const anchor: Quality = current === 'auto' ? 'medium' : current
  const idx = QUALITY_ORDER.indexOf(anchor)
  if (idx < 0 || idx >= QUALITY_ORDER.length - 1) return current
  return QUALITY_ORDER[idx + 1]
}

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
  aspect: Type.Optional(Type.String({
    description: 'Output aspect ratio. One of: auto | square | landscape | portrait. Default: auto (model picks from the prompt). Use "landscape" for wide architecture / flow diagrams with >3 horizontal panels, "portrait" for top-to-bottom CONSORT / PRISMA flows, "square" for single-concept schematics.',
  })),
  format: Type.Optional(Type.String({
    description: 'Desired output format: auto | png | svg. Default: auto (inferred from the output extension). Pass "svg" when the user says "SVG / 矢量图 / vector / 向量图", pass "png" when they say "PNG / 图片 / raster". Explicit format beats the extension: if format="svg" but output="foo.png", the file is renamed to foo.svg and extensionChanged is reported.',
  })),
  quality: Type.Optional(Type.String({
    description: 'gpt-image-2 rendering quality: low | medium | high | auto. When omitted, defaults from doc_type — high for journal/conference/thesis/grant, medium for preprint/report/poster, low for presentation. Start at low for cheap exploration; the tool automatically bumps one tier on a needs_edit verdict in later iterations.',
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
  /** Quality tier actually sent to the image backend for this iteration. */
  quality: Quality
  review: ReviewResult
  /** The verdict the reviewer originally emitted, before tool-side reconciliation. */
  rawVerdict: ReviewResult['verdict']
  /** Populated when the reviewer's verdict was overridden due to contradictory fields. */
  verdictOverrideReason?: string
  /** Populated when this iteration reintroduced a previously-fixed issue. */
  regressedIssues?: BlockingIssue[]
  promptSnippet: string
}

interface DiagramToolPayload {
  outputPath: string
  absoluteOutputPath: string
  iterations: IterationRecord[]
  finalScore: number
  finalVerdict: ReviewResult['verdict']
  threshold: number
  /** 'image' when gpt-image-2 drew a raster PNG; 'svg_fallback' when the chat model produced SVG. */
  mode: 'image' | 'svg_fallback'
  provider: { image: string; review: string }
  reviewLogPath: string
  stoppedEarly: boolean
  /** Why the loop stopped: 'acceptable' / 'max_iterations' / 'regression_detected: …'. */
  stoppedReason?: string
  /** Non-null when the output extension was rewritten (e.g. user asked for .png, fallback produced .svg). */
  extensionChanged?: { requested: string; actual: string }
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
// Issue kinds that should never be silently tolerated even when the score
// comfortably clears threshold — they represent actual content errors or
// readability failures, not merely aesthetic roughness.
const CRITICAL_ISSUE_KINDS: BlockingIssueKind[] = [
  'wrong_content',
  'missing_element',
  'illegible_text',
]

function hasCriticalIssue(issues: BlockingIssue[]): boolean {
  return issues.some((i) => CRITICAL_ISSUE_KINDS.includes(i.kind))
}

/**
 * Reconcile the reviewer's verdict against its own fields. Two moves:
 *
 *   1. Tighten when verdict says 'acceptable' but score is below threshold
 *      or blocking issues exist — the reviewer contradicted itself.
 *   2. Relax when verdict says 'needs_edit' but score comfortably exceeds
 *      threshold (gap ≥ 1.0) AND no critical issues are present. Minor
 *      cosmetic gripes should not force the loop to burn another round.
 */
function reconcileVerdict(
  review: ReviewResult,
  threshold: number
): { final: ReviewResult; override?: string } {
  if (review.verdict === 'acceptable') {
    if (review.score < threshold) {
      return {
        final: { ...review, verdict: 'needs_edit' },
        override: `reviewer said acceptable but score ${review.score} < threshold ${threshold}`,
      }
    }
    if (review.blockingIssues.length > 0) {
      const hasStructural = hasCriticalIssue(review.blockingIssues)
      return {
        final: { ...review, verdict: hasStructural ? 'needs_regen' : 'needs_edit' },
        override: `reviewer said acceptable but listed ${review.blockingIssues.length} blocking issues`,
      }
    }
    return { final: review }
  }

  if (
    review.verdict === 'needs_edit' &&
    review.score >= threshold + 1.0 &&
    !hasCriticalIssue(review.blockingIssues)
  ) {
    // Score gap is comfortable and every remaining issue is cosmetic
    // (layout_collision / style_mismatch). Ship it.
    return {
      final: { ...review, verdict: 'acceptable' },
      override: `score ${review.score} ≥ threshold ${threshold} + 1.0 with no critical issues — accepting despite ${review.blockingIssues.length} minor note(s)`,
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
      const aspect = sanitizeAspect(params.aspect)
      const explicitQuality = sanitizeQuality(params.quality)
      const defaultQuality = defaultQualityForDocType(docType)
      const initialQuality: Quality = explicitQuality ?? defaultQuality

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
      const originalExtension = path.extname(absOutput) || '.png'
      fs.mkdirSync(outDir, { recursive: true })

      // Format intent flows through two redundant channels: the explicit
      // `format` parameter and the extension of `output`. Explicit wins
      // when they disagree — the agent may know the user wanted SVG even
      // if it wrote a .png filename out of habit. When `format: 'svg'`
      // overrides a .png path (or vice versa), the actual on-disk
      // extension is adjusted so the file matches its content.
      const formatPref = sanitizeFormat(params.format)
      const effectiveFormat = resolveEffectiveFormat(formatPref, originalExtension)
      const userRequestedSvg = effectiveFormat === 'svg'

      // Read live settings (hot-reload) — falls back to the static snapshot.
      // Note: `ctx.settings.diagram` is set by resolveSettings(); older
      // snapshots without the field default to 'auto'.
      const liveSettings = ctx.getSettings?.() ?? ctx.settings
      const reviewPref = liveSettings?.diagram?.reviewProvider ?? 'auto'
      const prefs: DiagramProviderPrefs = {
        generation: 'openai',
        review: reviewPref,
        imageSize: aspectToSize(aspect),
        imageQuality: initialQuality,
        svgAspect: aspect,
        forceSvg: userRequestedSvg,
      }
      // Auth is also read fresh — user may have just signed in to Claude
      // subscription or saved a new OPENAI_API_KEY from Settings.
      const auth = ctx.getDiagramAuth?.()
      // Fallback bundle: when OpenAI image generation is unavailable, the
      // registry will route both gen and review through the chat model via
      // ctx.callLlm. Pass `undefined` when callLlm is missing so the
      // registry raises the original "no provider" error instead of a
      // silent fallback to nothing.
      // `rasterizeSvg` rides along so the registry can upgrade SVG-path
      // review from source-level to visual (rasterize → vision model).
      // Safe when absent: registry falls back to the existing text
      // review via callLlm.
      const fallback = ctx.callLlm
        ? { callLlm: ctx.callLlm, rasterizeSvg: ctx.rasterizeSvg }
        : undefined
      let providers
      try {
        providers = resolveProviders(prefs, auth, fallback)
      } catch (err) {
        return toAgentResult('generate_diagram', toolError('LLM_UNAVAILABLE', (err as Error).message, {
          suggestions: [
            'Ask the user to add OPENAI_API_KEY under Settings → API Keys for native image generation (gpt-image-2). ChatGPT / Codex subscription tokens are scoped to the Codex endpoint and cannot call the Images API.',
            'Alternatively, leave a "figure TBD" caption with a textual description so the user can regenerate later without re-explaining the intent.',
          ],
        }))
      }

      // Reconcile requested vs. actual output format. Three sources can
      // disagree:
      //   (a) the file extension the agent passed on `output`,
      //   (b) the explicit `format` parameter (format wins over extension
      //       when they disagree — agent may know intent the filename missed),
      //   (c) auto-fallback inside the registry (no OpenAI key forces SVG).
      // The on-disk extension must match the bytes we are about to write,
      // so we always derive it from the provider's actual output format.
      const providerFormat: EffectiveFormat = providers.svgFallback ? 'svg' : 'png'
      const extension = providerFormat === 'svg' ? '.svg' : '.png'
      const finalAbsOutput = extension !== originalExtension
        ? path.join(outDir, `${baseName}${extension}`)
        : absOutput

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
      let stoppedReason: string | undefined
      // Accumulated corrections across iterations. An issue lands here
      // the first iteration the reviewer stops complaining about it.
      // Used to (a) feed preserved items into the next edit prompt so
      // the model keeps earlier fixes intact, and (b) detect regression
      // when a later draft reintroduces a once-fixed problem.
      const fixedSoFar: BlockingIssue[] = []
      // Quality ladder: first iteration uses the doc_type default (or
      // explicit override); needs_edit bumps one tier so expensive
      // refinement only fires when the reviewer said the draft was
      // close. needs_regen keeps the same tier — regenerating at a
      // higher tier would amplify a fundamentally wrong draft.
      let currentQuality: Quality = initialQuality

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
            image = await providers.image.imageToImage!(promptForThisIter, prevImage, { quality: currentQuality })
            usedEdit = true
          } else {
            image = await providers.image.textToImage(promptForThisIter, { quality: currentQuality })
          }
        } else if (lastReview?.verdict === 'needs_edit' && prevImage && canEdit) {
          currentQuality = bumpedQuality(currentQuality)
          promptForThisIter = composeEditPrompt(
            userPrompt,
            diagramType,
            lastReview.blockingIssues,
            fixedSoFar
          )
          image = await providers.image.imageToImage!(promptForThisIter, prevImage, { quality: currentQuality })
          usedEdit = true
        } else {
          promptForThisIter = composeRegenPrompt(userPrompt, diagramType, lastReview?.blockingIssues ?? [])
          image = await providers.image.textToImage(promptForThisIter, { quality: currentQuality })
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

        // Regression detection: did this review re-introduce any issue
        // that was marked fixed in a previous iteration? If so, another
        // edit round will likely keep oscillating — stop now and return
        // the current best draft with a warning in the log.
        const regressed = regressionsAgainst(fixedSoFar, review.blockingIssues)

        history.push({
          iteration: i,
          imagePath: path.relative(ctx.workspacePath, iterPath),
          usedEdit,
          quality: currentQuality,
          review,
          rawVerdict: rawReview.verdict,
          verdictOverrideReason: reconciled.override,
          regressedIssues: regressed.length > 0 ? regressed : undefined,
          promptSnippet: promptForThisIter.slice(0, 400),
        })

        prevImage = image

        // Update the "already fixed" set for the NEXT iteration's edit
        // prompt. Diff previous→current: any issue the reviewer stopped
        // complaining about joins fixedSoFar.
        if (lastReview) {
          const newlyFixed = fixedBetween(lastReview.blockingIssues, review.blockingIssues)
          for (const f of newlyFixed) fixedSoFar.push(f)
        }

        if (review.verdict === 'acceptable') {
          stoppedEarly = i < iterations
          stoppedReason = 'acceptable'
          break
        }

        if (regressed.length > 0 && i < iterations) {
          stoppedEarly = true
          stoppedReason = `regression_detected: ${regressed.length} previously-fixed issue(s) returned`
          break
        }
      }

      const last = history[history.length - 1]
      if (!last) {
        return toAgentResult('generate_diagram', toolError('EXECUTION_FAILED', 'No iterations completed.', {
          retryable: true,
        }))
      }

      // Materialise the final output. On a single-iteration hit v1 is
      // bit-identical to the final file, so copying would leave 2× the
      // bytes on disk for no benefit — rename instead. In multi-iteration
      // runs we keep every intermediate v_i as evidence of the draft
      // history and copy v_last → final so readers can diff drafts.
      const finalAbsIter = path.resolve(ctx.workspacePath, last.imagePath)
      if (finalAbsIter !== finalAbsOutput) {
        if (history.length === 1) {
          fs.renameSync(finalAbsIter, finalAbsOutput)
          // Keep the review log consistent: iter 1's imagePath now points
          // at the canonical output, not the (gone) v1 path.
          last.imagePath = path.relative(ctx.workspacePath, finalAbsOutput)
        } else {
          fs.copyFileSync(finalAbsIter, finalAbsOutput)
        }
      }

      // Write review log alongside the output.
      const reviewLogPath = path.join(outDir, `${baseName}_review_log.json`)
      const logPayload = {
        prompt: userPrompt,
        docType,
        diagramType,
        aspect,
        format: {
          requested: formatPref,
          effectiveFromParams: effectiveFormat,
          actual: providerFormat,
          originalExtension,
          finalExtension: extension,
        },
        threshold,
        mode: providers.svgFallback ? 'svg_fallback' : 'image',
        quality: {
          initial: initialQuality,
          defaultForDocType: defaultQuality,
          explicit: explicitQuality ?? null,
        },
        provider: {
          image: providers.image.id,
          review: providers.review.id,
        },
        iterations: history.map((h) => ({
          iteration: h.iteration,
          imagePath: h.imagePath,
          usedEdit: h.usedEdit,
          quality: h.quality,
          review: h.review,
          rawVerdict: h.rawVerdict,
          verdictOverrideReason: h.verdictOverrideReason,
          regressedIssues: h.regressedIssues,
        })),
        stoppedEarly,
        stoppedReason: stoppedReason ?? (stoppedEarly ? undefined : 'max_iterations'),
        fixedAcrossIterations: fixedSoFar,
      }
      fs.writeFileSync(reviewLogPath, JSON.stringify(logPayload, null, 2), 'utf-8')

      const payload: DiagramToolPayload = {
        outputPath: path.relative(ctx.workspacePath, finalAbsOutput),
        absoluteOutputPath: finalAbsOutput,
        iterations: history,
        finalScore: last.review.score,
        finalVerdict: last.review.verdict,
        threshold,
        mode: providers.svgFallback ? 'svg_fallback' : 'image',
        provider: {
          image: providers.image.id,
          review: providers.review.id,
        },
        reviewLogPath: path.relative(ctx.workspacePath, reviewLogPath),
        stoppedEarly,
        stoppedReason: stoppedReason ?? (stoppedEarly ? undefined : 'max_iterations'),
        extensionChanged: originalExtension !== extension
          ? { requested: originalExtension, actual: extension }
          : undefined,
      }

      return toAgentResult('generate_diagram', { success: true, data: payload })
    },
  }
}
