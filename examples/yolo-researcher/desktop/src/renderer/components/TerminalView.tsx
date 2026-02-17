import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopOverview, TurnListItem } from '../lib/types'
import { MONO_FONT } from '../lib/types'

interface TerminalViewProps {
  overview: DesktopOverview | null
  turns: TurnListItem[]
}

interface ExecResultMeta {
  exit_code?: number
  runtime?: string
  cmd?: string
  cwd?: string
  duration_sec?: number
  timestamp?: string
}

export default function TerminalView({ overview, turns }: TerminalViewProps) {
  const api = window.api
  const canOperate = Boolean(overview?.projectPath)

  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [cmd, setCmd] = useState('')
  const [stdout, setStdout] = useState('')
  const [stderr, setStderr] = useState('')
  const [exitCode, setExitCode] = useState('')
  const [resultMeta, setResultMeta] = useState<ExecResultMeta | null>(null)
  const [followTail, setFollowTail] = useState(true)

  const latestTurn = turns[turns.length - 1]?.turnNumber ?? null

  useEffect(() => {
    if (turns.length === 0) {
      setSelectedTurn(null)
      return
    }

    const hasSelected = turns.some((turn) => turn.turnNumber === selectedTurn)
    if (!hasSelected) {
      setSelectedTurn(latestTurn)
    }
  }, [turns, selectedTurn, latestTurn])

  const loadTurnData = useCallback(async (turnNumber: number | null) => {
    if (!turnNumber || !canOperate) {
      setCmd('')
      setStdout('')
      setStderr('')
      setExitCode('')
      setResultMeta(null)
      return
    }

    try {
      const [cmdRes, stdoutRes, stderrRes, exitRes, resultRes] = await Promise.all([
        api.yoloReadTurnFile(turnNumber, 'cmd.txt'),
        api.yoloReadTurnFile(turnNumber, 'stdout.txt'),
        api.yoloReadTurnFile(turnNumber, 'stderr.txt'),
        api.yoloReadTurnFile(turnNumber, 'exit_code.txt'),
        api.yoloReadTurnFile(turnNumber, 'result.json')
      ])

      setCmd(cmdRes.exists ? cmdRes.content : '')
      setStdout(stdoutRes.exists ? stdoutRes.content : '')
      setStderr(stderrRes.exists ? stderrRes.content : '')
      setExitCode(exitRes.exists ? exitRes.content.trim() : '')

      if (resultRes.exists && resultRes.content.trim()) {
        try {
          const parsed = JSON.parse(resultRes.content) as ExecResultMeta
          setResultMeta(parsed)
        } catch {
          setResultMeta(null)
        }
      } else {
        setResultMeta(null)
      }
    } catch {
      setCmd('')
      setStdout('')
      setStderr('')
      setExitCode('')
      setResultMeta(null)
    }
  }, [api, canOperate])

  useEffect(() => {
    void loadTurnData(selectedTurn)
  }, [loadTurnData, selectedTurn])

  useEffect(() => {
    if (!followTail) return
    if (!overview?.loopRunning) return
    if (!selectedTurn || !latestTurn || selectedTurn !== latestTurn) return

    const timer = setInterval(() => {
      void loadTurnData(selectedTurn)
    }, 1000)

    return () => {
      clearInterval(timer)
    }
  }, [followTail, overview?.loopRunning, selectedTurn, latestTurn, loadTurnData])

  const exitCodeNum = useMemo(() => {
    if (exitCode) {
      const parsed = parseInt(exitCode, 10)
      if (Number.isFinite(parsed)) return parsed
    }
    if (typeof resultMeta?.exit_code === 'number') {
      return resultMeta.exit_code
    }
    return null
  }, [exitCode, resultMeta])

  const exitColor = exitCodeNum === 0 ? 'var(--color-accent-emerald)' : exitCodeNum !== null ? 'var(--color-accent-rose)' : 'var(--color-text-muted)'
  const statusTone = exitCodeNum === 0
    ? 'border-emerald-500/35 bg-emerald-500/10'
    : exitCodeNum !== null
      ? 'border-rose-500/35 bg-rose-500/10'
      : ''

  const silentSuccess = exitCodeNum === 0 && !stdout.trim() && !stderr.trim()
  const monoFont = MONO_FONT

  const durationLabel = typeof resultMeta?.duration_sec === 'number' ? `${resultMeta.duration_sec.toFixed(2)}s` : ''
  const runtimeLabel = resultMeta?.runtime?.trim() || ''
  const cwdLabel = resultMeta?.cwd?.trim() || ''
  const timestampRaw = resultMeta?.timestamp?.trim() || ''
  const timestampLabel = timestampRaw && Number.isFinite(Date.parse(timestampRaw))
    ? new Date(timestampRaw).toLocaleTimeString()
    : ''

  return (
    <div className="flex h-full flex-col p-4 gap-3">
      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}>
        <div className="mb-2 flex items-center gap-2">
          <span style={{ color: 'var(--color-accent-teal)', fontFamily: monoFont, fontSize: '13px' }}>&#9654;</span>
          <span className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>Execution Console</span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {turns.length} turns
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setFollowTail((v) => !v)}
            className="rounded-md border px-1.5 py-0.5 text-[10px]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
          >
            {followTail ? 'Auto-refresh on' : 'Auto-refresh off'}
          </button>
        </div>

        <div className="flex flex-wrap gap-1 mb-2">
          {turns.length === 0 && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>(no turns)</span>
          )}
          {turns.slice(-8).map((t) => {
            const isActive = t.turnNumber === selectedTurn
            return (
              <button
                key={t.turnNumber}
                type="button"
                onClick={() => setSelectedTurn(t.turnNumber)}
                className={`max-w-full truncate rounded-md border px-2 py-1 text-[10px] transition-colors ${
                  isActive ? '' : ''
                }`}
                style={isActive
                  ? { borderColor: 'var(--color-accent)', background: 'var(--color-bg-selected)', color: 'var(--color-accent-teal)' }
                  : { borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }
                }
                title={`Turn ${t.turnNumber}`}
              >
                {t.turnNumber.toString().padStart(4, '0')}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          {exitCodeNum !== null && (
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${statusTone}`}
              style={{ color: exitColor }}
            >
              exit {exitCodeNum}
            </span>
          )}
          {runtimeLabel && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
              {runtimeLabel}
            </span>
          )}
          {durationLabel && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
              {durationLabel}
            </span>
          )}
          {timestampLabel && (
            <span className="rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}>
              {timestampLabel}
            </span>
          )}
        </div>
      </div>

      {cmd && (
        <div className="shrink-0 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-surface)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Command</div>
          <pre className="mt-1.5 text-xs whitespace-pre-wrap break-words" style={{ fontFamily: monoFont, color: 'var(--color-accent-teal)' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>$ </span>{cmd.trim()}
          </pre>
          {cwdLabel && (
            <div className="mt-1.5 text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }} title={cwdLabel}>
              cwd: {cwdLabel}
            </div>
          )}
        </div>
      )}

      {silentSuccess && (
        <div className="shrink-0 rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }}>
          Command succeeded but produced no stdout/stderr. This is normal for some non-interactive commands.
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden gap-2 min-h-0">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border overflow-hidden" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <div className="shrink-0 px-4 py-1.5" style={{ background: 'var(--color-bg-surface)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-emerald)' }}>stdout</span>
          </div>
          <pre
            className="flex-1 overflow-auto px-4 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words"
            style={{ fontFamily: monoFont, color: 'var(--color-terminal-text)', background: 'var(--color-terminal-bg)' }}
          >
            {stdout || '(empty)'}
          </pre>
        </div>

        <div className="flex flex-col rounded-lg border overflow-hidden" style={{ borderColor: 'var(--color-border-subtle)', maxHeight: '30%', minHeight: '80px' }}>
          <div className="shrink-0 px-4 py-1.5" style={{ background: 'var(--color-bg-surface)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-rose)' }}>stderr</span>
          </div>
          <pre
            className="flex-1 overflow-auto px-4 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words"
            style={{ fontFamily: monoFont, color: 'var(--color-terminal-stderr)', background: 'var(--color-terminal-bg)' }}
          >
            {stderr || '(empty)'}
          </pre>
        </div>
      </div>
    </div>
  )
}
