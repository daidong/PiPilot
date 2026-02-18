import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopOverview, TurnArtifactMeta, TurnFileName, TurnListItem } from '../lib/types'
import { TURN_FILES, toneForStatus } from '../lib/types'

interface EvidenceViewProps {
  overview: DesktopOverview | null
  turns: TurnListItem[]
  projectMarkdown: string
  failuresMarkdown: string
}

interface HighlightArtifact extends TurnArtifactMeta {
  turnNumber: number
  score: number
  reason: string
}

interface TurnResultMeta {
  turnNumber?: number
  status?: string
  summary?: string
  activePlanId?: string
  statusChange?: string
  delta?: string
  blockedReason?: string
  planAttributionReason?: string
  planAttributionAmbiguous?: boolean
  plannerCheckpointDue?: boolean
  plannerCheckpointReasons?: string[]
}

const HIGHLIGHT_SCAN_TURNS = 20
const ARTIFACT_SCORING_RULES: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /summary\.json$/i, score: 120, reason: 'Summary' },
  { pattern: /related[_-]?work|literature|reading[_-]?list|citation/i, score: 108, reason: 'Literature' },
  { pattern: /experiment|baseline|protocol|benchmark/i, score: 102, reason: 'Experiment' },
  { pattern: /hookpoint|insertion|telemetry|roadmap|plan/i, score: 94, reason: 'Roadmap' },
  { pattern: /patch|diff|integration|implementation/i, score: 86, reason: 'Implementation' },
  { pattern: /insight|idea|analysis|finding|result/i, score: 80, reason: 'Findings' }
]

function hasMeaningfulFailures(markdown: string): boolean {
  const normalized = markdown.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes('- none.')) return false
  return true
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readStringField(data: Record<string, unknown> | null, key: string): string | undefined {
  if (!data) return undefined
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function readBooleanField(data: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!data) return undefined
  const value = data[key]
  return typeof value === 'boolean' ? value : undefined
}

function readStringListField(data: Record<string, unknown> | null, key: string): string[] {
  if (!data) return []
  const value = data[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatReasonToken(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim()
}

function scoreArtifactName(name: string): { score: number; reason: string } {
  for (const rule of ARTIFACT_SCORING_RULES) {
    if (rule.pattern.test(name)) return { score: rule.score, reason: rule.reason }
  }
  if (/\.md$/i.test(name)) return { score: 40, reason: 'Notes' }
  if (/\.json$/i.test(name)) return { score: 32, reason: 'Data' }
  return { score: 0, reason: 'Artifact' }
}

function normalizedTurnStatus(status: string, partial?: boolean): string {
  if (partial && (!status || status.toLowerCase() === 'unknown')) return 'partial'
  const normalized = (status || 'unknown').toLowerCase()
  if (normalized === 'ask_user') return 'paused'
  return normalized
}

function statusDotColor(status: string, partial?: boolean): string {
  const normalized = normalizedTurnStatus(status, partial)
  if (normalized === 'success') return 'var(--color-accent-emerald)'
  if (normalized === 'failure' || normalized === 'blocked') return 'var(--color-accent-rose)'
  if (normalized === 'paused' || normalized === 'no_delta') return 'var(--color-accent-amber)'
  if (normalized === 'partial' || normalized === 'stopped') return 'var(--color-accent-sky)'
  return 'var(--color-text-muted)'
}

function truncateText(text: string, max = 180): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
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
  const [highlights, setHighlights] = useState<HighlightArtifact[]>([])
  const [milestones, setMilestones] = useState<TurnResultMeta[]>([])
  const [selectedResultMeta, setSelectedResultMeta] = useState<TurnResultMeta | null>(null)

  const selectedTurnObject = useMemo(
    () => turns.find((t) => t.turnNumber === selectedTurn) ?? null,
    [selectedTurn, turns]
  )

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
      setSelectedResultMeta(null)
      return
    }

    let active = true
    api.yoloReadTurnFile(selectedTurn, 'result.json')
      .then((payload) => {
        if (!active) return
        if (!payload.exists) {
          setSelectedResultMeta({
            status: selectedTurnObject?.status ?? 'unknown',
            summary: selectedTurnObject?.summary ?? 'No summary.'
          })
          return
        }

        const parsed = parseJsonObject(payload.content)
        setSelectedResultMeta({
          status: readStringField(parsed, 'status') ?? selectedTurnObject?.status ?? 'unknown',
          summary: readStringField(parsed, 'summary') ?? selectedTurnObject?.summary ?? 'No summary.',
          activePlanId: readStringField(parsed, 'active_plan_id'),
          statusChange: readStringField(parsed, 'status_change'),
          delta: readStringField(parsed, 'delta'),
          blockedReason: readStringField(parsed, 'blocked_reason'),
          planAttributionReason: readStringField(parsed, 'plan_attribution_reason'),
          planAttributionAmbiguous: readBooleanField(parsed, 'plan_attribution_ambiguous'),
          plannerCheckpointDue: readBooleanField(parsed, 'planner_checkpoint_due'),
          plannerCheckpointReasons: readStringListField(parsed, 'planner_checkpoint_reasons')
        })
      })
      .catch(() => {
        if (!active) return
        setSelectedResultMeta({
          status: selectedTurnObject?.status ?? 'unknown',
          summary: selectedTurnObject?.summary ?? 'No summary.'
        })
      })

    return () => {
      active = false
    }
  }, [api, canOperate, selectedTurn, selectedTurnObject?.status, selectedTurnObject?.summary])

  useEffect(() => {
    if (!canOperate || turns.length === 0) {
      setHighlights([])
      setMilestones([])
      return
    }

    let active = true
    const recentTurns = turns.slice(-HIGHLIGHT_SCAN_TURNS)

    Promise.all(recentTurns.map(async (turn) => {
      const [turnArtifacts, turnResult] = await Promise.all([
        api.yoloListTurnArtifacts(turn.turnNumber).catch(() => [] as TurnArtifactMeta[]),
        api.yoloReadTurnFile(turn.turnNumber, 'result.json').catch(() => ({ exists: false, content: '', relativePath: '' }))
      ])

      return {
        turn,
        turnArtifacts,
        parsedResult: turnResult.exists ? parseJsonObject(turnResult.content) : null
      }
    })).then((rows) => {
      if (!active) return

      const byName = new Map<string, HighlightArtifact>()
      const nextMilestones: TurnResultMeta[] = []

      for (const row of rows) {
        const status = readStringField(row.parsedResult, 'status') ?? normalizedTurnStatus(row.turn.status, row.turn.partial)
        const summary = readStringField(row.parsedResult, 'summary') ?? row.turn.summary
        nextMilestones.push({
          turnNumber: row.turn.turnNumber,
          status,
          summary,
          activePlanId: readStringField(row.parsedResult, 'active_plan_id'),
          statusChange: readStringField(row.parsedResult, 'status_change'),
          delta: readStringField(row.parsedResult, 'delta'),
          blockedReason: readStringField(row.parsedResult, 'blocked_reason'),
          planAttributionReason: readStringField(row.parsedResult, 'plan_attribution_reason'),
          planAttributionAmbiguous: readBooleanField(row.parsedResult, 'plan_attribution_ambiguous'),
          plannerCheckpointDue: readBooleanField(row.parsedResult, 'planner_checkpoint_due'),
          plannerCheckpointReasons: readStringListField(row.parsedResult, 'planner_checkpoint_reasons')
        })

        for (const artifact of row.turnArtifacts) {
          const { score, reason } = scoreArtifactName(artifact.name)
          if (score <= 0) continue

          const key = `${reason}:${artifact.name}`
          const candidate: HighlightArtifact = {
            ...artifact,
            turnNumber: row.turn.turnNumber,
            score,
            reason
          }
          const current = byName.get(key)
          if (
            !current
            || candidate.score > current.score
            || (candidate.score === current.score && candidate.turnNumber > current.turnNumber)
          ) {
            byName.set(key, candidate)
          }
        }
      }

      const sortedHighlights = Array.from(byName.values())
        .sort((a, b) => b.score - a.score || b.turnNumber - a.turnNumber || a.name.localeCompare(b.name))
        .slice(0, 10)

      setHighlights(sortedHighlights)
      setMilestones(nextMilestones.slice(-10).reverse())
    }).catch(() => {
      if (!active) return
      setHighlights([])
      setMilestones([])
    })

    return () => {
      active = false
    }
  }, [api, canOperate, turns])

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
      }).catch(() => {
        setFileContent('(error)')
        setFilePathLabel('')
      })
    } else {
      api.yoloReadTurnFile(selectedTurn, selectedTurnFile).then((payload) => {
        setFileContent(payload.exists ? payload.content : '(file not found)')
        setFilePathLabel(payload.relativePath)
      }).catch(() => {
        setFileContent('(error)')
        setFilePathLabel('')
      })
    }
  }, [api, selectedTurn, selectedTurnFile, selectedArtifact, canOperate])

  const recommendedArtifacts = useMemo(() => {
    return artifacts
      .map((artifact) => {
        const scored = scoreArtifactName(artifact.name)
        return { ...artifact, score: scored.score, reason: scored.reason }
      })
      .filter((artifact) => artifact.score > 0)
      .sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name))
      .slice(0, 5)
  }, [artifacts])

  const selectedStatus = normalizedTurnStatus(selectedResultMeta?.status ?? selectedTurnObject?.status ?? 'unknown', selectedTurnObject?.partial)
  const selectedSummary = selectedResultMeta?.summary ?? selectedTurnObject?.summary ?? 'No summary.'

  const selectTurn = useCallback((num: number) => {
    setSelectedTurn(num)
    setSelectedArtifact('')
  }, [])

  const selectFile = useCallback((fileName: TurnFileName) => {
    setSelectedArtifact('')
    setSelectedTurnFile(fileName)
  }, [])

  const openArtifact = useCallback((turnNumber: number, artifactName: string) => {
    setSelectedTurn(turnNumber)
    setSelectedArtifact(artifactName)
  }, [])

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
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

      <section className="shrink-0 rounded-lg border p-4 t-card-sky">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-sky)' }}>
          Progress Highlights
        </h3>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
              Key Artifacts
            </div>
            <div className="max-h-[220px] space-y-1 overflow-auto rounded-lg border p-2" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-base)' }}>
              {highlights.length === 0 && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No highlighted artifacts yet.</div>}
              {highlights.map((artifact) => (
                <button
                  key={`${artifact.turnNumber}:${artifact.name}:${artifact.reason}`}
                  type="button"
                  onClick={() => openArtifact(artifact.turnNumber, artifact.name)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }}
                >
                  <span className="rounded-full border px-1.5 py-0.5 text-[9px]" style={{ borderColor: 'var(--color-border-action)', color: 'var(--color-accent-soft)' }}>
                    {artifact.reason}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    t-{artifact.turnNumber.toString().padStart(4, '0')}
                  </span>
                  <span className="truncate">{artifact.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
              Recent Milestones
            </div>
            <div className="max-h-[220px] space-y-1 overflow-auto rounded-lg border p-2" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-base)' }}>
              {turns.length === 0 && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No milestones yet.</div>}
              {turns.slice(-10).reverse().map((turn, index) => {
                const milestone = milestones.find((item) => item.turnNumber === turn.turnNumber) ?? milestones[index]
                const status = normalizedTurnStatus(milestone?.status ?? turn.status, turn.partial)
                return (
                  <button
                    key={turn.turnNumber}
                    type="button"
                    onClick={() => selectTurn(turn.turnNumber)}
                    className="w-full rounded-md border px-2.5 py-1.5 text-left transition-colors"
                    style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-elevated)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
                        turn-{turn.turnNumber.toString().padStart(4, '0')}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneForStatus(status)}`}>{status}</span>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
                      {truncateText(milestone?.summary ?? turn.summary, 140)}
                    </div>
                    {(milestone?.activePlanId || milestone?.statusChange || milestone?.planAttributionReason || milestone?.blockedReason || (milestone?.plannerCheckpointReasons?.length ?? 0) > 0) && (
                      <div className="mt-1 space-y-0.5 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                        {(milestone?.activePlanId || milestone?.statusChange) && (
                          <div>
                            {milestone?.activePlanId ? `plan=${milestone.activePlanId}` : ''}
                            {milestone?.activePlanId && milestone?.statusChange ? ' · ' : ''}
                            {milestone?.statusChange ? `change=${milestone.statusChange}` : ''}
                          </div>
                        )}
                        {milestone?.planAttributionReason && (
                          <div>
                            attribution={formatReasonToken(milestone.planAttributionReason)}
                            {milestone.planAttributionAmbiguous ? ' (ambiguous)' : ''}
                          </div>
                        )}
                        {milestone?.blockedReason && (
                          <div>reject={formatReasonToken(milestone.blockedReason)}</div>
                        )}
                        {(milestone?.plannerCheckpointReasons?.length ?? 0) > 0 && (
                          <div>
                            checkpoint={milestone?.plannerCheckpointDue ? 'due' : 'guard'}:{' '}
                            {milestone?.plannerCheckpointReasons?.slice(0, 2).map(formatReasonToken).join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border p-4" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Turn Evidence Browser
        </h3>

        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {turns.length === 0 && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No turns yet.</span>}
          {turns.map((turn) => {
            const isSelected = turn.turnNumber === selectedTurn
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
                title={turn.partial ? 'partial turn' : undefined}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: isSelected ? '#fff' : statusDotColor(turn.status, turn.partial) }}
                />
                {turn.turnNumber.toString().padStart(4, '0')}
                {turn.partial && <span className="text-[9px]" style={{ color: isSelected ? '#fff' : 'var(--color-accent-sky)' }}>partial</span>}
              </button>
            )
          })}
        </div>

        {selectedTurnObject && (
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Turn Files
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TURN_FILES.map((fileName) => {
                    const isActive = !selectedArtifact && selectedTurnFile === fileName
                    return (
                      <button
                        key={fileName}
                        type="button"
                        onClick={() => selectFile(fileName)}
                        className="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                        style={isActive
                          ? { background: 'var(--color-action-turn)', color: '#fff' }
                          : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                        }
                      >
                        {fileName}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  Recommended Artifacts
                </div>
                <div className="max-h-[130px] space-y-1 overflow-auto rounded-lg border p-2" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-base)' }}>
                  {recommendedArtifacts.length === 0 && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No highlighted artifacts for this turn.</div>}
                  {recommendedArtifacts.map((artifact) => {
                    const isActive = selectedArtifact === artifact.name
                    return (
                      <button
                        key={`recommended:${artifact.name}`}
                        type="button"
                        onClick={() => setSelectedArtifact(artifact.name)}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors"
                        style={isActive
                          ? { background: 'var(--color-action-loop)', color: '#fff' }
                          : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                        }
                      >
                        <span className="rounded-full border px-1.5 py-0.5 text-[9px]" style={{ borderColor: 'var(--color-border-action)', color: isActive ? '#fff' : 'var(--color-accent-soft)' }}>
                          {artifact.reason}
                        </span>
                        <span className="truncate">{artifact.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  All Artifacts
                </div>
                <div className="max-h-[150px] space-y-1 overflow-auto">
                  {artifacts.length === 0 && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>None</div>}
                  {artifacts.map((artifact) => {
                    const isActive = selectedArtifact === artifact.name
                    return (
                      <button
                        key={artifact.name}
                        type="button"
                        onClick={() => setSelectedArtifact(artifact.name)}
                        className="block w-full truncate rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors"
                        style={isActive
                          ? { background: 'var(--color-action-loop)', color: '#fff' }
                          : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }
                        }
                      >
                        {artifact.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-lg border p-3 t-card-emerald">
                <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneForStatus(selectedStatus)}`}>
                  {selectedStatus}
                </span>
                <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {selectedSummary}
                </p>
                {(selectedResultMeta?.activePlanId
                  || selectedResultMeta?.statusChange
                  || selectedResultMeta?.delta
                  || selectedResultMeta?.planAttributionReason
                  || selectedResultMeta?.blockedReason
                  || (selectedResultMeta?.plannerCheckpointReasons?.length ?? 0) > 0
                ) && (
                  <div className="mt-2 space-y-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    {selectedResultMeta?.activePlanId && <div>plan: {selectedResultMeta.activePlanId}</div>}
                    {selectedResultMeta?.statusChange && <div>change: {selectedResultMeta.statusChange}</div>}
                    {selectedResultMeta?.delta && <div>delta: {truncateText(selectedResultMeta.delta, 120)}</div>}
                    {selectedResultMeta?.planAttributionReason && (
                      <div>
                        attribution: {formatReasonToken(selectedResultMeta.planAttributionReason)}
                        {selectedResultMeta.planAttributionAmbiguous ? ' (ambiguous)' : ''}
                      </div>
                    )}
                    {selectedResultMeta?.blockedReason && (
                      <div>reject: {formatReasonToken(selectedResultMeta.blockedReason)}</div>
                    )}
                    {(selectedResultMeta?.plannerCheckpointReasons?.length ?? 0) > 0 && (
                      <div>
                        checkpoint: {selectedResultMeta?.plannerCheckpointDue ? 'due' : 'guard'} ({selectedResultMeta?.plannerCheckpointReasons?.map(formatReasonToken).join(', ')})
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="mb-2 rounded-lg px-3 py-1.5 text-[11px] font-mono"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
              >
                turn-{selectedTurnObject.turnNumber.toString().padStart(4, '0')} / {selectedArtifact || selectedTurnFile}
                {filePathLabel && <span style={{ color: 'var(--color-text-muted)' }}> — {filePathLabel}</span>}
              </div>
              <pre
                className="max-h-[560px] overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed whitespace-pre-wrap break-words"
                style={{ background: 'var(--color-terminal-bg)', borderColor: 'var(--color-border-subtle)', color: 'var(--color-terminal-text)' }}
              >
                {fileContent || '(no content)'}
              </pre>
            </div>
          </div>
        )}
      </section>

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
