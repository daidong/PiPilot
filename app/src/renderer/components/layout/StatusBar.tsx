import React, { useMemo } from 'react'
import { Check, X as XIcon, Loader2, CircleDot } from 'lucide-react'
import { useActivityStore } from '../../stores/activity-store'
import { useUsageStore } from '../../stores/usage-store'

function formatCost(cost: number): string {
  if (cost === 0) return '$0'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

export function StatusBar() {
  const events = useActivityStore((s) => s.events)
  const activeSkills = useActivityStore((s) => s.activeSkills)
  const runTokens = useUsageStore((s) => s.runTokens)
  const runPromptTokens = useUsageStore((s) => s.runPromptTokens)
  const runCompletionTokens = useUsageStore((s) => s.runCompletionTokens)
  const runCachedTokens = useUsageStore((s) => s.runCachedTokens)
  const runCost = useUsageStore((s) => s.runCost)
  const runCacheHitRate = useUsageStore((s) => s.runCacheHitRate)
  const allTimeTokens = useUsageStore((s) => s.allTimeTokens)
  const allTimeCost = useUsageStore((s) => s.allTimeCost)

  // Aggregate tool calls by name
  const toolSummary = useMemo(() => {
    const counts = new Map<string, { total: number; success: number; pending: number; failed: number }>()
    for (const e of events) {
      if (!e.tool) continue
      const name = e.tool
      if (!counts.has(name)) counts.set(name, { total: 0, success: 0, pending: 0, failed: 0 })
      const c = counts.get(name)!
      // Activity store merges tool-result INTO the tool-call entry (replacing its type),
      // so after completion we only see 'tool-result' events. Count both types toward total.
      c.total++
      if (e.type === 'tool-call') {
        c.pending++
      } else if (e.type === 'tool-result') {
        if (e.success === false) c.failed++
        else c.success++
      }
    }
    return Array.from(counts.entries())
      .map(([name, c]) => ({ name, ...c }))
      .filter((c) => c.total > 0)
  }, [events])

  const hasActivity = toolSummary.length > 0
  const hasSkills = activeSkills.length > 0
  const hasRunUsage = runTokens > 0
  const hasProjectUsage = allTimeTokens > 0

  return (
    <div className="h-7 flex items-center px-4 gap-5 border-t t-border t-bg-surface text-[11px] t-text-secondary select-none shrink-0">
      {/* Active skills */}
      {hasSkills && (
        <div className="flex items-center gap-2 overflow-hidden">
          {activeSkills.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded t-bg-accent/10 t-text-accent whitespace-nowrap"
            >
              <CircleDot size={10} className="shrink-0" aria-hidden />
              <span>{name}</span>
            </span>
          ))}
        </div>
      )}

      {/* Activity summary */}
      {hasActivity && (
        <div className="flex items-center gap-3 overflow-hidden">
          {toolSummary.map((t) => (
            <span key={t.name} className="flex items-center gap-1.5 whitespace-nowrap">
              {t.pending > 0 ? (
                <Loader2 size={11} className="t-text-warning shrink-0 animate-spin" aria-label="In progress" />
              ) : t.failed > 0 ? (
                <XIcon size={11} className="t-text-error shrink-0" aria-label="Failed" />
              ) : (
                <Check size={11} className="t-text-success shrink-0" aria-label="Done" />
              )}
              <span className="capitalize">{t.name}</span>
              <span className="t-text-muted tabular-nums">×{t.total}</span>
            </span>
          ))}
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side: run usage | project totals */}
      <div className="flex items-center gap-3 whitespace-nowrap">
        {/* Current run with token breakdown */}
        {hasRunUsage && (
          <>
            <span title={`In: ${formatTokens(runPromptTokens)} · Cache: ${formatTokens(runCachedTokens)} · Out: ${formatTokens(runCompletionTokens)}`}>
              {formatTokens(runTokens)} tokens
            </span>
            {runCost > 0 && (
              <span className="t-text-success">{formatCost(runCost)}</span>
            )}
            <span className={runCacheHitRate > 0.5 ? 't-text-accent' : 't-text-accent-soft'}>
              {Math.round(runCacheHitRate * 100)}% cache
            </span>
          </>
        )}
        {/* Separator between run and project */}
        {hasRunUsage && hasProjectUsage && (
          <span className="t-text-muted opacity-50" aria-hidden>·</span>
        )}
        {/* Accumulated project totals */}
        {hasProjectUsage && (
          <span className="t-text-muted" title="Project total">
            {formatTokens(allTimeTokens)} / {formatCost(allTimeCost)}
          </span>
        )}
        {/* Idle state */}
        {!hasActivity && !hasRunUsage && !hasProjectUsage && (
          <span>Ready</span>
        )}
      </div>
    </div>
  )
}
