import React, { useEffect, useState } from 'react'
import { Layers, X, Trash2, Clock } from 'lucide-react'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useUIStore } from '../../stores/ui-store'

function timeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'expired'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt).getTime() <= Date.now()
}

function FocusRow({ entry }: { entry: EntityItem }) {
  const toggleFocus = useEntityStore((s) => s.toggleFocus)
  const openPreview = useUIStore((s) => s.openPreview)
  const expired = isExpired(entry.expiresAt)
  const isManual = entry.source === 'manual'

  return (
    <div
      className={`px-2 py-1.5 rounded t-bg-hover transition-colors cursor-pointer group ${expired ? 'opacity-50' : ''}`}
      onClick={() => openPreview(entry)}
    >
      <div className="flex items-center gap-1.5">
        <Layers size={11} className={isManual ? 'text-teal-400' : 'text-blue-400'} />
        <span className="text-xs t-text truncate flex-1">{entry.title}</span>
        <button
          onClick={(e) => { e.stopPropagation(); toggleFocus(entry.id) }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 t-text-muted hover:text-red-400 transition-all"
          title="Remove from focus"
        >
          <X size={11} />
        </button>
      </div>
      <div className="flex items-center gap-2 ml-4 mt-0.5">
        {entry.reason && (
          <span className="text-[10px] t-text-muted truncate flex-1">{entry.reason}</span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
            isManual ? 'text-teal-400 bg-teal-400/10' : 'text-blue-400 bg-blue-400/10'
          }`}>
            {isManual ? 'manual' : 'auto'}
          </span>
          {entry.expiresAt && (
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${
              expired ? 'text-red-400 bg-red-400/10' : 't-text-muted t-bg-surface'
            }`}>
              <Clock size={8} />
              {expired ? 'expired' : timeRemaining(entry.expiresAt)}
            </span>
          )}
          {entry.score != null && (
            <span className="text-[9px] t-text-muted" title="Relevance score">
              {(entry.score * 10).toFixed(0)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function FocusPanel() {
  const { focus, clearFocus, refreshAll } = useEntityStore()
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    refreshAll()
  }, [])

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    clearFocus()
    setConfirmClear(false)
  }

  const activeEntries = focus.filter(e => !isExpired(e.expiresAt))
  const expiredEntries = focus.filter(e => isExpired(e.expiresAt))

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b t-border">
        <Layers size={13} className="text-teal-400" />
        <span className="text-xs font-semibold t-text">Focus</span>
        <span className="text-[10px] t-text-muted">({focus.length})</span>
        {focus.length > 0 && (
          <button
            onClick={handleClear}
            className={`ml-auto text-[10px] px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              confirmClear ? 'text-red-500 bg-red-500/10' : 't-text-muted hover:text-red-400'
            }`}
            title={confirmClear ? 'Click again to confirm' : 'Clear all'}
          >
            <Trash2 size={9} />
            {confirmClear ? 'Confirm?' : 'Clear'}
          </button>
        )}
      </div>

      <div className="px-1 py-1 space-y-0.5 overflow-y-auto min-h-0 flex-1">
        {focus.length === 0 ? (
          <p className="px-3 py-8 text-xs t-text-muted text-center">
            No focused items. Add artifacts to focus from Library or Papers tab.
          </p>
        ) : (
          <>
            {activeEntries.map(entry => <FocusRow key={entry.id} entry={entry} />)}
            {expiredEntries.length > 0 && (
              <>
                <p className="text-[10px] t-text-muted uppercase tracking-wider px-2 pt-2 pb-0.5">
                  Expired
                </p>
                {expiredEntries.map(entry => <FocusRow key={entry.id} entry={entry} />)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
