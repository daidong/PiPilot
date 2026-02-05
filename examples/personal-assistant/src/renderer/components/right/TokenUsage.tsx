/**
 * TokenUsage - Compact token usage and cost display with persistence
 *
 * Shows all-time totals including cache hit rate (persisted by framework)
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
    allTimeTokens,
    allTimePromptTokens,
    allTimeCachedTokens,
    allTimeCost,
    allTimeCalls,
    resetAllTime
  } = useUsageStore()

  const [confirmReset, setConfirmReset] = useState(false)

  // Calculate all-time cache hit rate
  const allTimeCacheHitRate = allTimePromptTokens > 0
    ? allTimeCachedTokens / allTimePromptTokens
    : 0

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
    <div className="text-[11px] t-text-muted">
      <div className="flex items-center justify-between">
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
          <span className="t-text-muted/50">·</span>
          <span title="All-time cache hit rate" className="text-blue-500">{(allTimeCacheHitRate * 100).toFixed(0)}%</span>
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
