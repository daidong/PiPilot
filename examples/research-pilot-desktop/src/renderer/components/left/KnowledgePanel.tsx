import React, { useState } from 'react'
import { ArrowUp, ArrowDown, Brain, Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEntityStore, type FactItem } from '../../stores/entity-store'
import { useUIStore } from '../../stores/ui-store'

type StatusFilter = 'active' | 'proposed' | 'all'

const statusIcons: Record<string, React.ReactNode> = {
  proposed: <ShieldAlert size={11} className="text-yellow-500" />,
  active: <ShieldCheck size={11} className="text-green-500" />,
  superseded: <Shield size={11} className="t-text-muted" />,
  deprecated: <ShieldOff size={11} className="text-red-400" />
}

const statusColors: Record<string, string> = {
  proposed: 'text-yellow-500 bg-yellow-500/10',
  active: 'text-green-500 bg-green-500/10',
  superseded: 't-text-muted t-bg-surface',
  deprecated: 'text-red-400 bg-red-400/10'
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100)
  const barColor = pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-400'
  return (
    <div className="flex items-center gap-1.5" title={`Confidence: ${pct}%`}>
      <div className="w-12 h-1 rounded-full t-bg-surface overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] t-text-muted">{pct}%</span>
    </div>
  )
}

function FactRow({ fact }: { fact: FactItem }) {
  const promoteFact = useEntityStore((s) => s.promoteFact)
  const demoteFact = useEntityStore((s) => s.demoteFact)
  const openPreview = useUIStore((s) => s.openPreview)

  const handleClick = () => {
    openPreview({
      id: fact.id,
      type: 'fact',
      title: `${fact.namespace}/${fact.key}`,
      content: typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value, null, 2),
      valueText: fact.valueText,
      namespace: fact.namespace,
      key: fact.key,
      status: fact.status,
      confidence: fact.confidence,
      provenance: fact.provenance,
      derivedFromArtifactIds: fact.derivedFromArtifactIds,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt
    })
  }

  const displayValue = fact.valueText || (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value))
  const truncated = displayValue.length > 80 ? displayValue.slice(0, 80) + '...' : displayValue

  return (
    <div
      className="px-2 py-1.5 rounded t-bg-hover transition-colors cursor-pointer group"
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        {statusIcons[fact.status]}
        <span className="text-[11px] font-medium t-text truncate flex-1">
          {fact.namespace}<span className="t-text-muted">/</span>{fact.key}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${statusColors[fact.status]}`}>
          {fact.status}
        </span>
      </div>
      <p className="text-[11px] t-text-secondary truncate ml-4">{truncated}</p>
      <div className="flex items-center gap-2 ml-4 mt-1">
        <ConfidenceBar confidence={fact.confidence} />
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
          {fact.status === 'proposed' && (
            <button
              onClick={(e) => { e.stopPropagation(); promoteFact(fact.id) }}
              className="p-0.5 rounded text-green-500 hover:bg-green-500/10"
              title="Promote to active"
            >
              <ArrowUp size={11} />
            </button>
          )}
          {(fact.status === 'active' || fact.status === 'proposed') && (
            <button
              onClick={(e) => { e.stopPropagation(); demoteFact(fact.id) }}
              className="p-0.5 rounded text-red-400 hover:bg-red-400/10"
              title="Demote (deprecate)"
            >
              <ArrowDown size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function KnowledgePanel() {
  const facts = useEntityStore((s) => s.facts)
  const [filter, setFilter] = useState<StatusFilter>('all')

  const filtered = filter === 'all' ? facts : facts.filter(f => f.status === filter)

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b t-border">
        <Brain size={13} className="text-purple-400" />
        <span className="text-xs font-semibold t-text">Knowledge</span>
        <span className="text-[10px] t-text-muted">({filtered.length})</span>
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'active', 'proposed'] as StatusFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                filter === f ? 'bg-purple-500/20 text-purple-400' : 't-text-muted hover:t-text-secondary'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="px-1 py-1 space-y-0.5 overflow-y-auto min-h-0 flex-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-8 text-xs t-text-muted text-center">
            No facts yet. Facts are created by the agent during research.
          </p>
        ) : (
          filtered.map(fact => <FactRow key={fact.id} fact={fact} />)
        )}
      </div>
    </div>
  )
}
