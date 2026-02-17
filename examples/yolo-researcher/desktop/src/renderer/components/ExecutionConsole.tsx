import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Terminal } from 'lucide-react'
import type { ExecutionCommand } from '@/lib/types'

interface ExecutionConsoleProps {
  commands: ExecutionCommand[]
}

function clock(ts?: string): string {
  if (!ts) return '--:--:--'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function shortCommand(command: string, limit = 72): string {
  const firstLine = command.split('\n')[0] ?? ''
  if (firstLine.length <= limit) return firstLine
  return `${firstLine.slice(0, limit - 3)}...`
}

function statusTone(status: ExecutionCommand['status']): string {
  if (status === 'running') return 'border-sky-500/35 bg-sky-500/10 t-accent-sky'
  if (status === 'success') return 'border-emerald-500/35 bg-emerald-500/10 t-accent-emerald'
  if (status === 'failed') return 'border-amber-500/35 bg-amber-500/10 t-accent-amber'
  return 'border-rose-500/35 bg-rose-500/10 t-accent-rose'
}

export function ExecutionConsole({ commands }: ExecutionConsoleProps) {
  const [selectedTraceId, setSelectedTraceId] = useState<string>('')
  const [followTail, setFollowTail] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)

  const selected = useMemo(() => {
    if (commands.length === 0) return null
    return commands.find((item) => item.traceId === selectedTraceId) ?? commands[0]
  }, [commands, selectedTraceId])

  useEffect(() => {
    if (commands.length === 0) {
      setSelectedTraceId('')
      return
    }
    if (!commands.some((item) => item.traceId === selectedTraceId)) {
      const running = commands.find((item) => item.status === 'running')
      setSelectedTraceId((running ?? commands[0]).traceId)
    }
  }, [commands, selectedTraceId])

  useEffect(() => {
    if (!followTail) return
    const node = preRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [selected?.output, selected?.traceId, followTail])

  if (commands.length === 0) {
    return (
      <div className="rounded-2xl border t-border t-bg-surface p-3 text-xs t-text-muted">
        No command execution yet. Live command output will stream here.
      </div>
    )
  }

  const runningCount = commands.filter((item) => item.status === 'running').length

  return (
    <div className="rounded-2xl border t-border t-bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <Terminal size={14} className="t-accent-teal" />
        <span className="text-[11px] font-medium">Execution Console</span>
        <span className="text-[11px] t-text-muted">
          {commands.length} commands
          {runningCount > 0 ? ` · ${runningCount} running` : ''}
        </span>
        <button
          onClick={() => setFollowTail((prev) => !prev)}
          className="ml-auto rounded-md border t-border px-1.5 py-0.5 text-[10px] t-hoverable"
        >
          {followTail ? 'Auto-scroll on' : 'Auto-scroll off'}
        </button>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {commands.slice(0, 8).map((item) => (
          <button
            key={item.traceId}
            onClick={() => setSelectedTraceId(item.traceId)}
            className={`max-w-full rounded-md border px-2 py-1 text-[10px] ${
              selected?.traceId === item.traceId
                ? 'border-teal-500/45 bg-teal-500/10 t-accent-teal'
                : 't-border-subtle t-hoverable'
            }`}
            title={item.command || '(empty command)'}
          >
            {shortCommand(item.command || '(empty command)', 54)}
          </button>
        ))}
      </div>

      {selected && (
        <div className="rounded-xl border t-border-subtle p-2">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px]">
            <span className={`rounded-full border px-2 py-0.5 ${statusTone(selected.status)}`}>
              {selected.status}
            </span>
            <span className="t-text-muted">{clock(selected.startedAt)}</span>
            {selected.durationMs !== undefined && (
              <span className="t-text-muted">{(selected.durationMs / 1000).toFixed(2)}s</span>
            )}
            {selected.exitCode !== undefined && (
              <span className="t-text-muted">exit {selected.exitCode}</span>
            )}
            {selected.signal && (
              <span className="t-text-muted">signal {selected.signal}</span>
            )}
            {selected.status === 'running' && (
              <span className="inline-flex items-center gap-1 t-accent-sky">
                <Loader2 size={11} className="animate-spin" />
                running
              </span>
            )}
            {selected.status === 'success' && <CheckCircle2 size={11} className="t-accent-emerald" />}
            {(selected.status === 'failed' || selected.status === 'error') && <AlertTriangle size={11} className="t-accent-rose" />}
          </div>
          <div className="mb-1 text-[11px] t-text-secondary">
            <span className="t-text-muted">$</span> {selected.command || '(empty command)'}
          </div>
          <div className="mb-2 text-[10px] t-text-muted">
            cwd: {selected.cwd || '.'}
            {selected.tool ? ` · tool: ${selected.tool}` : ''}
            {selected.caller && selected.caller !== selected.tool ? ` · caller: ${selected.caller}` : ''}
            {` · chunks: ${selected.chunks}`}
          </div>
          <pre
            ref={preRef}
            className="max-h-[300px] overflow-auto rounded-lg border t-border-subtle bg-black/65 p-2 font-mono text-[11px] leading-relaxed text-gray-100 whitespace-pre-wrap break-words"
          >
            {selected.output || '(no output yet)'}
          </pre>
        </div>
      )}
    </div>
  )
}

