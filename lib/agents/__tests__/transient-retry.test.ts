/**
 * Tests for transient-retry — the app-level backoff that keeps a 529
 * "Overloaded" (or other transient LLM failure) from killing a turn.
 *
 * Uses a fake Agent that mimics pi-agent-core's contract: prompt()/
 * continue() never throw on LLM errors; they push a synthetic assistant
 * message with stopReason:'error' and resolve. The fake is scripted with
 * a queue of per-call outcomes so each test drives an exact sequence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTransientLlmError,
  computeBackoffMs,
  runAgentTurnWithRetry,
  type RetryableAgent,
} from '../transient-retry.js'

type Outcome =
  | { kind: 'ok'; text?: string }
  | { kind: 'error'; message: string }

interface FakeAgent extends RetryableAgent {
  promptCalls: number
  continueCalls: number
  inputs: string[]
}

function makeFakeAgent(outcomes: Outcome[]): FakeAgent {
  const messages: RetryableAgent['state']['messages'] = []
  let i = 0
  const apply = () => {
    const outcome = outcomes[i++] ?? { kind: 'ok' as const }
    if (outcome.kind === 'ok') {
      messages.push({ role: 'assistant', stopReason: 'stop' })
    } else {
      messages.push({ role: 'assistant', stopReason: 'error', errorMessage: outcome.message })
    }
  }
  return {
    state: { messages },
    promptCalls: 0,
    continueCalls: 0,
    inputs: [],
    async prompt(input: string) {
      this.promptCalls++
      this.inputs.push(input)
      // pi pushes the user message before running the loop.
      messages.push({ role: 'user' })
      apply()
    },
    async continue() {
      this.continueCalls++
      apply()
    },
  }
}

const noSleep = async () => {}
const OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

// ── classifier ──────────────────────────────────────────────────────

test('isTransientLlmError: overloaded / 529 / rate-limit / 5xx / network', () => {
  assert.equal(isTransientLlmError(OVERLOADED), true)
  assert.equal(isTransientLlmError('Error 529 Overloaded'), true)
  assert.equal(isTransientLlmError('429 Too Many Requests'), true)
  assert.equal(isTransientLlmError('rate_limit_error'), true)
  assert.equal(isTransientLlmError('503 Service Unavailable'), true)
  assert.equal(isTransientLlmError('500 Internal Server Error'), true)
  assert.equal(isTransientLlmError('socket hang up'), true)
  assert.equal(isTransientLlmError('read ECONNRESET'), true)
})

test('isTransientLlmError: auth / bad-request / context are NOT transient', () => {
  assert.equal(isTransientLlmError('401 invalid x-api-key'), false)
  assert.equal(isTransientLlmError('403 permission denied'), false)
  assert.equal(isTransientLlmError('400 invalid request'), false)
  assert.equal(isTransientLlmError('prompt is too long: 250000 tokens'), false)
  assert.equal(isTransientLlmError(''), false)
})

test('isTransientLlmError: hard exclusion wins over a transient-looking token', () => {
  // Contains "overloaded" but also a 401 auth signal — must not retry.
  assert.equal(isTransientLlmError('401 unauthorized (server was overloaded earlier)'), false)
})

// ── backoff ─────────────────────────────────────────────────────────

test('computeBackoffMs: exponential growth with equal jitter, capped', () => {
  // random()=0 → lower bound exp/2; random()=1 → upper bound exp.
  assert.equal(computeBackoffMs(1, 2000, 30000, () => 0), 1000)
  assert.equal(computeBackoffMs(1, 2000, 30000, () => 1), 2000)
  assert.equal(computeBackoffMs(2, 2000, 30000, () => 0), 2000) // exp=4000 → /2
  assert.equal(computeBackoffMs(3, 2000, 30000, () => 1), 8000) // exp=8000
  // capped: attempt 6 → exp would be 64000, capped at 30000.
  assert.equal(computeBackoffMs(6, 2000, 30000, () => 1), 30000)
})

// ── retry loop ──────────────────────────────────────────────────────

test('succeeds on first attempt — no retry, no continue', async () => {
  const agent = makeFakeAgent([{ kind: 'ok' }])
  await runAgentTurnWithRetry(agent, 'hello', undefined, { sleep: noSleep })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 0)
})

test('retries a transient error then succeeds via continue()', async () => {
  const agent = makeFakeAgent([
    { kind: 'error', message: OVERLOADED },
    { kind: 'ok', text: 'recovered' },
  ])
  const retries: number[] = []
  await runAgentTurnWithRetry(agent, 'do work', undefined, {
    sleep: noSleep,
    onRetry: ({ attempt }) => retries.push(attempt),
  })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 1)
  assert.deepEqual(retries, [1])
  // Final transcript: the error placeholder was popped, last is success.
  const last = agent.state.messages[agent.state.messages.length - 1]
  assert.equal(last.stopReason, 'stop')
  // The user message must appear exactly once (continue() re-uses it).
  assert.equal(agent.state.messages.filter((m) => m.role === 'user').length, 1)
})

test('does NOT retry a non-transient error; leaves it for the caller', async () => {
  const agent = makeFakeAgent([{ kind: 'error', message: '401 invalid x-api-key' }])
  await runAgentTurnWithRetry(agent, 'x', undefined, { sleep: noSleep })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 0)
  const last = agent.state.messages[agent.state.messages.length - 1]
  assert.equal(last.stopReason, 'error')
  assert.match(last.errorMessage ?? '', /invalid x-api-key/)
})

test('gives up after maxAttempts, leaving the last error in place', async () => {
  const agent = makeFakeAgent([
    { kind: 'error', message: OVERLOADED },
    { kind: 'error', message: OVERLOADED },
    { kind: 'error', message: OVERLOADED },
  ])
  await runAgentTurnWithRetry(agent, 'x', undefined, { sleep: noSleep, maxAttempts: 3 })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 2) // attempts 2 and 3
  const last = agent.state.messages[agent.state.messages.length - 1]
  assert.equal(last.stopReason, 'error') // surfaced, not silently dropped
})

test('abort during backoff stops retrying and keeps the error placeholder', async () => {
  const agent = makeFakeAgent([
    { kind: 'error', message: OVERLOADED },
    { kind: 'ok' }, // would succeed, but we abort before continue()
  ])
  let aborted = false
  await runAgentTurnWithRetry(agent, 'x', undefined, {
    // Simulate the user pressing Stop while we wait.
    sleep: async () => { aborted = true },
    isAborted: () => aborted,
  })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 0)
  const last = agent.state.messages[agent.state.messages.length - 1]
  assert.equal(last.stopReason, 'error')
})

test('user-aborted turn (stopReason aborted) returns immediately', async () => {
  const agent: FakeAgent = makeFakeAgent([])
  // Script a single prompt that ends aborted.
  agent.prompt = async function (input: string) {
    this.promptCalls++
    this.inputs.push(input)
    this.state.messages.push({ role: 'user' })
    this.state.messages.push({ role: 'assistant', stopReason: 'aborted' })
  }
  await runAgentTurnWithRetry(agent, 'x', undefined, { sleep: noSleep })
  assert.equal(agent.promptCalls, 1)
  assert.equal(agent.continueCalls, 0)
})
