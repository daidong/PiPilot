/**
 * TraceCollector - Event trace collector with correlation support
 */

import { mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { FRAMEWORK_DIR } from '../constants.js'
import type { TraceEvent, TraceEventType, TraceFilter, EventCorrelation } from '../types/trace.js'
import type { UsageSummary } from '../llm/provider.types.js'
import { updateUsageTotals } from './usage-totals.js'

/**
 * Generate unique ID
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Configuration for TraceCollector
 */
export interface TraceCollectorConfig {
  sessionId: string
  runId?: string
  agentId?: string
  export?: {
    enabled?: boolean
    dir?: string
    writeJsonl?: boolean
    writeSummary?: boolean
  }
}

/**
 * Trace collector with event correlation support
 */
export class TraceCollector {
  private events: TraceEvent[] = []
  private sessionId: string
  private runId: string
  private agentId: string
  private currentStep = 0
  private currentTraceId: string | null = null
  private eventStack: string[] = []
  private exportConfig: {
    enabled: boolean
    dir?: string
    writeJsonl: boolean
    writeSummary: boolean
  }
  private runStartedAt: number | null = null
  private runOutcome: { success?: boolean; error?: string; steps?: number; durationMs?: number } | null = null
  private usageSummary: UsageSummary | undefined

  constructor(config: string | TraceCollectorConfig) {
    if (typeof config === 'string') {
      // Legacy support: just session ID
      this.sessionId = config
      this.runId = generateId()
      this.agentId = 'default'
      this.exportConfig = { enabled: false, writeJsonl: true, writeSummary: true }
    } else {
      this.sessionId = config.sessionId
      this.runId = config.runId ?? generateId()
      this.agentId = config.agentId ?? 'default'
      this.exportConfig = {
        enabled: config.export?.enabled ?? false,
        dir: config.export?.dir,
        writeJsonl: config.export?.writeJsonl ?? true,
        writeSummary: config.export?.writeSummary ?? true
      }
    }
  }

  /**
   * Get current correlation context
   */
  getCorrelation(): EventCorrelation {
    return {
      runId: this.runId,
      stepId: this.currentStep,
      agentId: this.agentId,
      sessionId: this.sessionId
    }
  }

  /**
   * Set run ID
   */
  setRunId(runId: string): void {
    this.runId = runId
  }

  /**
   * Start a new run (resets in-memory events for this run)
   */
  startRun(runId?: string, startedAt?: number): void {
    this.clear()
    this.runId = runId ?? generateId()
    this.currentStep = 0
    this.runStartedAt = startedAt ?? Date.now()
    this.runOutcome = null
    this.usageSummary = undefined
  }

  /**
   * Set agent ID
   */
  setAgentId(agentId: string): void {
    this.agentId = agentId
  }

  /**
   * 获取当前 trace ID
   */
  get currentId(): string {
    return this.currentTraceId ?? generateId()
  }

  /**
   * 设置当前步骤
   */
  setStep(step: number): void {
    this.currentStep = step
  }

  /**
   * Store run outcome data for summary export
   */
  setRunOutcome(outcome: { success?: boolean; error?: string; steps?: number; durationMs?: number }): void {
    this.runOutcome = { ...this.runOutcome, ...outcome }
  }

  /**
   * Store token usage summary for export
   */
  setUsageSummary(summary?: UsageSummary): void {
    this.usageSummary = summary
  }

  /**
   * Record an event with correlation fields
   */
  record(event: {
    type: TraceEventType
    data?: Record<string, unknown>
    parentId?: string
  }): string {
    const id = generateId()
    this.currentTraceId = id

    const traceEvent: TraceEvent = {
      id,
      type: event.type,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      step: this.currentStep,
      data: event.data ?? {},
      parentId: event.parentId ?? this.eventStack[this.eventStack.length - 1],
      runId: this.runId,
      agentId: this.agentId
    }

    this.events.push(traceEvent)
    return id
  }

  /**
   * 开始一个事件范围（用于测量持续时间）
   */
  startSpan(type: TraceEventType, data?: Record<string, unknown>): string {
    const id = this.record({ type, data })
    this.eventStack.push(id)
    return id
  }

  /**
   * 结束一个事件范围
   */
  endSpan(spanId: string, additionalData?: Record<string, unknown>): void {
    const event = this.events.find(e => e.id === spanId)
    if (event) {
      event.durationMs = Date.now() - event.timestamp
      if (additionalData) {
        event.data = { ...event.data, ...additionalData }
      }
    }

    const stackIndex = this.eventStack.indexOf(spanId)
    if (stackIndex !== -1) {
      this.eventStack.splice(stackIndex, 1)
    }
  }

  /**
   * 获取所有事件
   */
  getEvents(): TraceEvent[] {
    return [...this.events]
  }

  /**
   * Filter events by criteria
   */
  filter(filter: TraceFilter): TraceEvent[] {
    return this.events.filter(event => {
      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type]
        if (!types.includes(event.type)) {
          return false
        }
      }

      if (filter.minTimestamp && event.timestamp < filter.minTimestamp) {
        return false
      }

      if (filter.maxTimestamp && event.timestamp > filter.maxTimestamp) {
        return false
      }

      if (filter.step !== undefined && event.step !== filter.step) {
        return false
      }

      if (filter.runId && event.runId !== filter.runId) {
        return false
      }

      if (filter.agentId && event.agentId !== filter.agentId) {
        return false
      }

      return true
    })
  }

  /**
   * 按类型分组事件
   */
  groupByType(): Map<TraceEventType, TraceEvent[]> {
    const groups = new Map<TraceEventType, TraceEvent[]>()

    for (const event of this.events) {
      if (!groups.has(event.type)) {
        groups.set(event.type, [])
      }
      groups.get(event.type)!.push(event)
    }

    return groups
  }

  /**
   * 获取指定步骤的事件
   */
  getStepEvents(step: number): TraceEvent[] {
    return this.events.filter(e => e.step === step)
  }

  /**
   * 获取事件统计
   */
  getStats(): {
    totalEvents: number
    byType: Record<string, number>
    totalDurationMs: number
    steps: number
  } {
    const byType: Record<string, number> = {}
    let totalDurationMs = 0
    let maxStep = 0

    for (const event of this.events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1
      if (event.durationMs) {
        totalDurationMs += event.durationMs
      }
      if (event.step > maxStep) {
        maxStep = event.step
      }
    }

    return {
      totalEvents: this.events.length,
      byType,
      totalDurationMs,
      steps: maxStep + 1
    }
  }

  /**
   * 清空事件
   */
  clear(): void {
    this.events = []
    this.eventStack = []
    this.currentTraceId = null
  }

  /**
   * Export trace events and summary to disk (JSONL + summary JSON)
   */
  flush(): void {
    if (!this.exportConfig.enabled) return

    try {
      const dir = this.exportConfig.dir ?? join(process.cwd(), FRAMEWORK_DIR, 'traces')
      mkdirSync(dir, { recursive: true })

      if (this.exportConfig.writeJsonl) {
        const jsonl = this.events.map(e => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : '')
        const tracePath = join(dir, `trace-${this.runId}.jsonl`)
        writeFileSync(tracePath, jsonl, 'utf-8')
      }

      if (this.exportConfig.writeSummary) {
        const stats = this.getStats()
        const summary = {
          runId: this.runId,
          sessionId: this.sessionId,
          agentId: this.agentId,
          startedAt: this.runStartedAt ? new Date(this.runStartedAt).toISOString() : undefined,
          durationMs: this.runOutcome?.durationMs ?? (this.runStartedAt ? Date.now() - this.runStartedAt : undefined),
          success: this.runOutcome?.success,
          error: this.runOutcome?.error,
          steps: this.runOutcome?.steps ?? stats.steps,
          totalEvents: stats.totalEvents,
          byType: stats.byType,
          usage: this.usageSummary
        }
        const summaryPath = join(dir, `trace-${this.runId}.summary.json`)
        writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
      }

      if (this.usageSummary) {
        const baseDir = basename(dir) === 'traces' ? dirname(dir) : dir
        updateUsageTotals(baseDir, this.runId, this.usageSummary)
      }
    } catch (error) {
      // Do not fail agent execution if tracing export fails
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[TraceCollector] Failed to export traces:', message)
    }
  }

  /**
   * 导出为 JSON
   */
  toJSON(): string {
    return JSON.stringify(this.events, null, 2)
  }

  /**
   * 从 JSON 导入
   */
  static fromJSON(json: string, sessionId?: string): TraceCollector {
    const events = JSON.parse(json) as TraceEvent[]
    const collector = new TraceCollector(sessionId ?? events[0]?.sessionId ?? generateId())
    collector.events = events
    return collector
  }
}
