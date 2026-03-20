/**
 * AgentRunHandle — returned by Agent.run()
 *
 * Implements PromiseLike<AgentRunResult> so `await agent.run(...)` still works.
 * Also exposes steer(), followUp(), and events() for mid-run control and streaming.
 */

import type { AgentLoop } from './agent-loop.js'
import type { AgentRunResult } from '../types/agent.js'
import type { AgentEvent } from '../types/agent-event.js'
import type { Message } from '../llm/index.js'
import { createChannel, type AsyncChannel } from '../utils/async-channel.js'

/**
 * Handle returned by `agent.run()`.
 *
 * Backwards compatible: `await agent.run(prompt)` continues to work unchanged.
 *
 * New capabilities:
 * - `events()` — returns an AsyncIterable of AgentEvent for streaming consumption
 * - `steer(message)` — inject a message before the next LLM call (mid-run redirect)
 * - `followUp(message)` — queue a message that runs after the current task completes
 *
 * @example
 * // Backward compatible
 * const result = await agent.run('Research quantum computing')
 *
 * @example
 * // Streaming consumption
 * for await (const event of agent.run('Analyze this codebase').events()) {
 *   if (event.type === 'text-delta') process.stdout.write(event.text)
 *   if (event.type === 'tool-call') console.log(`Calling ${event.tool}...`)
 *   if (event.type === 'done') console.log('Result:', event.result.output)
 * }
 *
 * @example
 * // Mid-run steering
 * const handle = agent.run('Analyze this codebase')
 * setTimeout(() => handle.steer('Prioritize security issues'), 3000)
 * const result = await handle
 */
export class AgentRunHandle implements PromiseLike<AgentRunResult> {
  private readonly _promise: Promise<AgentRunResult>
  private _loop: AgentLoop | null = null
  private _steeringBuffer: string[] = []
  private _followUpBuffer: string[] = []
  private _pinBuffer: Message[] = []
  /** Replay channel: events pushed by the executor are buffered here for events() */
  private _replayChannel: AsyncChannel<AgentEvent> | null = null

  /**
   * @param executor - async function that performs the run. Receives an attachLoop
   *   callback to call once the AgentLoop instance is created, and an emitEvent
   *   callback to push AgentEvents for streaming consumers.
   */
  constructor(
    executor: (
      attachLoop: (loop: AgentLoop) => void,
      emitEvent: (event: AgentEvent) => void
    ) => Promise<AgentRunResult>
  ) {
    this._promise = executor(
      (loop) => this._attach(loop),
      (event) => {
        // Lazy-create channel on first emitEvent call (avoids buffer waste
        // when events() is never used and executor never emits events).
        if (!this._replayChannel) {
          this._replayChannel = createChannel<AgentEvent>()
        }
        this._replayChannel.push(event)
      }
    ).then((result) => {
      // Close the channel if it was created. Do NOT push another 'done' —
      // the executor already emits 'done' via emitEvent from runStream().
      this._replayChannel?.done()
      return result
    }).catch((err) => {
      // On error, push a done event only if channel exists and executor
      // didn't already emit one (e.g., executor threw before streaming started).
      if (this._replayChannel) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        this._replayChannel.push({
          type: 'done',
          result: { success: false, output: '', error: errorMsg, steps: 0, trace: [], durationMs: 0 }
        })
        this._replayChannel.done()
      }
      throw err  // re-throw so the promise rejects as before
    })
  }

  private _attach(loop: AgentLoop): void {
    this._loop = loop
    // Drain any messages buffered before the loop was created
    for (const msg of this._steeringBuffer) loop.steer(msg)
    for (const msg of this._followUpBuffer) loop.followUp(msg)
    for (const msg of this._pinBuffer) loop.pin(msg)
    this._steeringBuffer = []
    this._followUpBuffer = []
    this._pinBuffer = []
  }

  /**
   * Returns an AsyncIterable of typed AgentEvents for streaming consumption.
   *
   * Events are emitted in real-time: text deltas, tool calls, tool results,
   * step boundaries, errors, and a final `done` event with the AgentRunResult.
   *
   * Can be used alongside `await handle` — both consume the same underlying run.
   * The iterable can only be consumed once.
   *
   * @example
   * ```typescript
   * const handle = agent.run(prompt)
   * for await (const event of handle.events()) {
   *   if (event.type === 'text-delta') process.stdout.write(event.text)
   *   if (event.type === 'done') break
   * }
   * ```
   */
  events(): AsyncIterable<AgentEvent> {
    if (!this._replayChannel) {
      throw new Error('events() can only be called once per AgentRunHandle')
    }
    const channel = this._replayChannel
    return channel
  }

  /**
   * Inject a steering message that will be delivered to the LLM before its
   * next call. Safe to call while the agent is running — takes effect at the
   * start of the next step.
   *
   * Returns `this` for chaining.
   */
  steer(message: string): this {
    if (this._loop) this._loop.steer(message)
    else this._steeringBuffer.push(message)
    return this
  }

  /**
   * Queue a follow-up message to be processed after the agent's current task
   * completes naturally (no more tool calls). The agent will continue with
   * this message instead of stopping.
   *
   * Multiple follow-ups are consumed one at a time, in order.
   * Returns `this` for chaining.
   */
  followUp(message: string): this {
    if (this._loop) this._loop.followUp(message)
    else this._followUpBuffer.push(message)
    return this
  }

  /**
   * Stop the current run immediately.
   */
  stop(): void {
    this._loop?.stop()
  }

  /**
   * Pin a message so it is prepended to every future LLM call.
   * Safe to call before or during a run — buffered until the loop attaches.
   * Returns `this` for chaining.
   */
  pin(message: Message): this {
    if (this._loop) this._loop.pin(message)
    else this._pinBuffer.push(message)
    return this
  }

  /**
   * Get the underlying Promise for the final result.
   */
  result(): Promise<AgentRunResult> {
    return this._promise
  }

  // ── PromiseLike implementation ────────────────────────────────────────────

  then<T, U = never>(
    onFulfilled?: ((value: AgentRunResult) => T | PromiseLike<T>) | null,
    onRejected?: ((reason: unknown) => U | PromiseLike<U>) | null
  ): Promise<T | U> {
    return this._promise.then(onFulfilled, onRejected) as Promise<T | U>
  }

  catch<U = never>(
    onRejected?: ((reason: unknown) => U | PromiseLike<U>) | null
  ): Promise<AgentRunResult | U> {
    return this._promise.catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<AgentRunResult> {
    return this._promise.finally(onFinally)
  }
}
