/**
 * Main-process buffer that mirrors real-time UI state so the renderer
 * can recover after a remount / reload without losing in-flight data.
 */

export interface RealtimeSnapshot {
  streamingText: string
  isStreaming: boolean
  progressItems: any[]
  activityEvents: any[]
}

class RealtimeBuffer {
  private streamingText = ''
  private isStreaming = false
  private progressItems: any[] = []
  private activityEvents: any[] = []

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

  /** Record an activity event */
  pushActivity(event: any): void {
    this.activityEvents.push(event)
  }

  /** Clear progress and activity (called on project close or explicit reset) */
  clearRun(): void {
    this.progressItems = []
    this.activityEvents = []
  }

  /** Clear only activity events (called on new agent run) */
  clearActivity(): void {
    this.activityEvents = []
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
  }

  /** Return a snapshot the renderer can use to hydrate stores */
  getSnapshot(): RealtimeSnapshot {
    return {
      streamingText: this.streamingText,
      isStreaming: this.isStreaming,
      progressItems: [...this.progressItems],
      activityEvents: [...this.activityEvents],
    }
  }
}

export const realtimeBuffer = new RealtimeBuffer()
