/**
 * TokenUsage - Compact token usage and cost display with persistence
 *
 * Shows all-time totals including cache hit rate (persisted by framework)
 */

import React, { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useUsageStore } from '../../stores/usage-store'
import { formatTokens, formatCost } from '../../utils'

export function TokenUsage() {
  const {
    allTimeTokens,
    allTimePromptTokens,
    allTimeCachedTokens,
    allTimeBillableCost,
    allTimeCalls,
    billingSource,
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
              confirmReset ? 't-text-error' : 't-text-muted/50 hover:t-text-muted'
            }`}
            title={confirmReset ? 'Click again to reset' : 'Reset all-time totals'}
            aria-label={confirmReset ? 'Confirm reset all-time totals' : 'Reset all-time totals'}
          >
            <RotateCcw size={10} />
          </button>
        </div>
        <div className="flex items-center gap-2 font-mono">
          <span title="All-time tokens">{formatTokens(allTimeTokens)}</span>
          <span className="t-text-muted/50">·</span>
          <span title="API-billable cost" className="t-text-success">
            {formatCost(allTimeBillableCost)}
          </span>
          <span className="t-text-muted/50">·</span>
          <span title="All-time cache hit rate" className="t-text-accent">{(allTimeCacheHitRate * 100).toFixed(0)}%</span>
          <span className="t-text-muted/50">·</span>
          <span title="Current billing source">
            {billingSource === 'none' ? 'none' : 'api-key'}
          </span>
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
