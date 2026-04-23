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

const VALID_REFERENCE_MODES: ReferenceMode[] = [
  'revise_layout', 'style_only', 'local_edit',
]

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
    description: 'Optional workspace-relative path to a reference image to build upon or use as style.',
  })),
  reference_mode: Type.Optional(Type.String({
    description: `How to use the reference image. One of: ${VALID_REFERENCE_MODES.join(' | ')}. Defaults to revise_layout.`,
  })),
})

interface IterationRecord {
  iteration: number
  imagePath: string
  usedEdit: boolean
  review: ReviewResult
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

function sanitizeReferenceMode(value: unknown): ReferenceMode {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : 'revise_layout'
  return (VALID_REFERENCE_MODES as string[]).includes(v) ? (v as ReferenceMode) : 'revise_layout'
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

      // Resolve providers. Review provider comes from user settings; falls
      // back to 'auto' (prefer heterogeneous review) when unconfigured.
      const reviewPref = ctx.settings?.diagram?.reviewProvider ?? 'auto'
      const prefs: DiagramProviderPrefs = {
        generation: 'openai',
        review: reviewPref,
      }
      let providers
      try {
        providers = resolveProviders(prefs)
      } catch (err) {
        return toAgentResult('generate_diagram', toolError('LLM_UNAVAILABLE', (err as Error).message, {
          suggestions: [
            'Add OPENAI_API_KEY under Settings → API Keys (required for image generation).',
            'Optionally add ANTHROPIC_API_KEY for cross-provider review.',
          ],
        }))
      }

      // Optional reference image — read bytes for later use.
      let referenceBytes: Buffer | null = null
      const referenceMode = sanitizeReferenceMode(params.reference_mode)
      if (typeof params.reference_path === 'string' && params.reference_path.trim()) {
        try {
          const refAbs = ensureInsideWorkspace(ctx.workspacePath, params.reference_path.trim())
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

        let review: ReviewResult
        try {
          review = await providers.review.review({
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

        history.push({
          iteration: i,
          imagePath: path.relative(ctx.workspacePath, iterPath),
          usedEdit,
          review,
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
