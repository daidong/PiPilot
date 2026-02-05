import React, { useEffect } from 'react'
import { Bookmark, Layers, X, StickyNote, FileText } from 'lucide-react'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'

const typeColors: Record<string, string> = {
  note: 'bg-yellow-900/30 border-yellow-700/40 text-yellow-300',
  doc: 'bg-blue-900/30 border-blue-700/40 text-blue-300'
}

const typeColorsLight: Record<string, string> = {
  note: 'bg-yellow-50 border-yellow-300 text-yellow-800',
  doc: 'bg-blue-50 border-blue-300 text-blue-800'
}

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={12} />,
  doc: <FileText size={12} />
}

function Chip({ entity, variant, onRemove }: {
  entity: EntityItem
  variant: 'projectCard' | 'workingSet'
  onRemove: () => void
}) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const colors = isDark ? typeColors : typeColorsLight
  const color = colors[entity.type] || 'border t-border t-text-secondary'
  const isAuto = variant === 'workingSet' && entity.workingSetSource && entity.workingSetSource !== 'explicit'
  const autoLabel = entity.workingSetSource ? `auto:${entity.workingSetSource}` : 'auto'
  const autoTitle = entity.workingSetReason
    ? `Auto-added via ${entity.workingSetSource}: ${entity.workingSetReason}`
    : `Auto-added via ${entity.workingSetSource}`

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${color}`}>
      {typeIcons[entity.type]}
      <span className="truncate max-w-[120px]">{entity.title}</span>
      {variant === 'projectCard' && <Bookmark size={10} className="opacity-60" />}
      {isAuto && (
        <span
          className="px-1 py-0.5 text-[9px] rounded border opacity-70"
          title={autoTitle}
        >
          {autoLabel}
        </span>
      )}
      {!isAuto && (
        <button onClick={onRemove} className="opacity-50 hover:opacity-100 transition-opacity">
          <X size={10} />
        </button>
      )}
    </span>
  )
}

export function ContextChips() {
  // RFC-009: Using new naming (projectCards, workingSet) with legacy alias support
  const { projectCards, workingSet, workingSetRuntime, toggleProjectCard, toggleWorkingSet, refreshAll } = useEntityStore()

  useEffect(() => {
    refreshAll()
  }, [])

  const workingSetAll = (() => {
    const merged = new Map<string, EntityItem>()
    for (const item of workingSetRuntime || []) {
      merged.set(item.id, item)
    }
    for (const item of workingSet || []) {
      merged.set(item.id, item)
    }
    return Array.from(merged.values())
  })()

  return (
    <div className="space-y-3">
      {/* RFC-009: Project Cards (formerly Pinned) - long-term memory */}
      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Bookmark size={10} /> Project Cards
          <span className="text-[10px] font-normal opacity-70">(long-term)</span>
        </h3>
        {projectCards.length === 0 ? (
          <p className="text-xs t-text-muted">No project cards</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {projectCards.map((e) => (
              <Chip key={e.id} entity={e} variant="projectCard" onRemove={() => toggleProjectCard(e.id)} />
            ))}
          </div>
        )}
      </div>

      {/* RFC-009: Working Set (formerly Selected) - session context */}
      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Layers size={10} /> Working Set
          <span className="text-[10px] font-normal opacity-70">(this session)</span>
        </h3>
        {workingSetAll.length === 0 ? (
          <p className="text-xs t-text-muted">No items in working set</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {workingSetAll.map((e) => (
              <Chip key={e.id} entity={e} variant="workingSet" onRemove={() => toggleWorkingSet(e.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
