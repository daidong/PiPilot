import type { AskUserRequest, QueuedUserInput } from './types.js'
import { nowIso, randomId } from './utils.js'

export class CheckpointBroker {
  private queue: QueuedUserInput[] = []
  private pendingQuestion: AskUserRequest | undefined

  enqueueInput(text: string, priority: 'urgent' | 'normal' = 'normal', source: 'chat' | 'system' = 'chat'): QueuedUserInput {
    const item: QueuedUserInput = {
      id: randomId('in'),
      text,
      priority,
      createdAt: nowIso(),
      source
    }
    this.queue.push(item)
    return item
  }

  drainAtTurnBoundary(): QueuedUserInput[] {
    if (this.queue.length === 0) return []

    const urgent = this.queue.filter((item) => item.priority === 'urgent')
    const normal = this.queue.filter((item) => item.priority === 'normal')
    const merged = [...urgent, ...normal]
    this.queue = []
    return merged
  }

  getQueueSnapshot(): QueuedUserInput[] {
    return [...this.queue]
  }

  removeQueuedInput(id: string): QueuedUserInput | null {
    const index = this.queue.findIndex((item) => item.id === id)
    if (index === -1) return null
    const [removed] = this.queue.splice(index, 1)
    return removed
  }

  updateQueuedInputPriority(id: string, priority: QueuedUserInput['priority']): QueuedUserInput | null {
    const item = this.queue.find((candidate) => candidate.id === id)
    if (!item) return null
    item.priority = priority
    return { ...item }
  }

  moveQueuedInput(id: string, toIndex: number): QueuedUserInput[] {
    const fromIndex = this.queue.findIndex((item) => item.id === id)
    if (fromIndex === -1) {
      throw new Error(`queued input not found: ${id}`)
    }
    if (!Number.isInteger(toIndex)) {
      throw new Error(`toIndex must be an integer: ${toIndex}`)
    }

    const boundedToIndex = Math.max(0, Math.min(toIndex, this.queue.length - 1))
    if (fromIndex === boundedToIndex) return this.getQueueSnapshot()

    const [moved] = this.queue.splice(fromIndex, 1)
    this.queue.splice(boundedToIndex, 0, moved)
    return this.getQueueSnapshot()
  }

  emitQuestion(question: AskUserRequest): AskUserRequest {
    const nextQuestion: AskUserRequest = {
      ...question,
      id: question.id ?? randomId('q')
    }
    this.pendingQuestion = nextQuestion
    return nextQuestion
  }

  getPendingQuestion(): AskUserRequest | undefined {
    return this.pendingQuestion
  }

  resolvePendingQuestion(): void {
    this.pendingQuestion = undefined
  }
}
