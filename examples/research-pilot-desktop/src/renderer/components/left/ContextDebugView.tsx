import React, { useEffect, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'

interface TurnExplainSnapshot {
  focus?: {
    used?: number
    active?: number
    pruned?: number
  }
  budget?: {
    continuity?: number
    memory?: number
    evidence?: number
    nonProtected?: number
    protected?: number
    taskAnchor?: number
  }
  facts?: Array<{
    id: string
    namespace: string
    key: string
    valueText?: string
  }>
}

function BudgetBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span className="text-[9px] t-text-muted w-16 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full t-bg-surface overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] t-text-muted w-8 text-right">{value > 0 ? value : '-'}</span>
    </div>
  )
}

export function ContextDebugView() {
  const [snapshot, setSnapshot] = useState<TurnExplainSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    const api = (window as any).api
    setLoading(true)
    try {
      const result = await api.memoryExplainTurn()
      setSnapshot(result?.snapshot || result || null)
    } catch {
      setSnapshot(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const budget = snapshot?.budget
  const focus = snapshot?.focus
  const facts = snapshot?.facts || []
  const totalBudget = budget
    ? (budget.continuity || 0) + (budget.memory || 0) + (budget.evidence || 0) +
      (budget.nonProtected || 0) + (budget.protected || 0) + (budget.taskAnchor || 0)
    : 0

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
          {/* Focus stats */}
          {focus && (
            <div className="flex items-center gap-3 text-[10px]">
              <span className="t-text-muted">Focus:</span>
              <span className="text-teal-400">{focus.active ?? 0} active</span>
              <span className="t-text-secondary">{focus.used ?? 0} used</span>
              {(focus.pruned ?? 0) > 0 && (
                <span className="text-red-400">{focus.pruned} pruned</span>
              )}
            </div>
          )}

          {/* Token budget */}
          {budget && totalBudget > 0 && (
            <div>
              <p className="text-[9px] t-text-muted mb-1">Token Budget</p>
              <BudgetBar label="Continuity" value={budget.continuity || 0} total={totalBudget} color="bg-blue-500" />
              <BudgetBar label="Memory" value={budget.memory || 0} total={totalBudget} color="bg-purple-500" />
              <BudgetBar label="Evidence" value={budget.evidence || 0} total={totalBudget} color="bg-green-500" />
              <BudgetBar label="Protected" value={budget.protected || 0} total={totalBudget} color="bg-yellow-500" />
              <BudgetBar label="Task" value={budget.taskAnchor || 0} total={totalBudget} color="bg-orange-500" />
              <BudgetBar label="Other" value={budget.nonProtected || 0} total={totalBudget} color="bg-gray-400" />
            </div>
          )}

          {/* Injected facts */}
          {facts.length > 0 && (
            <div>
              <p className="text-[9px] t-text-muted mb-1">Injected Facts ({facts.length})</p>
              <div className="space-y-0.5">
                {facts.slice(0, 10).map(fact => (
                  <div key={fact.id} className="text-[10px] t-text-secondary truncate px-1">
                    <span className="t-text-muted">{fact.namespace}/</span>
                    {fact.key}
                    {fact.valueText && <span className="t-text-muted"> — {fact.valueText.slice(0, 40)}</span>}
                  </div>
                ))}
                {facts.length > 10 && (
                  <p className="text-[9px] t-text-muted px-1">+{facts.length - 10} more</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
