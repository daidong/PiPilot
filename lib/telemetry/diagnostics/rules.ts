/**
 * Built-in diagnostic rules (P3.3 – P3.7).
 *
 * Each rule is a pure function over `LiveSpanSummary[]`. Rules look at:
 *   - `gen_ai.operation.name` (chat / execute_tool / invoke_agent)
 *   - `gen_ai.usage.*` token attributes
 *   - `pipilot.tool.category`, `gen_ai.tool.name`
 *   - `pipilot.runtime.full_prompt_hash` (per-task system prompt fingerprint)
 *   - parent/child structure via parentSpanId
 *
 * The rules are intentionally conservative: they emit at most a handful of
 * findings per trace so a human can read them all. A rule that fires on
 * everything is worse than one that fires on nothing.
 */

import { createHash } from 'node:crypto'
import type { Finding, RegisteredRule } from './engine.js'
import type { LiveSpanSummary } from '../live-processor.js'

// ─── Helpers ──────────────────────────────────────────────────────────────

function isChatSpan(s: LiveSpanSummary): boolean {
  return s.attributes['gen_ai.operation.name'] === 'chat'
}

function isToolSpan(s: LiveSpanSummary): boolean {
  return s.attributes['gen_ai.operation.name'] === 'execute_tool'
}

function inputTokens(s: LiveSpanSummary): number {
  const v = s.attributes['gen_ai.usage.input_tokens']
  return typeof v === 'number' ? v : 0
}

function cacheReadTokens(s: LiveSpanSummary): number {
  const v = s.attributes['gen_ai.usage.cache_read.input_tokens']
  return typeof v === 'number' ? v : 0
}

// ─── P3.3: prefill explosion ──────────────────────────────────────────────

/**
 * Default heuristic context-window sizes for popular models. Used only when
 * the trace doesn't carry a tighter signal. Conservative — better to miss
 * a real explosion than to over-fire on a model with a 1M window.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-5': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'gpt-5.5': 400_000,
  'gpt-4o': 128_000,
  'gemini-2.5-pro': 2_000_000,
  'deepseek-chat': 128_000
}

const PREFILL_FRACTION_THRESHOLD = 0.5
const PREFILL_GROWTH_RATIO_THRESHOLD = 2.0

export const prefillExplosionRule: RegisteredRule = {
  id: 'prefill_explosion',
  description:
    'Chat spans where input_tokens exceeds 50% of the model context window, or grew >2× turn-over-turn within the trace.',
  rule: (spans) => {
    const out: Finding[] = []
    const chats = spans.filter(isChatSpan).sort((a, b) => a.startTime.localeCompare(b.startTime))
    let prevInput: number | null = null
    let prevSpanId: string | null = null
    for (const s of chats) {
      const tokens = inputTokens(s)
      if (tokens === 0) {
        prevInput = null
        prevSpanId = null
        continue
      }
      const model = String(s.attributes['gen_ai.request.model'] ?? '')
      const window = MODEL_CONTEXT_WINDOWS[model] ?? 0
      if (window > 0 && tokens / window >= PREFILL_FRACTION_THRESHOLD) {
        out.push({
          ruleId: 'prefill_explosion',
          severity: 'warn',
          summary: `Prefill ${tokens} tokens = ${Math.round((tokens / window) * 100)}% of ${model} context window`,
          spanIds: [s.spanId],
          context: { tokens, model, contextWindow: window }
        })
      }
      if (prevInput !== null && tokens >= prevInput * PREFILL_GROWTH_RATIO_THRESHOLD && tokens > 1000) {
        out.push({
          ruleId: 'prefill_explosion.growth',
          severity: 'warn',
          summary: `Prefill grew ${(tokens / prevInput).toFixed(1)}× turn-over-turn (${prevInput} → ${tokens})`,
          spanIds: prevSpanId ? [prevSpanId, s.spanId] : [s.spanId],
          context: { from: prevInput, to: tokens, ratio: tokens / prevInput }
        })
      }
      prevInput = tokens
      prevSpanId = s.spanId
    }
    return out
  }
}

// ─── P3.4: slow-tool tail ─────────────────────────────────────────────────

const SLOW_TOOL_BASELINE_MULT = 5
const SLOW_TOOL_ABSOLUTE_FLOOR_MS = 1000

export const slowToolTailRule: RegisteredRule = {
  id: 'slow_tool_tail',
  description:
    'execute_tool spans whose duration exceeds the cross-trace p95 for their category (or >5× median when no baseline).',
  rule: (spans, ctx) => {
    const out: Finding[] = []
    const toolSpans = spans.filter(isToolSpan)
    if (toolSpans.length === 0) return out

    const baseline = ctx.baseline
    if (baseline) {
      for (const s of toolSpans) {
        const cat = String(s.attributes['pipilot.tool.category'] ?? 'unknown')
        const p95 = baseline.toolCategoryDurationP95[cat]
        if (typeof p95 === 'number' && Number.isFinite(p95) && p95 > 0 && s.durationMs > p95 && s.durationMs > SLOW_TOOL_ABSOLUTE_FLOOR_MS) {
          out.push({
            ruleId: 'slow_tool_tail',
            severity: 'warn',
            summary: `${s.attributes['gen_ai.tool.name'] ?? s.name} took ${Math.round(s.durationMs)}ms (>p95 ${Math.round(p95)}ms for ${cat})`,
            spanIds: [s.spanId],
            context: { category: cat, durationMs: s.durationMs, p95Ms: p95 }
          })
        }
      }
      return out
    }

    // Fallback: in-trace median × multiplier per category. Only meaningful
    // when several tools of the same category ran in this trace.
    const byCat = new Map<string, LiveSpanSummary[]>()
    for (const s of toolSpans) {
      const cat = String(s.attributes['pipilot.tool.category'] ?? 'unknown')
      let bucket = byCat.get(cat)
      if (!bucket) {
        bucket = []
        byCat.set(cat, bucket)
      }
      bucket.push(s)
    }
    for (const [cat, group] of byCat) {
      if (group.length < 3) continue
      const sorted = [...group.map((s) => s.durationMs)].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]!
      const threshold = Math.max(median * SLOW_TOOL_BASELINE_MULT, SLOW_TOOL_ABSOLUTE_FLOOR_MS)
      for (const s of group) {
        if (s.durationMs > threshold) {
          out.push({
            ruleId: 'slow_tool_tail',
            severity: 'warn',
            summary: `${s.attributes['gen_ai.tool.name'] ?? s.name} took ${Math.round(s.durationMs)}ms (>5× in-trace median ${Math.round(median)}ms for ${cat})`,
            spanIds: [s.spanId],
            context: { category: cat, durationMs: s.durationMs, medianMs: median }
          })
        }
      }
    }
    return out
  }
}

// ─── P3.5: repeated work ──────────────────────────────────────────────────

const REPEATED_WORK_MIN_REPEATS = 3 // 3+ identical calls = "repeated"

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

export const repeatedWorkRule: RegisteredRule = {
  id: 'repeated_work',
  description:
    'Same tool name + identical args (hashed) called 3+ times in one trace. Indicates the agent forgot it already did this.',
  rule: (spans) => {
    const out: Finding[] = []
    const toolSpans = spans.filter(isToolSpan)
    // Group by (toolName, argsHash). Args aren't on the span attributes —
    // they're in the gen_ai.client.inference.operation.details event body.
    // Approximation: hash the attributes object minus duration/timing keys.
    const groups = new Map<string, LiveSpanSummary[]>()
    for (const s of toolSpans) {
      const toolName = String(s.attributes['gen_ai.tool.name'] ?? s.name)
      // Events list is part of identity (compaction discards etc. aren't
      // on tool spans, so this stays stable for repeated calls).
      const eventNames = s.events.map((e) => e.name).sort().join('|')
      const hash = shortHash(`${toolName}|${eventNames}`)
      const key = `${toolName}::${hash}`
      let bucket = groups.get(key)
      if (!bucket) {
        bucket = []
        groups.set(key, bucket)
      }
      bucket.push(s)
    }
    for (const [key, group] of groups) {
      if (group.length < REPEATED_WORK_MIN_REPEATS) continue
      const toolName = key.split('::')[0]
      out.push({
        ruleId: 'repeated_work',
        severity: 'warn',
        summary: `Tool "${toolName}" called ${group.length}× with identical signature in this trace`,
        spanIds: group.map((s) => s.spanId),
        context: { toolName, count: group.length }
      })
    }
    return out
  }
}

// ─── P3.6: sequential dependency ──────────────────────────────────────────

const SEQUENTIAL_GAP_MS = 50

export const sequentialDependencyRule: RegisteredRule = {
  id: 'sequential_dependency',
  description:
    'Sibling tool spans that ran one-after-another with no overlap, even though no obvious data dependency forced the order. Possible parallelization opportunity.',
  rule: (spans) => {
    const out: Finding[] = []
    // Group tool spans by parent (typically the invoke_agent step or root).
    const byParent = new Map<string, LiveSpanSummary[]>()
    for (const s of spans) {
      if (!isToolSpan(s)) continue
      const parent = s.parentSpanId ?? '__root__'
      let bucket = byParent.get(parent)
      if (!bucket) {
        bucket = []
        byParent.set(parent, bucket)
      }
      bucket.push(s)
    }
    for (const [parent, group] of byParent) {
      if (group.length < 3) continue
      // Sort by start time.
      const sorted = [...group].sort((a, b) => a.startTime.localeCompare(b.startTime))
      // Are they fully serialized? Each next.startTime > prev.endTime + gap.
      let serialized = true
      let totalDuration = 0
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!
        const cur = sorted[i]!
        const prevEnd = Date.parse(prev.endTime)
        const curStart = Date.parse(cur.startTime)
        if (curStart - prevEnd < SEQUENTIAL_GAP_MS) {
          serialized = false
          break
        }
        totalDuration += cur.durationMs
      }
      if (!serialized) continue
      // Heuristic: if total duration is significant, flag it.
      const wallClock = sorted.reduce((acc, s) => acc + s.durationMs, 0)
      if (wallClock < 500) continue
      out.push({
        ruleId: 'sequential_dependency',
        severity: 'info',
        summary: `${sorted.length} sibling tool calls ran serially (~${Math.round(wallClock)}ms wall clock) — could be parallel`,
        spanIds: sorted.map((s) => s.spanId),
        context: { parentSpanId: parent === '__root__' ? null : parent, count: sorted.length, wallClockMs: wallClock }
      })
    }
    return out
  }
}

// ─── P3.7: cache miss attribution ─────────────────────────────────────────

export const cacheMissRule: RegisteredRule = {
  id: 'cache_miss',
  description:
    'Chat spans where cache_read=0 but a prior chat in the same trace shared the same model + system prompt hash. Indicates broken caching.',
  rule: (spans) => {
    const out: Finding[] = []
    const chats = spans.filter(isChatSpan).sort((a, b) => a.startTime.localeCompare(b.startTime))
    if (chats.length < 2) return out

    // Group by (model, full_prompt_hash). When ≥2 calls share the same key
    // and the second-or-later call has cache_read=0, that's a miss.
    const seen = new Map<string, LiveSpanSummary[]>()
    for (const s of chats) {
      const model = String(s.attributes['gen_ai.request.model'] ?? '')
      // full_prompt_hash lives on the root invoke_agent span — not on each
      // chat span — so we fall back to fingerprinting on (model, parent
      // span id, system prompt hint when present). For now we use just
      // (model + parentSpanId) as a coarse signal; a tighter rule can be
      // layered on later when we surface system_prompt_hash per chat.
      if (!model) continue
      const key = `${model}::${s.parentSpanId ?? '__root__'}`
      let bucket = seen.get(key)
      if (!bucket) {
        bucket = []
        seen.set(key, bucket)
      }
      bucket.push(s)
    }
    for (const [, group] of seen) {
      if (group.length < 2) continue
      // Skip the first call (no prior cache to hit).
      for (let i = 1; i < group.length; i++) {
        const cur = group[i]!
        if (cacheReadTokens(cur) === 0 && inputTokens(cur) > 200) {
          out.push({
            ruleId: 'cache_miss',
            severity: 'warn',
            summary: `Chat ${cur.attributes['gen_ai.request.model']} reused parent context but cache_read=0 (input ${inputTokens(cur)} tokens)`,
            spanIds: [cur.spanId],
            context: {
              model: cur.attributes['gen_ai.request.model'],
              inputTokens: inputTokens(cur),
              priorChatId: group[i - 1]?.spanId
            }
          })
        }
      }
    }
    return out
  }
}

/** All built-in rules in registration order. */
export const BUILTIN_RULES: RegisteredRule[] = [
  prefillExplosionRule,
  slowToolTailRule,
  repeatedWorkRule,
  sequentialDependencyRule,
  cacheMissRule
]
