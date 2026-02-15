import { defineTool } from '../../../src/factories/define-tool.js'
import { createLLMClientFromModelId } from '../../../src/index.js'
import type { TokenTracker } from '../../../src/core/token-tracker.js'
import type { Tool, ToolContext } from '../../../src/types/tool.js'

const WRITING_OUTLINER_SYSTEM = `You are a Research Writing Specialist who creates clear, well-structured outlines.

Good academic writing is not a list of points. Build a narrative arc:
motivation -> tension -> contribution -> evidence -> resolution.

When given a topic and optional notes/literature, create an outline that:
1. Has a coherent story flow
2. Identifies key sections/subsections
3. Notes where citations are needed
4. Suggests word counts

Output JSON only:
{
  "title": "Proposed document title",
  "type": "paper|report|review|proposal",
  "sections": [
    {
      "heading": "Section heading",
      "level": 1,
      "description": "What this section covers",
      "subsections": ["..."],
      "suggestedWordCount": 500,
      "citationsNeeded": ["topic1", "topic2"]
    }
  ],
  "estimatedTotalWords": 3000,
  "notes": "Additional suggestions"
}`

const WRITING_DRAFTER_SYSTEM = `You are a Research Writing Specialist who drafts compelling, scholarly prose.

Write narrative, coherent, citation-aware text. Prefer full sentences and natural transitions.
Use [Author, Year] citation style where citations are provided.

Output JSON only:
{
  "sectionHeading": "The section heading",
  "content": "The drafted content...",
  "wordCount": 500,
  "citationsUsed": [
    { "key": "Author2024", "context": "Where/how used" }
  ],
  "suggestions": "Revision notes"
}`

interface WritingOutlineInput {
  topic: string
  docType?: 'paper' | 'report' | 'review' | 'proposal'
  notes?: string
  literatureContext?: string
}

interface WritingDraftInput {
  sectionHeading: string
  sectionOutline?: string
  instructions?: string
  sourceNotes?: string
  citationHints?: string[]
}

export interface WritingSubagentConfig {
  apiKey?: string
  model: string
  maxCallsPerTurn?: number
  tokenTracker?: TokenTracker
}

function resolveApiKey(explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim()
  const keys = [
    process.env['OPENAI_API_KEY'],
    process.env['ANTHROPIC_API_KEY'],
    process.env['DEEPSEEK_API_KEY'],
    process.env['GOOGLE_API_KEY'],
    process.env['GEMINI_API_KEY']
  ]
  return keys.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // fall through
  }

  const fence = text.match(/```json\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1].trim())
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // fall through
    }
  }

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // fall through
    }
  }
  return null
}

function createTurnCallLimiter(maxCallsPerTurn: number) {
  let lastStep = -1
  let callCount = 0

  return (toolContext?: ToolContext): { ok: boolean; message?: string } => {
    const currentStep = toolContext?.step ?? 0
    if (currentStep !== lastStep) {
      lastStep = currentStep
      callCount = 0
    }
    callCount += 1
    if (callCount > maxCallsPerTurn) {
      return {
        ok: false,
        message: `writing tool already called ${maxCallsPerTurn} time(s) in this turn; reuse current draft/outline.`
      }
    }
    return { ok: true }
  }
}

export function createWritingTools(config: WritingSubagentConfig): {
  writingOutlineTool: Tool<WritingOutlineInput, Record<string, unknown>>
  writingDraftTool: Tool<WritingDraftInput, Record<string, unknown>>
} {
  const apiKey = resolveApiKey(config.apiKey)
  const maxCalls = Math.max(1, config.maxCallsPerTurn ?? 2)
  const outlineLimiter = createTurnCallLimiter(maxCalls)
  const draftLimiter = createTurnCallLimiter(maxCalls)
  const llmClient = apiKey ? createLLMClientFromModelId(config.model, { apiKey }) : null
  const tracker = config.tokenTracker

  const runWritingModel = async (system: string, prompt: string): Promise<Record<string, unknown>> => {
    if (!llmClient) throw new Error('No API key available for writing subagent.')
    const result = await llmClient.generate({
      system,
      messages: [{ role: 'user' as const, content: prompt }]
    })
    tracker?.recordCall(config.model, result.usage)
    const parsed = tryParseJsonObject(result.text)
    if (!parsed) {
      throw new Error('writing subagent returned non-JSON output')
    }
    return parsed
  }

  const writingOutlineTool = defineTool<WritingOutlineInput, Record<string, unknown>>({
    name: 'writing-outline',
    description: 'Generate a narrative-first academic writing outline in strict JSON format.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Main writing topic or title.' },
      docType: { type: 'string', required: false, enum: ['paper', 'report', 'review', 'proposal'], description: 'Target document type.' },
      notes: { type: 'string', required: false, description: 'Additional constraints, scope, or audience notes.' },
      literatureContext: { type: 'string', required: false, description: 'Optional related-work or citation context.' }
    },
    execute: async (input, toolContext) => {
      if (!input.topic?.trim()) {
        return { success: false, error: 'writing-outline requires a non-empty topic' }
      }

      const limiter = outlineLimiter(toolContext)
      if (!limiter.ok) return { success: false, error: limiter.message }

      try {
        const prompt = [
          `Topic: ${input.topic.trim()}`,
          input.docType ? `Document type: ${input.docType}` : undefined,
          input.notes?.trim() ? `Notes: ${input.notes.trim()}` : undefined,
          input.literatureContext?.trim() ? `Literature context: ${input.literatureContext.trim()}` : undefined
        ].filter(Boolean).join('\n')

        const data = await runWritingModel(WRITING_OUTLINER_SYSTEM, prompt)
        return { success: true, data }
      } catch (error) {
        return {
          success: false,
          error: `writing-outline error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  })

  const writingDraftTool = defineTool<WritingDraftInput, Record<string, unknown>>({
    name: 'writing-draft',
    description: 'Draft one academic section in narrative prose with citation-aware style, returning strict JSON.',
    parameters: {
      sectionHeading: { type: 'string', required: true, description: 'Section heading to draft.' },
      sectionOutline: { type: 'string', required: false, description: 'Relevant subsection structure or bullet outline.' },
      instructions: { type: 'string', required: false, description: 'Extra drafting requirements (tone, depth, constraints).' },
      sourceNotes: { type: 'string', required: false, description: 'Background notes or key points to integrate.' },
      citationHints: { type: 'array', required: false, description: 'Optional citation keys or references to weave in.' }
    },
    execute: async (input, toolContext) => {
      if (!input.sectionHeading?.trim()) {
        return { success: false, error: 'writing-draft requires a non-empty sectionHeading' }
      }

      const limiter = draftLimiter(toolContext)
      if (!limiter.ok) return { success: false, error: limiter.message }

      try {
        const prompt = [
          `Section heading: ${input.sectionHeading.trim()}`,
          input.sectionOutline?.trim() ? `Section outline: ${input.sectionOutline.trim()}` : undefined,
          input.instructions?.trim() ? `Instructions: ${input.instructions.trim()}` : undefined,
          input.sourceNotes?.trim() ? `Source notes: ${input.sourceNotes.trim()}` : undefined,
          input.citationHints?.length ? `Citation hints: ${input.citationHints.join(', ')}` : undefined
        ].filter(Boolean).join('\n')

        const data = await runWritingModel(WRITING_DRAFTER_SYSTEM, prompt)
        return { success: true, data }
      } catch (error) {
        return {
          success: false,
          error: `writing-draft error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  })

  return { writingOutlineTool, writingDraftTool }
}
