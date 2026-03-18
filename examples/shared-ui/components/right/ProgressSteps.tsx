import React, { useMemo } from 'react'
import { CheckCircle2, Circle, Loader2, Ban } from 'lucide-react'
import { useProgressStore } from '../../stores/progress-store'

export function ProgressSteps() {
  const items = useProgressStore((s) => s.items)

  const { doneCount, total, fraction } = useMemo(() => {
    const done = items.filter((i) => i.status === 'done').length
    const t = items.length
    return { doneCount: done, total: t, fraction: t > 0 ? done / t : 0 }
  }, [items])

  return (
    <div>
      <h3 className="text-xs font-semibold t-text-accent-soft uppercase tracking-wider mb-2">
        Progress{total > 0 ? ` (${doneCount}/${total})` : ''}
      </h3>

      {total > 0 && (
        <div className="w-full h-1.5 rounded-full t-bg-surface mb-3 overflow-hidden">
          <div
            className="h-full rounded-full t-bg-success transition-all duration-300"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      )}

      {total === 0 ? (
        <p className="text-xs t-text-muted">No tasks yet</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-2 text-xs py-0.5">
              <span className={`mt-0.5 shrink-0 ${statusColor(item.status)}`}>
                {statusIcon(item.status)}
              </span>
              <span className={statusTextClass(item.status)}>
                {item.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function statusIcon(status: string) {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={13} />
    case 'in_progress':
      return <Loader2 size={13} className="animate-spin" />
    case 'blocked':
      return <Ban size={13} />
    default:
      return <Circle size={13} />
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'done':
      return 't-text-success'
    case 'in_progress':
      return 't-text-accent-soft'
    case 'blocked':
      return 't-text-error'
    default:
      return 't-text-muted'
  }
}

function statusTextClass(status: string) {
  switch (status) {
    case 'done':
      return 't-text-secondary'
    case 'in_progress':
      return 't-text'
    default:
      return 't-text-muted'
  }
}
