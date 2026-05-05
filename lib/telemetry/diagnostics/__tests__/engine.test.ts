/**
 * Tests for the diagnostic engine + built-in rules (P3).
 *
 * Each test builds a synthetic LiveSpanSummary[] and asserts the rule fires
 * (or doesn't) under specific conditions. No filesystem I/O — engine is a
 * pure function over span arrays.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDiagnostics, buildBaseline, quantile } from '../engine.js'
import {
  BUILTIN_RULES,
  prefillExplosionRule,
  slowToolTailRule,
  repeatedWorkRule,
  sequentialDependencyRule,
  cacheMissRule
} from '../rules.js'
import type { LiveSpanSummary } from '../../live-processor.js'

function chatSpan(opts: {
  spanId: string
  parent?: string
  startMs: number
  durMs?: number
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
}): LiveSpanSummary {
  const start = new Date(opts.startMs).toISOString()
  const dur = opts.durMs ?? 100
  return {
    traceId: 'a'.repeat(32),
    spanId: opts.spanId,
    parentSpanId: opts.parent,
    name: `chat ${opts.model}`,
    kind: 3,
    startTime: start,
    endTime: new Date(opts.startMs + dur).toISOString(),
    durationMs: dur,
    statusCode: 0,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': opts.model,
      'gen_ai.usage.input_tokens': opts.inputTokens ?? 0,
      'gen_ai.usage.output_tokens': opts.outputTokens ?? 0,
      'gen_ai.usage.cache_read.input_tokens': opts.cacheRead ?? 0
    },
    events: []
  }
}

function toolSpan(opts: {
  spanId: string
  parent?: string
  startMs: number
  durMs: number
  toolName: string
  category: string
  events?: string[]
}): LiveSpanSummary {
  return {
    traceId: 'a'.repeat(32),
    spanId: opts.spanId,
    parentSpanId: opts.parent,
    name: `execute_tool ${opts.toolName}`,
    kind: 1,
    startTime: new Date(opts.startMs).toISOString(),
    endTime: new Date(opts.startMs + opts.durMs).toISOString(),
    durationMs: opts.durMs,
    statusCode: 0,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': opts.toolName,
      'pipilot.tool.category': opts.category
    },
    events: (opts.events ?? []).map((n) => ({ name: n, timestamp: new Date(opts.startMs).toISOString() }))
  }
}

// ─── engine ──────────────────────────────────────────────────────────────

test('runDiagnostics: rules execute and produce findings', () => {
  const spans = [chatSpan({ spanId: 's1', startMs: 1000, model: 'claude-opus-4-7', inputTokens: 600_000 })]
  const findings = runDiagnostics(spans, BUILTIN_RULES, { traceId: 'a'.repeat(32) })
  assert.ok(findings.some((f) => f.ruleId === 'prefill_explosion'))
})

test('runDiagnostics: rule throw is converted to engine.rule_failed finding', () => {
  const spans = [chatSpan({ spanId: 's1', startMs: 1, model: 'm' })]
  const findings = runDiagnostics(
    spans,
    [
      {
        id: 'broken_rule',
        description: 'always throws',
        rule: () => {
          throw new Error('intentional failure')
        }
      }
    ],
    { traceId: 'a'.repeat(32) }
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, 'engine.rule_failed')
  assert.equal(findings[0].severity, 'error')
  assert.match(findings[0].summary, /intentional failure/)
})

test('quantile: linear interpolation', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  // Floating-point: 95.5 from linear interp but evaluates to 95.4999… in IEEE 754.
  assert.ok(Math.abs(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95) - 95.5) < 1e-9)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})

test('buildBaseline: aggregates p95 and median per tool category', () => {
  const spans: LiveSpanSummary[] = [
    toolSpan({ spanId: 't1', startMs: 1, durMs: 100, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't2', startMs: 2, durMs: 200, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't3', startMs: 3, durMs: 300, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't4', startMs: 4, durMs: 5000, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't5', startMs: 5, durMs: 50, toolName: 'literature_search', category: 'literature' })
  ]
  const baseline = buildBaseline(spans)
  assert.ok(baseline.toolCategoryDurationMedian.web > 0)
  assert.ok(baseline.toolCategoryDurationP95.web >= baseline.toolCategoryDurationMedian.web)
  assert.equal(baseline.toolCategoryDurationP95.literature, 50)
})

// ─── prefill_explosion ──────────────────────────────────────────────────

test('prefill_explosion: fires on >50% of context window', () => {
  const spans = [chatSpan({ spanId: 's1', startMs: 1, model: 'claude-opus-4-6', inputTokens: 150_000 })]
  const findings = prefillExplosionRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, 'prefill_explosion')
  assert.match(findings[0].summary, /75%/)
})

test('prefill_explosion: does NOT fire below threshold', () => {
  const spans = [chatSpan({ spanId: 's1', startMs: 1, model: 'claude-opus-4-6', inputTokens: 50_000 })]
  const findings = prefillExplosionRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 0)
})

test('prefill_explosion.growth: fires on >2× turn-over-turn growth', () => {
  const spans = [
    chatSpan({ spanId: 's1', startMs: 1000, model: 'm', inputTokens: 5_000 }),
    chatSpan({ spanId: 's2', startMs: 2000, model: 'm', inputTokens: 12_000 })
  ]
  const findings = prefillExplosionRule.rule(spans, { traceId: 'a'.repeat(32) })
  const growth = findings.find((f) => f.ruleId === 'prefill_explosion.growth')
  assert.ok(growth)
  assert.deepEqual(growth!.spanIds, ['s1', 's2'])
})

test('prefill_explosion: ignores unknown models (no false positives)', () => {
  const spans = [chatSpan({ spanId: 's1', startMs: 1, model: 'totally-unknown', inputTokens: 999_999 })]
  const findings = prefillExplosionRule.rule(spans, { traceId: 'a'.repeat(32) })
  // No fraction-based finding since window is unknown. Growth-based fires on
  // turn-over-turn change, which needs ≥2 calls — single call → no finding.
  assert.equal(findings.length, 0)
})

// ─── slow_tool_tail ─────────────────────────────────────────────────────

test('slow_tool_tail: fires when duration > p95 baseline', () => {
  const spans = [toolSpan({ spanId: 't1', startMs: 1, durMs: 6000, toolName: 'web_search', category: 'web' })]
  const baseline = {
    toolCategoryDurationP95: { web: 2000 },
    toolCategoryDurationMedian: { web: 500 }
  }
  const findings = slowToolTailRule.rule(spans, { traceId: 'a'.repeat(32), baseline })
  assert.equal(findings.length, 1)
  assert.match(findings[0].summary, /6000ms/)
})

test('slow_tool_tail: in-trace fallback when no baseline', () => {
  const spans = [
    toolSpan({ spanId: 't1', startMs: 0, durMs: 100, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't2', startMs: 100, durMs: 100, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't3', startMs: 200, durMs: 200, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't4', startMs: 400, durMs: 8000, toolName: 'web_search', category: 'web' })
  ]
  const findings = slowToolTailRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].spanIds[0], 't4')
})

// ─── repeated_work ──────────────────────────────────────────────────────

test('repeated_work: fires when same tool called 3+ times with same signature', () => {
  const spans = [
    toolSpan({ spanId: 't1', startMs: 0, durMs: 50, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't2', startMs: 100, durMs: 50, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't3', startMs: 200, durMs: 50, toolName: 'web_search', category: 'web' })
  ]
  const findings = repeatedWorkRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].spanIds.length, 3)
})

test('repeated_work: does NOT fire on different tool names', () => {
  const spans = [
    toolSpan({ spanId: 't1', startMs: 0, durMs: 50, toolName: 'web_search', category: 'web' }),
    toolSpan({ spanId: 't2', startMs: 100, durMs: 50, toolName: 'web_fetch', category: 'web' }),
    toolSpan({ spanId: 't3', startMs: 200, durMs: 50, toolName: 'literature_search', category: 'literature' })
  ]
  const findings = repeatedWorkRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 0)
})

// ─── sequential_dependency ──────────────────────────────────────────────

test('sequential_dependency: fires when sibling tools run serially', () => {
  const parent = 'p1'
  const spans = [
    toolSpan({ spanId: 't1', parent, startMs: 0, durMs: 200, toolName: 'a', category: 'web' }),
    toolSpan({ spanId: 't2', parent, startMs: 300, durMs: 200, toolName: 'b', category: 'web' }),
    toolSpan({ spanId: 't3', parent, startMs: 600, durMs: 200, toolName: 'c', category: 'web' })
  ]
  const findings = sequentialDependencyRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].spanIds.length, 3)
  assert.equal(findings[0].severity, 'info')
})

test('sequential_dependency: does NOT fire when tools overlap', () => {
  const parent = 'p1'
  const spans = [
    toolSpan({ spanId: 't1', parent, startMs: 0, durMs: 500, toolName: 'a', category: 'web' }),
    toolSpan({ spanId: 't2', parent, startMs: 100, durMs: 500, toolName: 'b', category: 'web' }),
    toolSpan({ spanId: 't3', parent, startMs: 200, durMs: 500, toolName: 'c', category: 'web' })
  ]
  const findings = sequentialDependencyRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 0)
})

// ─── cache_miss ─────────────────────────────────────────────────────────

test('cache_miss: fires when chat reuses parent context with cache_read=0', () => {
  const parent = 'step-1'
  const spans = [
    chatSpan({ spanId: 'c1', parent, startMs: 1000, model: 'claude-opus-4-7', inputTokens: 5000, cacheRead: 4000 }),
    chatSpan({ spanId: 'c2', parent, startMs: 2000, model: 'claude-opus-4-7', inputTokens: 8000, cacheRead: 0 })
  ]
  const findings = cacheMissRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].spanIds[0], 'c2')
})

test('cache_miss: does NOT fire on first call in a session', () => {
  const parent = 'step-1'
  const spans = [
    chatSpan({ spanId: 'c1', parent, startMs: 1000, model: 'claude-opus-4-7', inputTokens: 5000, cacheRead: 0 })
  ]
  const findings = cacheMissRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 0)
})

test('cache_miss: does NOT fire when cache_read > 0', () => {
  const parent = 'step-1'
  const spans = [
    chatSpan({ spanId: 'c1', parent, startMs: 1000, model: 'm', inputTokens: 5000, cacheRead: 4000 }),
    chatSpan({ spanId: 'c2', parent, startMs: 2000, model: 'm', inputTokens: 6000, cacheRead: 5500 })
  ]
  const findings = cacheMissRule.rule(spans, { traceId: 'a'.repeat(32) })
  assert.equal(findings.length, 0)
})
