import React, { useEffect } from 'react'
import { Pin, CheckSquare, X, StickyNote, BookOpen, Database } from 'lucide-react'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'

const typeColors: Record<string, string> = {
  note: 'bg-yellow-900/30 border-yellow-700/40 text-yellow-300',
  paper: 'bg-blue-900/30 border-blue-700/40 text-blue-300',
  data: 'bg-green-900/30 border-green-700/40 text-green-300'
}

const typeColorsLight: Record<string, string> = {
  note: 'bg-yellow-50 border-yellow-300 text-yellow-800',
  paper: 'bg-blue-50 border-blue-300 text-blue-800',
  data: 'bg-green-50 border-green-300 text-green-800'
}

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={12} />,
  paper: <BookOpen size={12} />,
  data: <Database size={12} />
}

function Chip({ entity, variant, onRemove }: {
  entity: EntityItem
  variant: 'pinned' | 'selected'
  onRemove: () => void
}) {
  // Use CSS variable to detect theme for chip colors
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const colors = isDark ? typeColors : typeColorsLight
  const color = colors[entity.type] || 'border t-border t-text-secondary'

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${color}`}>
      {typeIcons[entity.type]}
      <span className="truncate max-w-[120px]">{entity.title}</span>
      {variant === 'pinned' && <Pin size={10} className="opacity-60" />}
      <button onClick={onRemove} className="opacity-50 hover:opacity-100 transition-opacity">
        <X size={10} />
      </button>
    </span>
  )
}

export function ContextChips() {
  const { pinned, selected, togglePin, toggleSelect, refreshAll } = useEntityStore()

  useEffect(() => {
    refreshAll()
  }, [])

  const allPinned = pinned
  const allSelected = selected

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <Pin size={10} /> Pinned
        </h3>
        {allPinned.length === 0 ? (
          <p className="text-xs t-text-muted">No pinned entities</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allPinned.map((e) => (
              <Chip key={e.id} entity={e} variant="pinned" onRemove={() => togglePin(e.id)} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <CheckSquare size={10} /> Selected
        </h3>
        {allSelected.length === 0 ? (
          <p className="text-xs t-text-muted">No selected entities</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allSelected.map((e) => (
              <Chip key={e.id} entity={e} variant="selected" onRemove={() => toggleSelect(e.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
