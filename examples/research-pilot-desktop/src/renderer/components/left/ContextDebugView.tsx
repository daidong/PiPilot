import React, { useEffect, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'

interface TurnExplainSnapshot {
  intents?: string[]
  sessionSummary?: {
    included: boolean
    turnRange?: [number, number]
    approxTokens: number
  }
  totalTokens?: number
}

export function ContextDebugView() {
  const [snapshot, setSnapshot] = useState<TurnExplainSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    const api = (window as any).api
    setLoading(true)
    try {
      const result = await api.turnExplainGet()
      setSnapshot(result?.snapshot || result?.data || result || null)
    } catch {
      setSnapshot(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const sessionSummary = snapshot?.sessionSummary
  const intents = snapshot?.intents || []

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Eye size={11} className="text-indigo-400" />
        <span className="text-[10px] font-semibold t-text-muted uppercase tracking-wider">Context Debug</span>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto p-0.5 t-text-muted hover:text-indigo-400 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!snapshot ? (
        <p className="text-[10px] t-text-muted">No context data available yet</p>
      ) : (
        <>
          {intents.length > 0 && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="t-text-muted">Intents:</span>
              {intents.map((intent, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded-full t-bg-elevated text-teal-400">{intent}</span>
              ))}
            </div>
          )}

          {sessionSummary && (
            <div className="flex items-center gap-3 text-[10px]">
              <span className="t-text-muted">Summary:</span>
              <span className={sessionSummary.included ? 'text-teal-400' : 't-text-secondary'}>
                {sessionSummary.included ? 'included' : 'none'}
              </span>
              {sessionSummary.turnRange && (
                <span className="t-text-secondary">turns {sessionSummary.turnRange[0]}-{sessionSummary.turnRange[1]}</span>
              )}
              {sessionSummary.approxTokens > 0 && (
                <span className="t-text-secondary">{sessionSummary.approxTokens} tokens</span>
              )}
            </div>
          )}

          {snapshot?.totalTokens != null && snapshot.totalTokens > 0 && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="t-text-muted">Total context:</span>
              <span className="t-text-secondary">{snapshot.totalTokens} tokens</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
