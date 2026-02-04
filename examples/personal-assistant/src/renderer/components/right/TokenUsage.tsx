/**
 * TokenUsage - Compact token usage and cost display
 */

import React from 'react'
import { useUsageStore } from '../../stores/usage-store'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export function TokenUsage() {
  const { runTokens, runCost, runCacheHitRate, sessionTokens, sessionCost, runCallCount } = useUsageStore()

  return (
    <div className="text-[11px] t-text-muted space-y-0.5">
      {/* Current run: tokens | cost | cache% | calls */}
      <div className="flex items-center justify-between">
        <span className="uppercase text-[10px] font-medium tracking-wide">Run</span>
        <div className="flex items-center gap-2 font-mono">
          <span title="Tokens">{formatTokens(runTokens)}</span>
          <span className="t-text-muted/50">·</span>
          <span title="Cost" className="text-green-500">{formatCost(runCost)}</span>
          <span className="t-text-muted/50">·</span>
          <span title="Cache hit rate" className="text-blue-500">{(runCacheHitRate * 100).toFixed(0)}%</span>
          {runCallCount > 0 && (
            <>
              <span className="t-text-muted/50">·</span>
              <span title="LLM calls">{runCallCount}×</span>
            </>
          )}
        </div>
      </div>
      {/* Session total */}
      {sessionCost > 0 && (
        <div className="flex items-center justify-between border-t t-border pt-0.5">
          <span className="uppercase text-[10px] font-medium tracking-wide">Session</span>
          <div className="flex items-center gap-2 font-mono">
            <span>{formatTokens(sessionTokens)}</span>
            <span className="t-text-muted/50">·</span>
            <span className="text-green-500">{formatCost(sessionCost)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
