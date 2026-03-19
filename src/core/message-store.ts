/**
 * MessageStore — Manages message history, pinning, and LLM call view construction.
 *
 * Extracted from AgentLoop to separate message state management from execution logic.
 * The `buildView()` method is the embryo of the "View" primitive:
 *   pin → transform → trim
 */

import type { Message } from '../llm/index.js'
import { countTokens } from '../utils/tokenizer.js'

export interface MessageStoreConfig {
  /** Context window size in tokens. Enables GAP-6 pre-call trimming when set. */
  contextWindow?: number
  /** Trim threshold as fraction of contextWindow (default 0.85) */
  preCallTrimThreshold?: number
  /** Hook to transform messages before each LLM call (GAP-9) */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>
  /** Initial pinned messages (GAP-10) */
  pinnedMessages?: Message[]
}

export class MessageStore {
  private messages: Message[] = []
  private pinned: Message[] = []
  private readonly config: MessageStoreConfig

  constructor(config: MessageStoreConfig = {}) {
    this.config = config
    if (config.pinnedMessages) {
      this.pinned = [...config.pinnedMessages]
    }
  }

  /** Append a message to history */
  append(message: Message): void {
    this.messages.push(message)
  }

  /** Append multiple messages */
  appendAll(messages: Message[]): void {
    this.messages.push(...messages)
  }

  /** Pin a message — prepended to every LLM call, never trimmed */
  pin(message: Message): void {
    this.pinned.push(message)
  }

  /** Get a snapshot of message history (mutations don't affect internal state) */
  getHistory(): Message[] {
    return [...this.messages]
  }

  /** Get a snapshot of pinned messages */
  getPinned(): Message[] {
    return [...this.pinned]
  }

  /** Number of messages in history (excludes pinned) */
  get length(): number {
    return this.messages.length
  }

  /** Replace history (used by compaction) */
  setHistory(messages: Message[]): void {
    this.messages = [...messages]
  }

  /** Clear all history (pinned messages are preserved) */
  clear(): void {
    this.messages = []
  }

  /**
   * Build the message array for an LLM call: transform → pin → trim.
   * Does NOT mutate internal history.
   */
  async buildView(): Promise<Message[]> {
    // 1. Apply transformContext (GAP-9)
    // Deep-copy messages so transformContext cannot mutate internal state
    const snapshot = this.messages.map(m => ({ ...m }))
    let view = this.config.transformContext
      ? await this.config.transformContext(snapshot)
      : snapshot

    // 2. Prepend pinned messages (GAP-10)
    if (this.pinned.length > 0) {
      view = [...this.pinned, ...view]
    }

    // 3. Token trim (GAP-6)
    if (this.config.contextWindow && view.length > 0) {
      view = this.trimToFit(view)
    }

    return view
  }

  private trimToFit(messages: Message[]): Message[] {
    const threshold = this.config.preCallTrimThreshold ?? 0.85
    const limit = Math.floor(this.config.contextWindow! * threshold)
    const estimated = countTokens(JSON.stringify(messages))

    if (estimated <= limit) return messages

    const pinnedCount = this.pinned.length
    const mutable = messages.slice(pinnedCount)

    while (mutable.length > 1) {
      const reEstimated = countTokens(
        JSON.stringify([...this.pinned, ...mutable])
      )
      if (reEstimated <= limit) break
      mutable.shift()
    }

    return [...this.pinned, ...mutable]
  }
}
