/**
 * Empty state when this project has no telemetry to project.
 * Surfaces the *specific* reason (config off, no traces dir, no spans yet)
 * so the user knows what to do, not just "nothing here".
 */

import { Activity, AlertCircle, FileText } from 'lucide-react'

interface Props {
  reason?: 'no-root' | 'no-traces-dir' | 'no-span-files' | 'no-spans'
  onRefresh: () => void
}

export function EmptyTelemetry({ reason, onRefresh }: Props) {
  const cfg = reasonContent(reason)
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="max-w-md text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full t-bg-elevated mb-4">
          <cfg.icon size={20} className="t-text-muted" />
        </div>
        <h2 className="text-[var(--text-lg)] font-medium t-text mb-2">{cfg.title}</h2>
        <p className="text-[var(--text-sm)] t-text-secondary leading-relaxed mb-5">
          {cfg.body}
        </p>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 rounded-md border t-border-subtle t-bg-elevated t-text-secondary hover:t-text text-[var(--text-sm)] transition-colors"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}

function reasonContent(reason?: Props['reason']) {
  switch (reason) {
    case 'no-root':
      return {
        icon: FileText,
        title: 'No project open',
        body: 'Open a project to inspect its provenance graph.',
      }
    case 'no-traces-dir':
    case 'no-span-files':
      return {
        icon: Activity,
        title: 'Telemetry not yet recorded',
        body: 'This project does not have a telemetry directory. Tracing may be disabled in Settings, or the project has not run an agent turn yet.',
      }
    case 'no-spans':
      return {
        icon: AlertCircle,
        title: 'Telemetry files are empty',
        body: 'Trace files exist but contain no spans — turns may not have been completed, or spans were dropped by the ring queue. Run an agent turn to populate the graph.',
      }
    default:
      return {
        icon: Activity,
        title: 'No telemetry data',
        body: 'There is no telemetry to project for this project yet.',
      }
  }
}
