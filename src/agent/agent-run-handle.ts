/**
 * AgentRunHandle — returned by Agent.run()
 *
 * Implements PromiseLike<AgentRunResult> so `await agent.run(...)` still works.
 * Also exposes steer() and followUp() for mid-run control.
 */

import type { AgentLoop } from './agent-loop.js'
import type { AgentRunResult } from '../types/agent.js'
import type { Message } from '../llm/index.js'

/**
 * Handle returned by `agent.run()`.
 *
 * Backwards compatible: `await agent.run(prompt)` continues to work unchanged.
 *
 * New capabilities:
 * - `steer(message)` — inject a message before the next LLM call (mid-run redirect)
 * - `followUp(message)` — queue a message that runs after the current task completes
 * - Both return `this` so calls can be chained
 *
 * @example
 * // Backward compatible
 * const result = await agent.run('Research quantum computing')
 *
 * @example
 * // Mid-run steering (call at any time, even while agent is working)
 * const handle = agent.run('Analyze this codebase')
 * setTimeout(() => handle.steer('Prioritize security issues'), 3000)
 * const result = await handle
 *
 * @example
 * // Agentic pipeline via follow-ups (chained before run starts)
 * const result = await agent
 *   .run('Research quantum computing')
 *   .followUp('Write an executive summary')
 *   .followUp('Translate the summary to Chinese')
 */
export class AgentRunHandle implements PromiseLike<AgentRunResult> {
  private readonly _promise: Promise<AgentRunResult>
  private _loop: AgentLoop | null = null
  private _steeringBuffer: string[] = []
  private _followUpBuffer: string[] = []
  private _pinBuffer: Message[] = []

  /**
   * @param executor - async function that performs the run. Receives an attachLoop
   *   callback to call once the AgentLoop instance is created.
   */
  constructor(
    executor: (attachLoop: (loop: AgentLoop) => void) => Promise<AgentRunResult>
  ) {
    this._promise = executor((loop) => this._attach(loop))
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
