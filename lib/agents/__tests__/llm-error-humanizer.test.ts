/**
 * Tests for llm-error-humanizer — the Claude-subscription usage-limit
 * detector + friendly-message rewriter that fills the gap the Codex
 * (ChatGPT) provider already covers but the Anthropic provider does not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUsageLimitError,
  extractResetMinutes,
  humanizeLlmError,
} from '../llm-error-humanizer.js'

// Raw shape a Claude-subscription 429 surfaces as (Anthropic SDK: "<status> <body>").
const RAW_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your plan limit"}}'

// ── isUsageLimitError ───────────────────────────────────────────────

test('isUsageLimitError: detects quota/rate-limit/usage strings', () => {
  assert.equal(isUsageLimitError(RAW_429), true)
  assert.equal(isUsageLimitError('429 Too Many Requests'), true)
  assert.equal(isUsageLimitError('rate_limit_error'), true)
  assert.equal(isUsageLimitError('You have hit your usage limit'), true)
  assert.equal(isUsageLimitError('insufficient credit balance'), true)
  assert.equal(isUsageLimitError('quota exceeded'), true)
})

test('isUsageLimitError: transient server/network errors are NOT usage limits', () => {
  assert.equal(isUsageLimitError('{"error":{"type":"overloaded_error"}}'), false)
  assert.equal(isUsageLimitError('529 Overloaded'), false)
  assert.equal(isUsageLimitError('503 Service Unavailable'), false)
  assert.equal(isUsageLimitError('500 Internal Server Error'), false)
  assert.equal(isUsageLimitError('read ECONNRESET'), false)
  assert.equal(isUsageLimitError(''), false)
  assert.equal(isUsageLimitError(undefined), false)
})

// ── extractResetMinutes ─────────────────────────────────────────────

test('extractResetMinutes: already-friendly "try again in ~N min"', () => {
  assert.equal(extractResetMinutes('… Try again in ~22 min.'), 22)
})

test('extractResetMinutes: numeric retry-after seconds → minutes', () => {
  assert.equal(extractResetMinutes('retry-after: 120'), 2)
  assert.equal(extractResetMinutes('"retry-after":600'), 10)
})

test('extractResetMinutes: resets_at epoch seconds → minutes from now', () => {
  const now = 1_000_000_000_000 // fixed epoch ms
  const resetsAt = Math.floor(now / 1000) + 15 * 60 // +15 min
  assert.equal(extractResetMinutes(`"resets_at": ${resetsAt}`, now), 15)
})

test('extractResetMinutes: no hint → null', () => {
  assert.equal(extractResetMinutes(RAW_429), null)
  assert.equal(extractResetMinutes('plain error'), null)
})

// ── humanizeLlmError ────────────────────────────────────────────────

test('humanizeLlmError: rewrites Claude-subscription usage limit', () => {
  const out = humanizeLlmError(RAW_429, { authMode: 'anthropic-subscription' })
  assert.ok(out)
  assert.match(out!, /Claude subscription usage limit/i)
  assert.match(out!, /Settings → API Keys/)
})

test('humanizeLlmError: appends reset hint when present', () => {
  const out = humanizeLlmError('429 rate_limit_error retry-after: 1320', {
    authMode: 'anthropic-subscription',
  })
  assert.match(out!, /Try again in ~22 min\./)
})

test('humanizeLlmError: null for API-key mode (transient, left to retry layer)', () => {
  assert.equal(humanizeLlmError(RAW_429, { authMode: 'api-key' }), null)
})

test('humanizeLlmError: null for ChatGPT (Codex provider already humanizes)', () => {
  assert.equal(humanizeLlmError(RAW_429, { authMode: 'openai-codex' }), null)
})

test('humanizeLlmError: null for non-usage-limit errors even on subscription', () => {
  assert.equal(
    humanizeLlmError('529 Overloaded', { authMode: 'anthropic-subscription' }),
    null,
  )
  assert.equal(humanizeLlmError(undefined, { authMode: 'anthropic-subscription' }), null)
})
