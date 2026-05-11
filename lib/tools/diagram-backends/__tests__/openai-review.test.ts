/**
 * Regression tests for the OpenAI diagram-review request shape.
 *
 * Why: a hardcoded `temperature: 0` (introduced 2026-04-22) was harmless on
 * gpt-4o but became fatal once the default model was bumped to gpt-5.5
 * (2026-04-27), because gpt-5-class reasoning models reject any temperature
 * other than the default. The combination produced "Unsupported value:
 * 'temperature' does not support 0.0 with this model" on every review call.
 *
 * These tests pin the request body shape so the same class of bug can't
 * re-enter silently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAIReviewProvider } from '../openai-review.js'

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = impl
  return fn().finally(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = orig
  })
}

function mkResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const VALID_REVIEW_PAYLOAD = {
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          score: 8.5,
          requestAlignment: 8,
          legibility: 9,
          blockingIssues: [],
          summary: 'Looks good.',
          verdict: 'acceptable',
        }),
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  model: 'gpt-5.5',
}

const REVIEW_REQUEST = {
  image: Buffer.from('fake-png-bytes'),
  prompt: 'a diagram',
  docType: 'grant' as const,
  diagramType: 'architecture' as const,
  iteration: 1,
  maxIterations: 3,
}

test('openai review request does NOT include a temperature field (gpt-5 incompatibility)', async () => {
  let capturedBody: Record<string, unknown> | null = null
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}'))
    return mkResponse(VALID_REVIEW_PAYLOAD)
  }

  await withMockFetch(fakeFetch, async () => {
    const provider = createOpenAIReviewProvider({ apiKey: 'sk-test' })
    await provider.review(REVIEW_REQUEST)
  })

  assert.ok(capturedBody, 'fetch should have been called')
  assert.equal(
    Object.prototype.hasOwnProperty.call(capturedBody, 'temperature'),
    false,
    `request body must not include "temperature" (gpt-5-class reasoning models reject any non-default value). Got: ${JSON.stringify(capturedBody)}`
  )
})

test('openai review request still carries model, messages, and structured response_format', async () => {
  let capturedBody: Record<string, unknown> | null = null
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}'))
    return mkResponse(VALID_REVIEW_PAYLOAD)
  }

  await withMockFetch(fakeFetch, async () => {
    const provider = createOpenAIReviewProvider({ apiKey: 'sk-test', model: 'gpt-5.5' })
    await provider.review(REVIEW_REQUEST)
  })

  assert.ok(capturedBody)
  assert.equal(capturedBody.model, 'gpt-5.5')
  assert.ok(Array.isArray(capturedBody.messages), 'messages must be an array')
  const rf = capturedBody.response_format as { type?: string; json_schema?: { strict?: boolean } }
  assert.equal(rf?.type, 'json_schema')
  assert.equal(rf?.json_schema?.strict, true, 'structured output must remain strict')
})

test('openai review surfaces the "Unsupported value: temperature" API error if it ever reappears', async () => {
  // Simulates exactly what the prod API returned on May 11 when temperature: 0
  // was still in the body. This guards the error-surfacing path so we can tell
  // an unsupported-param regression apart from a generic 4xx.
  const fakeFetch: typeof fetch = async () =>
    mkResponse(
      {
        error: {
          message:
            "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
        },
      },
      400
    )

  await withMockFetch(fakeFetch, async () => {
    const provider = createOpenAIReviewProvider({ apiKey: 'sk-test' })
    await assert.rejects(
      provider.review(REVIEW_REQUEST),
      /Unsupported value: 'temperature'/
    )
  })
})
