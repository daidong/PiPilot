import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopOverview, TurnListItem, TurnArtifactMeta, TurnFileName } from '../lib/types'
import { TURN_FILES, toneForStatus } from '../lib/types'

interface EvidenceViewProps {
  overview: DesktopOverview | null
  turns: TurnListItem[]
  projectMarkdown: string
  failuresMarkdown: string
}

function hasMeaningfulFailures(markdown: string): boolean {
  const normalized = markdown.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes('- none.')) return false
  return true
}

export default function EvidenceView({ overview, turns, projectMarkdown, failuresMarkdown }: EvidenceViewProps) {
  const api = window.api
  const canOperate = Boolean(overview?.projectPath)
  const showExpandedFailures = hasMeaningfulFailures(failuresMarkdown)

  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [selectedTurnFile, setSelectedTurnFile] = useState<TurnFileName>('action.md')
  const [selectedArtifact, setSelectedArtifact] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [filePathLabel, setFilePathLabel] = useState('')
  const [artifacts, setArtifacts] = useState<TurnArtifactMeta[]>([])

  useEffect(() => {
    if (turns.length === 0) {
      setSelectedTurn(null)
      return
    }
    const hasSelected = turns.some((t) => t.turnNumber === selectedTurn)
    if (!hasSelected) {
      setSelectedTurn(turns[turns.length - 1]?.turnNumber ?? null)
    }
  }, [turns, selectedTurn])

  useEffect(() => {
    if (!selectedTurn || !canOperate) {
      setArtifacts([])
      return
    }
    api.yoloListTurnArtifacts(selectedTurn).then(setArtifacts).catch(() => setArtifacts([]))
  }, [api, selectedTurn, canOperate])

  useEffect(() => {
    if (!selectedTurn || !canOperate) {
      setFileContent('')
      setFilePathLabel('')
      return
    }

    if (selectedArtifact) {
      api.yoloReadArtifactFile(selectedTurn, selectedArtifact).then((payload) => {
        setFileContent(payload.exists ? payload.content : '(artifact not found)')
        setFilePathLabel(payload.relativePath)
      }).catch(() => setFileContent('(error)'))
    } else {
      api.yoloReadTurnFile(selectedTurn, selectedTurnFile).then((payload) => {
        setFileContent(payload.exists ? payload.content : '(file not found)')
        setFilePathLabel(payload.relativePath)
      }).catch(() => setFileContent('(error)'))
    }
  }, [api, selectedTurn, selectedTurnFile, selectedArtifact, canOperate])

  const selectedTurnObject = useMemo(
    () => turns.find((t) => t.turnNumber === selectedTurn) ?? null,
    [selectedTurn, turns]
  )

  const selectTurn = useCallback((num: number) => {
    setSelectedTurn(num)
    setSelectedArtifact('')
  }, [])

  const selectFile = useCallback((f: TurnFileName) => {
    setSelectedArtifact('')
    setSelectedTurnFile(f)
  }, [])

  return (
    <div className="flex h-full flex-col overflow-auto p-4 gap-4">
      {/* PROJECT.md — full width primary */}
      <section className="shrink-0 rounded-lg border p-4 t-card-teal">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-teal)' }}>
          PROJECT.md
        </h3>
        <pre
          className="md-prose max-h-[360px] overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed"
          style={{ background: 'var(--color-bg-base)', borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          {projectMarkdown || '(empty)'}
        </pre>
      </section>

      {/* Turn browser — V1 rounded-lg card */}
      <section className="rounded-lg border p-4" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Turn Evidence Browser
        </h3>

        {/* Turn chips — horizontal scroll with status dots */}
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {turns.length === 0 && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No turns yet.</span>}
          {turns.map((turn) => {
            const isSelected = turn.turnNumber === selectedTurn
            const statusColor = turn.status.toLowerCase() === 'success' ? 'var(--color-accent-emerald)'
              : turn.status.toLowerCase() === 'failure' || turn.status.toLowerCase() === 'blocked' ? 'var(--color-accent-rose)'
              : turn.status.toLowerCase() === 'ask_user' ? 'var(--color-accent-amber)'
              : 'var(--color-text-muted)'
            return (
              <button
                key={turn.turnNumber}
                type="button"
                onClick={() => selectTurn(turn.turnNumber)}
                className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors"
                style={isSelected
                  ? { background: 'var(--color-accent)', color: '#fff' }
                  : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                }
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: isSelected ? '#fff' : statusColor }}
                />
                {turn.turnNumber.toString().padStart(4, '0')}
              </button>
            )
          })}
        </div>

        {/* File content area */}
        {selectedTurnObject && (
          <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
            {/* Left: file tabs + artifacts + summary */}
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Turn Files
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TURN_FILES.map((f) => {
                    const isActive = !selectedArtifact && selectedTurnFile === f
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => selectFile(f)}
                        className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                        style={isActive
                          ? { background: 'var(--color-action-turn)', color: '#fff' }
                          : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                        }
                      >
                        {f}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Artifacts
                </div>
                <div className="max-h-[120px] space-y-1 overflow-auto">
                  {artifacts.length === 0 && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>None</div>}
                  {artifacts.map((a) => {
                    const isActive = selectedArtifact === a.name
                    return (
                      <button
                        key={a.name}
                        type="button"
                        onClick={() => setSelectedArtifact(a.name)}
                        className="block w-full truncate rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors"
                        style={isActive
                          ? { background: 'var(--color-action-loop)', color: '#fff' }
                          : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                        }
                      >
                        {a.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Turn summary — V1 card style */}
              <div className="rounded-lg border p-3 t-card-emerald">
                <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneForStatus(selectedTurnObject.status)}`}>
                  {selectedTurnObject.status}
                </span>
                <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {selectedTurnObject.summary}
                </p>
              </div>
            </div>

            {/* Right: file content viewer */}
            <div className="min-w-0">
              <div
                className="mb-2 rounded-lg px-3 py-1.5 text-[11px] font-mono"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
              >
                turn-{selectedTurnObject.turnNumber.toString().padStart(4, '0')} / {selectedArtifact || selectedTurnFile}
                {filePathLabel && <span style={{ color: 'var(--color-text-muted)' }}> — {filePathLabel}</span>}
              </div>
              <pre
                className="max-h-[500px] overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed whitespace-pre-wrap break-words"
                style={{ background: 'var(--color-terminal-bg)', borderColor: 'var(--color-border-subtle)', color: 'var(--color-terminal-text)' }}
              >
                {fileContent || '(no content)'}
              </pre>
            </div>
          </div>
        )}
      </section>

      {/* FAILURES.md — bottom and compact by default */}
      <section className="shrink-0 rounded-lg border p-4 t-card-amber">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-amber)' }}>
          FAILURES.md
        </h3>
        <pre
          className={`md-prose overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed ${
            showExpandedFailures ? 'max-h-[220px]' : 'max-h-[120px]'
          }`}
          style={{ background: 'var(--color-bg-base)', borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          {failuresMarkdown || '(empty)'}
        </pre>
      </section>
    </div>
  )
}
