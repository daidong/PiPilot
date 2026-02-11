import React, { useEffect, useState } from 'react'
import { Layers, Target, Eye, X } from 'lucide-react'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'

interface TaskAnchorView {
  currentGoal: string
  nowDoing: string
  blockedBy: string[]
  nextAction: string
  updatedAt: string
}

function FocusChip({ entity, onRemove }: { entity: EntityItem; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs t-border t-bg-surface t-text-secondary">
      <Layers size={10} className="text-teal-400" />
      <span className="truncate max-w-[150px]">{entity.title}</span>
      <button onClick={onRemove} className="opacity-60 hover:opacity-100 transition-opacity">
        <X size={10} />
      </button>
    </span>
  )
}

export function ContextChips() {
  const { focus, toggleFocus, refreshAll } = useEntityStore()
  const [anchor, setAnchor] = useState<TaskAnchorView | null>(null)
  const [explain, setExplain] = useState<any>(null)

  useEffect(() => {
    ;(async () => {
      refreshAll()
      const api = (window as any).api
      const [anchorResult, explainResult] = await Promise.all([
        api.taskAnchorGet?.(),
        api.memoryExplainTurn?.()
      ])
      setAnchor(anchorResult?.anchor || null)
      setExplain(explainResult?.data || explainResult || null)
    })()
  }, [refreshAll, focus.length])

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Layers size={10} /> Focus
          <span className="text-[10px] font-normal opacity-70">(session)</span>
        </h3>
        {focus.length === 0 ? (
          <p className="text-xs t-text-muted">No focused artifacts</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {focus.map((e) => (
              <FocusChip key={e.id} entity={e} onRemove={() => toggleFocus(e.id)} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Target size={10} /> Task Anchor
        </h3>
        {!anchor ? (
          <p className="text-xs t-text-muted">No task anchor yet</p>
        ) : (
          <div className="rounded-lg border t-border t-bg-surface p-2 text-xs space-y-1">
            <p><span className="opacity-70">Goal:</span> {anchor.currentGoal || '-'}</p>
            <p><span className="opacity-70">Doing:</span> {anchor.nowDoing || '-'}</p>
            <p><span className="opacity-70">Blocked:</span> {anchor.blockedBy?.length ? anchor.blockedBy.join('; ') : '-'}</p>
            <p><span className="opacity-70">Next:</span> {anchor.nextAction || '-'}</p>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Eye size={10} /> Context Explain
        </h3>
        {!explain ? (
          <p className="text-xs t-text-muted">No explain snapshot yet</p>
        ) : (
          <div className="rounded-lg border t-border t-bg-surface p-2 text-[11px] space-y-1">
            <p><span className="opacity-70">Intents:</span> {(explain.intents || []).join(', ') || '-'}</p>
            <p><span className="opacity-70">Focus used:</span> {explain.focus?.used?.length ?? 0}</p>
            <p><span className="opacity-70">Selected context:</span> {explain.selectedContext?.approxTokens ?? 0} tokens</p>
            <p><span className="opacity-70">Persistence:</span> {explain.persistence?.decision ?? '-'}</p>
            <p><span className="opacity-70">Reason:</span> {explain.persistence?.reason ?? '-'}</p>
            <p><span className="opacity-70">Budget total:</span> {explain.budget?.totalTokens ?? '-'}</p>
          </div>
        )}
      </div>
    </div>
  )
}
