import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLiteratureSearchTool } from '../../examples/yolo-researcher/agents/literature-subagent.js'
import { PATHS } from '../../examples/yolo-researcher/agents/literature/types.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

const mocks = vi.hoisted(() => ({
  createLiteratureTeamMock: vi.fn(),
  researchMock: vi.fn()
}))

vi.mock('../../examples/yolo-researcher/agents/literature/literature-team.js', () => ({
  createLiteratureTeam: mocks.createLiteratureTeamMock
}))

const API_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY'
] as const

describe('literature subagent cache', () => {
  const tempDirs: string[] = []
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createLiteratureTeamMock.mockReturnValue({
      research: mocks.researchMock
    })

    for (const key of API_KEY_ENV_VARS) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    for (const key of API_KEY_ENV_VARS) {
      const value = envBackup[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('reuses cached result across turns and works without API key on cache hit', async () => {
    const projectPath = await createTempDir('yolo-literature-cache-')
    tempDirs.push(projectPath)

    mocks.researchMock.mockResolvedValueOnce({
      success: true,
      result: {
        data: {
          briefSummary: 'Prior work found for orchestration latency.',
          coverage: {
            score: 0.8,
            subTopics: [],
            queriesExecuted: ['agent orchestration latency']
          },
          totalPapersFound: 7,
          papersAutoSaved: 3,
          fullReviewPath: '.yolo-researcher/reviews/review-1.md',
          paperListPath: '.yolo-researcher/reviews/review-1-papers.json',
          durationMs: 1200,
          llmCallCount: 2,
          apiCallCount: 1,
          apiFailureCount: 0
        }
      }
    })

    const firstTool = createLiteratureSearchTool({
      apiKey: 'test-key',
      model: 'gpt-5-mini',
      projectPath
    })

    const first = await firstTool.execute({
      query: 'Agent orchestration latency for tool calls',
      context: 'Benchmark IPC overhead in local runtime'
    })

    expect(first.success).toBe(true)
    expect(mocks.createLiteratureTeamMock).toHaveBeenCalledTimes(1)

    const secondTool = createLiteratureSearchTool({
      model: 'gpt-5-mini',
      projectPath
    })

    const second = await secondTool.execute({
      query: 'agent orchestration latency for tool calls',
      context: 'benchmark ipc overhead in local runtime'
    })

    expect(second.success).toBe(true)
    expect(second.data?.briefSummary).toContain('orchestration latency')
    expect(second.data?.persistedPapersPath).toBe(PATHS.papers)
    expect(mocks.createLiteratureTeamMock).toHaveBeenCalledTimes(1)

    const cachePath = join(projectPath, PATHS.reviews, 'literature-search-cache.v1.json')
    const cacheRaw = await readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(cacheRaw) as { entries?: Record<string, unknown> }
    expect(Object.keys(parsed.entries ?? {})).toHaveLength(1)
  })

  it('returns a clear error when no API key and no cache are available', async () => {
    const projectPath = await createTempDir('yolo-literature-cache-miss-')
    tempDirs.push(projectPath)

    const tool = createLiteratureSearchTool({
      model: 'gpt-5-mini',
      projectPath
    })

    const result = await tool.execute({
      query: 'novel topic with no cached result'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('no reusable cached literature result')
    expect(mocks.createLiteratureTeamMock).toHaveBeenCalledTimes(0)
  })
})
