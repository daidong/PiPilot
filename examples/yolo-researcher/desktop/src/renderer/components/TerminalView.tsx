import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopOverview, TurnListItem, TerminalLiveEvent } from '../lib/types'
import { MONO_FONT } from '../lib/types'

interface TerminalViewProps {
  overview: DesktopOverview | null
  turns: TurnListItem[]
  terminalEvents: TerminalLiveEvent[]
}

interface ExecResultMeta {
  exit_code?: number
  runtime?: string
  cmd?: string
  cwd?: string
  duration_sec?: number
  timestamp?: string
}

interface LiveSnapshot {
  turnNumber: number
  command: string
  cwd: string
  caller: string
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  timestamp: string
}

const LIVE_OUTPUT_CAP = 200_000

function appendWithCap(base: string, chunk: string, cap: number = LIVE_OUTPUT_CAP): string {
  const next = `${base}${chunk}`
  if (next.length <= cap) return next
  return next.slice(next.length - cap)
}

export default function TerminalView({ overview, turns, terminalEvents }: TerminalViewProps) {
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

  const liveRunningTurn = useMemo(() => {
    const runningByTurn = new Map<number, boolean>()
    for (const event of terminalEvents) {
      if (event.phase === 'start') runningByTurn.set(event.turnNumber, true)
      if (event.phase === 'end' || event.phase === 'error') runningByTurn.set(event.turnNumber, false)
    }

    let running: number | null = null
    for (const [turnNumber, isRunning] of runningByTurn) {
      if (isRunning) running = turnNumber
    }
    return running
  }, [terminalEvents])

  const turnOptions = useMemo(() => {
    const values = turns.slice(-8).map((item) => item.turnNumber)
    if (liveRunningTurn && !values.includes(liveRunningTurn)) values.push(liveRunningTurn)
    return values.sort((a, b) => a - b)
  }, [turns, liveRunningTurn])

  useEffect(() => {
    if (turns.length === 0 && !liveRunningTurn) {
      setSelectedTurn(null)
      return
    }

    const hasSelectedInTurns = turns.some((turn) => turn.turnNumber === selectedTurn)
    const hasSelectedInLive = typeof selectedTurn === 'number'
      && terminalEvents.some((event) => event.turnNumber === selectedTurn)

    if (!hasSelectedInTurns && !hasSelectedInLive) {
      if (followTail && liveRunningTurn) {
        setSelectedTurn(liveRunningTurn)
      } else {
        setSelectedTurn(latestTurn ?? liveRunningTurn ?? null)
      }
    }
  }, [turns, terminalEvents, selectedTurn, latestTurn, liveRunningTurn, followTail])

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
    if (!selectedTurn) return
    if (!overview?.loopRunning && selectedTurn !== liveRunningTurn) return

    const timer = setInterval(() => {
      void loadTurnData(selectedTurn)
    }, 1000)

    return () => {
      clearInterval(timer)
    }
  }, [followTail, overview?.loopRunning, selectedTurn, liveRunningTurn, loadTurnData])

  const liveSnapshot = useMemo<LiveSnapshot | null>(() => {
    if (!selectedTurn) return null
    const events = terminalEvents.filter((event) => event.turnNumber === selectedTurn)
    if (events.length === 0) return null

    let command = ''
    let cwd = ''
    let caller = ''
    let out = ''
    let err = ''
    let liveExitCode: number | null = null
    let running = false
    let ts = events[0]?.timestamp || ''

    for (const event of events) {
      ts = event.timestamp || ts

      if (event.phase === 'start') {
        command = event.command || command
        cwd = event.cwd || cwd
        caller = event.caller || caller
        out = ''
        err = ''
        liveExitCode = null
        running = true
        continue
      }

      if (event.phase === 'chunk') {
        const chunk = event.chunk || ''
        if (event.stream === 'stderr') {
          err = appendWithCap(err, chunk)
        } else {
          out = appendWithCap(out, chunk)
        }
        continue
      }

      if (event.phase === 'end') {
        liveExitCode = typeof event.exitCode === 'number' ? event.exitCode : liveExitCode
        running = false
        continue
      }

      if (event.phase === 'error') {
        if (event.error?.trim()) {
          err = appendWithCap(err, `${event.error.trim()}\n`)
        }
        running = false
      }
    }

    return {
      turnNumber: selectedTurn,
      command,
      cwd,
      caller,
      stdout: out,
      stderr: err,
      exitCode: liveExitCode,
      running,
      timestamp: ts
    }
  }, [selectedTurn, terminalEvents])

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

  const hasDiskData = Boolean(cmd || stdout || stderr || exitCode || resultMeta)
  const useLiveData = Boolean(liveSnapshot && (liveSnapshot.running || !hasDiskData))

  const displayCmd = useLiveData ? (liveSnapshot?.command || cmd) : cmd
  const displayStdout = useLiveData ? (liveSnapshot?.stdout || stdout) : stdout
  const displayStderr = useLiveData ? (liveSnapshot?.stderr || stderr) : stderr
  const effectiveExitCode = useLiveData && typeof liveSnapshot?.exitCode === 'number'
    ? liveSnapshot.exitCode
    : exitCodeNum

  const exitColor = effectiveExitCode === 0 ? 'var(--color-accent-emerald)' : effectiveExitCode !== null ? 'var(--color-accent-rose)' : 'var(--color-text-muted)'
  const statusTone = effectiveExitCode === 0
    ? 'border-emerald-500/35 bg-emerald-500/10'
    : effectiveExitCode !== null
      ? 'border-rose-500/35 bg-rose-500/10'
      : ''

  const silentSuccess = effectiveExitCode === 0 && !displayStdout.trim() && !displayStderr.trim()
  const monoFont = MONO_FONT

  const durationLabel = typeof resultMeta?.duration_sec === 'number' ? `${resultMeta.duration_sec.toFixed(2)}s` : ''
  const runtimeLabel = (useLiveData ? liveSnapshot?.caller : undefined) || resultMeta?.runtime?.trim() || ''
  const cwdLabel = (useLiveData ? liveSnapshot?.cwd : undefined) || resultMeta?.cwd?.trim() || ''
  const timestampRaw = (useLiveData ? liveSnapshot?.timestamp : undefined) || resultMeta?.timestamp?.trim() || ''
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
          {useLiveData && (
            <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: 'var(--color-accent-teal)', color: 'var(--color-accent-teal)' }}>
              live
            </span>
          )}
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
          {turnOptions.length === 0 && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>(no turns)</span>
          )}
          {turnOptions.map((turnNumber) => {
            const isActive = turnNumber === selectedTurn
            return (
              <button
                key={turnNumber}
                type="button"
                onClick={() => setSelectedTurn(turnNumber)}
                className="max-w-full truncate rounded-md border px-2 py-1 text-[10px] transition-colors"
                style={isActive
                  ? { borderColor: 'var(--color-accent)', background: 'var(--color-bg-selected)', color: 'var(--color-accent-teal)' }
                  : { borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }
                }
                title={`Turn ${turnNumber}`}
              >
                {turnNumber.toString().padStart(4, '0')}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          {effectiveExitCode !== null && (
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${statusTone}`}
              style={{ color: exitColor }}
            >
              exit {effectiveExitCode}
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

      {displayCmd && (
        <div className="shrink-0 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-surface)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Command</div>
          <pre className="mt-1.5 text-xs whitespace-pre-wrap break-words" style={{ fontFamily: monoFont, color: 'var(--color-accent-teal)' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>$ </span>{displayCmd.trim()}
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
            {displayStdout || '(empty)'}
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
            {displayStderr || '(empty)'}
          </pre>
        </div>
      </div>
    </div>
  )
}
