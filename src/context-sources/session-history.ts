/**
 * session.history - 会话历史上下文源
 */

import { defineContextSource, createSuccessResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'

export interface SessionHistoryParams {
  limit?: number
  type?: 'all' | 'tool' | 'file'
}

export interface HistoryEntry {
  step: number
  type: string
  summary: string
  timestamp: number
}

export interface SessionHistoryData {
  entries: HistoryEntry[]
  totalSteps: number
  currentStep: number
}

export const sessionHistory: ContextSource<SessionHistoryParams, SessionHistoryData> = defineContextSource({
  id: 'session.history',
  kind: 'index',
  description: 'Get current session operation history. Shows tool calls, file operations, and context fetches.',
  shortDescription: 'Get session operation history',
  resourceTypes: [],
  params: [
    { name: 'limit', type: 'number', required: false, description: 'Max entries to return', default: 20 },
    { name: 'type', type: 'string', required: false, description: 'Filter by event type', default: 'all', enum: ['all', 'tool', 'file'] }
  ],
  examples: [
    { description: 'Get recent history', params: {}, resultSummary: 'Last 20 operations' },
    { description: 'Get tool calls only', params: { type: 'tool', limit: 10 }, resultSummary: 'Last 10 tool calls' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 10 * 1000
  },
  render: {
    maxTokens: 500,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<SessionHistoryData>> => {
    const startTime = Date.now()
    const limit = params?.limit ?? 20
    const filterType = params?.type ?? 'all'

    // 从 trace 获取历史
    const allEvents = runtime.trace.getEvents()

    // 过滤并转换为历史条目
    const entries: HistoryEntry[] = []

    for (const event of allEvents) {
      // 根据类型过滤
      if (filterType === 'tool' && !event.type.startsWith('tool.')) {
        continue
      }
      if (filterType === 'file' && !event.type.startsWith('io.')) {
        continue
      }

      let summary = ''

      switch (event.type) {
        case 'tool.call':
          summary = `Called tool: ${event.data.tool}`
          break
        case 'tool.result':
          summary = `Tool result: ${event.data.success ? 'success' : 'failed'}`
          break
        case 'io.readFile':
          summary = `Read file: ${event.data.path}`
          break
        case 'io.writeFile':
          summary = `Wrote file: ${event.data.path}`
          break
        case 'io.exec':
          summary = `Executed: ${String(event.data.command).slice(0, 50)}`
          break
        case 'ctx.fetch_complete':
          summary = `Fetched context: ${event.data.sourceId}`
          break
        default:
          summary = event.type
      }

      entries.push({
        step: event.step,
        type: event.type,
        summary,
        timestamp: event.timestamp
      })
    }

    // 按时间倒序，取最近的 limit 个
    const recentEntries = entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)

    // 渲染
    const lines = [
      `# Session History`,
      '',
      `Current step: ${runtime.step}`,
      '',
      ...recentEntries.map(e =>
        `- [Step ${e.step}] ${e.summary}`
      ),
      '',
      `[Showing ${recentEntries.length} of ${entries.length} events]`
    ]

    return createSuccessResult(
      {
        entries: recentEntries,
        totalSteps: runtime.step,
        currentStep: runtime.step
      },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: recentEntries.length >= entries.length,
          limitations: recentEntries.length < entries.length ? [`limit=${limit}`] : undefined
        }
      }
    )
  }
})
