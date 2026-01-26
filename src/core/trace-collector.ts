/**
 * TraceCollector - Event trace collector with correlation support
 */

import type { TraceEvent, TraceEventType, TraceFilter, EventCorrelation } from '../types/trace.js'

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

  constructor(config: string | TraceCollectorConfig) {
    if (typeof config === 'string') {
      // Legacy support: just session ID
      this.sessionId = config
      this.runId = generateId()
      this.agentId = 'default'
    } else {
      this.sessionId = config.sessionId
      this.runId = config.runId ?? generateId()
      this.agentId = config.agentId ?? 'default'
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
