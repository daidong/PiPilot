/**
 * TokenUsage - Compact token usage and cost display with persistence
 *
 * Shows:
 * - Current run stats (resets when new message is sent)
 * - All-time totals (persisted to localStorage, survives app restarts)
 */

import React, { useState } from 'react'
import { RotateCcw } from 'lucide-react'
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
  const {
    runTokens,
    runCost,
    runCacheHitRate,
    runCallCount,
    allTimeTokens,
    allTimeCost,
    allTimeCalls,
    resetAllTime
  } = useUsageStore()

  const [confirmReset, setConfirmReset] = useState(false)

  const handleResetClick = () => {
    if (confirmReset) {
      resetAllTime()
      setConfirmReset(false)
    } else {
      setConfirmReset(true)
      setTimeout(() => setConfirmReset(false), 3000)
    }
  }

  return (
    <div className="text-[11px] t-text-muted space-y-1">
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

      {/* All-time totals (persisted) */}
      <div className="flex items-center justify-between border-t t-border pt-1">
        <div className="flex items-center gap-1">
          <span className="uppercase text-[10px] font-medium tracking-wide">Total</span>
          <button
            onClick={handleResetClick}
            className={`p-0.5 rounded transition-colors ${
              confirmReset ? 'text-red-500' : 't-text-muted/50 hover:t-text-muted'
            }`}
            title={confirmReset ? 'Click again to reset' : 'Reset all-time totals'}
          >
            <RotateCcw size={10} />
          </button>
        </div>
        <div className="flex items-center gap-2 font-mono">
          <span title="All-time tokens">{formatTokens(allTimeTokens)}</span>
          <span className="t-text-muted/50">·</span>
          <span title="All-time cost" className="text-green-500">{formatCost(allTimeCost)}</span>
          {allTimeCalls > 0 && (
            <>
              <span className="t-text-muted/50">·</span>
              <span title="All-time LLM calls">{allTimeCalls}×</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
