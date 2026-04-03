/**
 * Main-process buffer that mirrors real-time UI state so the renderer
 * can recover after a remount / reload without losing in-flight data.
 */

export interface RealtimeSnapshot {
  streamingText: string
  isStreaming: boolean
  progressItems: any[]
  activityEvents: any[]
  /** Tool events for the current run (chat-inline cards) */
  toolEvents: any[]
}

export class RealtimeBuffer {
  private streamingText = ''
  private isStreaming = false
  private progressItems: any[] = []
  private activityEvents: any[] = []
  /** Tool events for chat-inline rendering (mirrors tool-events-store) */
  private toolEvents: any[] = []
  /** Track tool-call start times keyed by toolCallId for duration computation */
  private toolCallStartTimes = new Map<string, number>()

  /** Append a streaming text chunk (called from onStream callback) */
  appendChunk(chunk: string): void {
    this.streamingText += chunk
    this.isStreaming = true
  }

  /** Record a progress / todo item update */
  upsertProgressItem(item: any): void {
    const idx = this.progressItems.findIndex((i) => i.id === item.id)
    if (idx >= 0) {
      this.progressItems[idx] = item
    } else {
      this.progressItems.push(item)
    }
  }

  /** Record an activity event and track tool-call start times */
  pushActivity(event: any): void {
    if (event.type === 'tool-call' && event.toolCallId) {
      this.toolCallStartTimes.set(event.toolCallId, Date.now())
    }
    this.activityEvents.push(event)
  }

  /** Record a tool event for chat-inline rendering */
  pushToolEvent(event: any): void {
    this.toolEvents.push(event)
  }

  /** Update a tool event by toolCallId (for tool-result merge) */
  updateToolEvent(toolCallId: string, patch: any): void {
    const idx = this.toolEvents.findLastIndex((e: any) => e.toolCallId === toolCallId)
    if (idx !== -1) {
      this.toolEvents[idx] = { ...this.toolEvents[idx], ...patch }
    }
  }

  /** Clear tool events (on new run or finalize) */
  clearToolEvents(): void {
    this.toolEvents = []
  }

  /** Pop and return the start time for a tool-call, or undefined if not found */
  popToolCallStartTime(toolCallId: string): number | undefined {
    const t = this.toolCallStartTimes.get(toolCallId)
    if (t !== undefined) this.toolCallStartTimes.delete(toolCallId)
    return t
  }

  /** Clear progress and activity (called on project close or explicit reset) */
  clearRun(): void {
    this.progressItems = []
    this.activityEvents = []
    this.toolEvents = []
  }

  /** Clear only activity events (called on new agent run) */
  clearActivity(): void {
    this.activityEvents = []
    this.toolEvents = []
    this.toolCallStartTimes.clear()
  }

  /** Mark streaming finished (called on agent:done) */
  finishStreaming(): void {
    this.streamingText = ''
    this.isStreaming = false
  }

  /** Full reset (called on project close) */
  reset(): void {
    this.streamingText = ''
    this.isStreaming = false
    this.progressItems = []
    this.activityEvents = []
    this.toolEvents = []
    this.toolCallStartTimes.clear()
  }

  /** Return a snapshot the renderer can use to hydrate stores */
  getSnapshot(): RealtimeSnapshot {
    return {
      streamingText: this.streamingText,
      isStreaming: this.isStreaming,
      progressItems: [...this.progressItems],
      activityEvents: [...this.activityEvents],
      toolEvents: [...this.toolEvents],
    }
  }
}

export function createRealtimeBuffer(): RealtimeBuffer {
  return new RealtimeBuffer()
}
