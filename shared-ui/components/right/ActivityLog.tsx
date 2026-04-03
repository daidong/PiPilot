import React from 'react'
import { Activity, AlertCircle, CheckCircle2, Loader2, Wrench, Info, FileText, Terminal, Search, Globe, BookOpen, Database, Sparkles } from 'lucide-react'
import { useActivityStore, type ActivityEvent } from '../../stores/activity-store'
import { useToolProgressStore } from '../../stores/tool-progress-store'
import { getToolIcon } from '../../tool-renderers/registry'

export function ActivityLog() {
  const events = useActivityStore((s) => s.events)
  const listRef = React.useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new events
  React.useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [events.length])

  return (
    <div>
      <h3 className="text-xs font-semibold t-text-accent-soft uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Activity size={12} />
        Activity
      </h3>

      {events.length === 0 ? (
        <p className="text-xs t-text-muted">No activity yet</p>
      ) : (
        <div ref={listRef} className="space-y-0.5 max-h-48 overflow-y-auto" role="log" aria-label="Agent activity" aria-live="polite">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}

const EventRow = React.memo(function EventRow({ event }: { event: ActivityEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  const detailText = getDetailText(event)

  // Look up real-time progress for in-flight tool calls
  const progressEntry = useToolProgressStore((s) =>
    event.type === 'tool-call' && event.toolCallId
      ? s.inFlight.get(event.toolCallId)
      : undefined
  )

  return (
    <div className="py-0.5">
      <div className="flex items-start gap-1.5 text-xs">
        <span className={`mt-0.5 shrink-0 ${eventColor(event)}`}>
          {eventIcon(event)}
        </span>
        <div className="min-w-0 flex-1">
          <span className={eventTextClass(event)}>
            {event.summary}
          </span>
          {detailText && (
            <p className="text-[10px] t-text-muted mt-0.5 truncate" title={detailText}>
              {detailText}
            </p>
          )}
          {event.error && (
            <p className="t-text-error-soft text-[10px] mt-0.5 truncate" title={event.error}>
              {event.error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {event.durationMs != null && (
            <span className="text-[10px] t-text-accent-soft tabular-nums">{formatDuration(event.durationMs)}</span>
          )}
          <span className="text-[10px] t-text-muted">{time}</span>
        </div>
      </div>
      {/* Real-time progress output for in-flight tools */}
      {progressEntry?.partialOutput && (
        <div className="ml-4 mt-1 mb-0.5 p-1.5 rounded t-bg-base text-[10px] font-mono t-text-muted overflow-hidden max-h-16 leading-tight whitespace-pre-wrap">
          {progressEntry.partialOutput}
        </div>
      )}
    </div>
  )
})

// ─── Detail text extraction ──────────────────────────────────

function getDetailText(event: ActivityEvent): string | undefined {
  // For completed tool results, show result detail
  if (event.type === 'tool-result' && event.resultDetail) {
    return formatResultDetail(event.tool, event.resultDetail)
  }
  // For in-progress tool calls, show key parameter from detail
  if (event.type === 'tool-call' && event.detail) {
    return formatCallDetail(event.tool, event.detail)
  }
  return undefined
}

function formatCallDetail(tool: string | undefined, detail: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return detail.path as string | undefined
    case 'bash':
      return detail.command as string | undefined
    case 'grep':
      return detail.path ? `in ${detail.path}` : undefined
    case 'literature-search':
      return detail.maxResults ? `max ${detail.maxResults} results` : undefined
    default:
      return undefined
  }
}

function formatResultDetail(tool: string | undefined, detail: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'read':
      return detail.lineCount ? `${detail.lineCount} lines` : undefined
    case 'bash': {
      const preview = detail.outputPreview as string | undefined
      if (preview) {
        const firstLine = preview.split('\n')[0]
        return firstLine?.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
      }
      return detail.outputLines ? `${detail.outputLines} lines output` : undefined
    }
    case 'grep':
      return detail.matchCount != null ? `${detail.matchCount} matches` : undefined
    case 'glob':
      return detail.fileCount != null ? `${detail.fileCount} files` : undefined
    case 'fetch':
      return detail.sizeKB != null ? `${detail.sizeKB}KB received` : undefined
    default:
      return undefined
  }
}

// ─── Helpers ──────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

const ICON_MAP: Record<string, React.ElementType> = {
  FileText, Terminal, Search, Globe, Wrench, BookOpen, Database, Sparkles
}

function toolIconComponent(tool: string | undefined): React.ElementType {
  if (!tool) return Wrench
  const iconName = getToolIcon(tool)
  return ICON_MAP[iconName] || Wrench
}

function eventIcon(event: ActivityEvent) {
  if (event.type === 'error') return <AlertCircle size={12} />
  if (event.type === 'system') return <Info size={12} />
  if (event.type === 'tool-call') {
    const Icon = toolIconComponent(event.tool)
    return <Icon size={12} className="animate-pulse" />
  }
  if (event.type === 'tool-result' && event.success) return <CheckCircle2 size={12} />
  if (event.type === 'tool-result' && !event.success) return <AlertCircle size={12} />
  return <Wrench size={12} />
}

function eventColor(event: ActivityEvent) {
  if (event.type === 'error') return 't-text-error'
  if (event.type === 'system') return 't-text-accent-soft'
  if (event.type === 'tool-call') return 't-text-accent-soft'
  if (event.type === 'tool-result' && event.success) return 't-text-success'
  if (event.type === 'tool-result' && !event.success) return 't-text-error'
  return 't-text-muted'
}

function eventTextClass(event: ActivityEvent) {
  if (event.type === 'error' || (event.type === 'tool-result' && !event.success)) return 't-text-error-soft'
  if (event.type === 'system') return 't-text-accent-soft'
  if (event.type === 'tool-call') return 't-text'
  return 't-text-secondary'
}
