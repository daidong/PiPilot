import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineTool } from '../../../src/factories/define-tool.js'
import type { Tool, ToolContext } from '../../../src/types/tool.js'
import type { TokenTracker } from '../../../src/core/token-tracker.js'

import { createLiteratureTeam } from './literature/literature-team.js'
import { PATHS } from './literature/types.js'

interface LiteratureSearchInput {
  query: string
  context?: string
}

interface LiteratureSearchResult {
  briefSummary: string
  coverage: {
    score: number
    subTopics: Array<{
      name: string
      paperCount: number
      covered: boolean
      gaps: string[]
    }>
    queriesExecuted: string[]
  }
  totalPapersFound: number
  papersAutoSaved: number
  fullReviewPath: string
  paperListPath: string
  durationMs: number
  llmCallCount: number
  apiCallCount: number
  apiFailureCount: number
  persistedPapersPath: string
}

export interface LiteratureSubagentConfig {
  apiKey?: string
  model: string
  projectPath: string
  sessionId?: string
  maxCallsPerTurn?: number
  tokenTracker?: TokenTracker
}

interface LiteratureSearchCacheEntry {
  key: string
  normalizedRequest: string
  query: string
  context?: string
  updatedAt: string
  result: LiteratureSearchResult
}

interface LiteratureSearchCacheFile {
  version: 1
  entries: Record<string, LiteratureSearchCacheEntry>
}

const CACHE_FILE_NAME = 'literature-search-cache.v1.json'
const CACHE_VERSION = 1
const CACHE_SIMILARITY_THRESHOLD = 0.93

function normalizeRequest(query: string, context?: string): string {
  const combined = context?.trim()
    ? `${query.trim()} ${context.trim()}`
    : query.trim()
  return combined
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0

  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

function cacheKeyFor(normalizedRequest: string): string {
  return createHash('sha256').update(normalizedRequest).digest('hex')
}

async function readCache(cachePath: string): Promise<LiteratureSearchCacheFile> {
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LiteratureSearchCacheFile> | undefined
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
      return { version: CACHE_VERSION, entries: {} }
    }
    return {
      version: CACHE_VERSION,
      entries: parsed.entries as Record<string, LiteratureSearchCacheEntry>
    }
  } catch {
    return { version: CACHE_VERSION, entries: {} }
  }
}

async function writeCache(cachePath: string, cache: LiteratureSearchCacheFile): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
}

function findCacheHit(
  cache: LiteratureSearchCacheFile,
  normalizedRequest: string
): LiteratureSearchCacheEntry | null {
  const exact = cache.entries[cacheKeyFor(normalizedRequest)]
  if (exact) return exact

  const requestTokens = tokenize(normalizedRequest)
  let best: LiteratureSearchCacheEntry | null = null
  let bestScore = 0
  for (const entry of Object.values(cache.entries)) {
    const score = jaccardSimilarity(requestTokens, tokenize(entry.normalizedRequest))
    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }

  if (best && bestScore >= CACHE_SIMILARITY_THRESHOLD) {
    return best
  }

  return null
}

function resolveApiKey(explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim()

  const candidates = [
    process.env['OPENAI_API_KEY'],
    process.env['ANTHROPIC_API_KEY'],
    process.env['DEEPSEEK_API_KEY'],
    process.env['GOOGLE_API_KEY'],
    process.env['GEMINI_API_KEY']
  ]

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function createLiteratureSearchTool(config: LiteratureSubagentConfig): Tool<LiteratureSearchInput, LiteratureSearchResult> {
  let callCount = 0
  let lastTurnStep = -1

  return defineTool<LiteratureSearchInput, LiteratureSearchResult>({
    name: 'literature-search',
    description: 'Run a full literature-study subagent (plan/search/review/summarize), auto-save relevant papers, and return coverage + local review paths.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Main literature question or topic.'
      },
      context: {
        type: 'string',
        required: false,
        description: 'Optional additional context to disambiguate the topic.'
      }
    },
    execute: async (input, toolContext?: ToolContext) => {
      const query = input.query?.trim()
      if (!query) {
        return { success: false, error: 'literature-search requires a non-empty query' }
      }

      const currentStep = toolContext?.step ?? 0
      if (currentStep !== lastTurnStep) {
        callCount = 0
        lastTurnStep = currentStep
      }
      callCount += 1

      const maxCalls = Math.max(1, config.maxCallsPerTurn ?? 1)
      if (callCount > maxCalls) {
        return {
          success: false,
          error: `literature-search already called ${maxCalls} time(s) in this turn; reuse the existing results.`
        }
      }

      const normalizedRequest = normalizeRequest(query, input.context)
      const cachePath = join(config.projectPath, PATHS.reviews, CACHE_FILE_NAME)
      const cache = await readCache(cachePath)
      const cachedEntry = findCacheHit(cache, normalizedRequest)
      if (cachedEntry) {
        return {
          success: true,
          data: {
            ...cachedEntry.result,
            persistedPapersPath: PATHS.papers
          }
        }
      }

      const apiKey = resolveApiKey(config.apiKey)
      if (!apiKey) {
        return {
          success: false,
          error: 'No API key available for literature subagent and no reusable cached literature result was found.'
        }
      }

      try {
        const team = createLiteratureTeam({
          apiKey,
          model: config.model,
          projectPath: config.projectPath,
          sessionId: config.sessionId ?? 'yolo',
          messages: toolContext?.messages as unknown[] | undefined,
          toolContext,
          tokenTracker: config.tokenTracker
        })

        const request = input.context?.trim()
          ? `${query}\n\nAdditional context: ${input.context.trim()}`
          : query
        const result = await team.research(request)

        if (!result.success || !result.result?.data) {
          return {
            success: false,
            error: result.error ?? 'literature-search failed'
          }
        }

        const payload: LiteratureSearchResult = {
          ...result.result.data,
          persistedPapersPath: PATHS.papers
        }
        const key = cacheKeyFor(normalizedRequest)
        cache.entries[key] = {
          key,
          normalizedRequest,
          query,
          context: input.context?.trim() || undefined,
          updatedAt: new Date().toISOString(),
          result: payload
        }
        await writeCache(cachePath, cache)

        return {
          success: true,
          data: payload
        }
      } catch (error) {
        return {
          success: false,
          error: `literature-search error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  })
}
