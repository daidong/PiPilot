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
  lastFailedCmd?: string
  lastFailedExitCode?: number
  lastFailedErrorExcerpt?: string
  lastFailureKind?: string
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

function readNumberField(data: Record<string, unknown> | null, key: string): number | undefined {
  if (!data) return undefined
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function statusDotClass(status: string, partial?: boolean): string {
  const normalized = normalizedTurnStatus(status, partial)
  if (normalized === 'success') return 't-dot-success'
  if (normalized === 'failure' || normalized === 'blocked') return 't-dot-danger'
  if (normalized === 'paused' || normalized === 'no_delta') return 't-dot-warning'
  if (normalized === 'partial' || normalized === 'stopped') return 't-dot-info'
  return 't-dot-neutral'
}

function selectableClass(isActive: boolean): string {
  return isActive ? 't-selectable-active' : 't-selectable-idle'
}

function reasonToneClass(isActive: boolean): string {
  return isActive ? 't-text-on-accent' : 't-text-info'
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
  const [projectPanelOpen, setProjectPanelOpen] = useState(false)

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
          plannerCheckpointReasons: readStringListField(parsed, 'planner_checkpoint_reasons'),
          lastFailedCmd: readStringField(parsed, 'last_failed_cmd'),
          lastFailedExitCode: readNumberField(parsed, 'last_failed_exit_code'),
          lastFailedErrorExcerpt: readStringField(parsed, 'last_failed_error_excerpt'),
          lastFailureKind: readStringField(parsed, 'last_failure_kind')
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
          plannerCheckpointReasons: readStringListField(row.parsedResult, 'planner_checkpoint_reasons'),
          lastFailedCmd: readStringField(row.parsedResult, 'last_failed_cmd'),
          lastFailedExitCode: readNumberField(row.parsedResult, 'last_failed_exit_code'),
          lastFailedErrorExcerpt: readStringField(row.parsedResult, 'last_failed_error_excerpt'),
          lastFailureKind: readStringField(row.parsedResult, 'last_failure_kind')
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
      <section className="t-bg-surface t-border shrink-0 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="t-text-muted text-[11px] font-semibold uppercase tracking-wider">
            PROJECT.md
          </h3>
          <button
            type="button"
            onClick={() => setProjectPanelOpen((prev) => !prev)}
            className="t-btn-neutral rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors"
          >
            {projectPanelOpen ? 'Collapse' : 'Expand'}
          </button>
        </div>
        {projectPanelOpen && (
          <pre
            className="md-prose t-bg-base t-border-subtle t-text mt-2 max-h-[360px] overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed"
          >
            {projectMarkdown || '(empty)'}
          </pre>
        )}
      </section>

      <section className="t-bg-surface t-border shrink-0 rounded-lg border p-4">
        <h3 className="t-text-muted mb-3 text-[11px] font-semibold uppercase tracking-wider">
          Progress Highlights
        </h3>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <div className="t-text-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
              Key Artifacts
            </div>
            <div className="t-bg-base t-border-subtle max-h-[220px] space-y-1 overflow-auto rounded-lg border p-2">
              {highlights.length === 0 && <div className="t-text-muted text-[11px]">No highlighted artifacts yet.</div>}
              {highlights.map((artifact) => (
                <button
                  key={`${artifact.turnNumber}:${artifact.name}:${artifact.reason}`}
                  type="button"
                  onClick={() => openArtifact(artifact.turnNumber, artifact.name)}
                  className="t-bg-elevated t-text-secondary flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors"
                >
                  <span className="t-border-action t-text-info rounded-full border px-1.5 py-0.5 text-[9px]">
                    {artifact.reason}
                  </span>
                  <span className="t-text-muted text-[10px]">
                    t-{artifact.turnNumber.toString().padStart(4, '0')}
                  </span>
                  <span className="truncate">{artifact.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="t-text-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
              Recent Milestones
            </div>
            <div className="t-bg-base t-border-subtle max-h-[220px] space-y-1 overflow-auto rounded-lg border p-2">
              {turns.length === 0 && <div className="t-text-muted text-[11px]">No milestones yet.</div>}
              {turns.slice(-10).reverse().map((turn, index) => {
                const milestone = milestones.find((item) => item.turnNumber === turn.turnNumber) ?? milestones[index]
                const status = normalizedTurnStatus(milestone?.status ?? turn.status, turn.partial)
                return (
                  <button
                    key={turn.turnNumber}
                    type="button"
                    onClick={() => selectTurn(turn.turnNumber)}
                    className="t-bg-elevated t-border-subtle w-full rounded-md border px-2.5 py-1.5 text-left transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="t-text-secondary text-[11px] font-semibold">
                        turn-{turn.turnNumber.toString().padStart(4, '0')}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneForStatus(status)}`}>{status}</span>
                    </div>
                    <div className="t-text-secondary mt-1 text-[11px]">
                      {truncateText(milestone?.summary ?? turn.summary, 140)}
                    </div>
                    {(milestone?.activePlanId || milestone?.statusChange || milestone?.planAttributionReason || milestone?.blockedReason || milestone?.lastFailureKind || (milestone?.plannerCheckpointReasons?.length ?? 0) > 0) && (
                      <div className="t-text-muted mt-1 space-y-0.5 text-[10px]">
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
                        {milestone?.lastFailureKind && (
                          <div>
                            failure={formatReasonToken(milestone.lastFailureKind)}
                            {typeof milestone.lastFailedExitCode === 'number' ? ` (exit ${milestone.lastFailedExitCode})` : ''}
                          </div>
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

      <section className="t-bg-surface t-border rounded-lg border p-4">
        <h3 className="t-text-muted mb-3 text-[11px] font-semibold uppercase tracking-wider">
          Turn Evidence Browser
        </h3>

        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {turns.length === 0 && <span className="t-text-muted text-xs">No turns yet.</span>}
          {turns.map((turn) => {
            const isSelected = turn.turnNumber === selectedTurn
            return (
                <button
                  key={turn.turnNumber}
                  type="button"
                  onClick={() => selectTurn(turn.turnNumber)}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${selectableClass(isSelected)}`}
                  title={turn.partial ? 'partial turn' : undefined}
                >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${isSelected ? 't-dot-on-accent' : statusDotClass(turn.status, turn.partial)}`}
                />
                {turn.turnNumber.toString().padStart(4, '0')}
                {turn.partial && <span className={`text-[9px] ${isSelected ? 't-text-on-accent' : 't-text-info'}`}>partial</span>}
              </button>
            )
          })}
        </div>

        {selectedTurnObject && (
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="space-y-4">
              <div>
                <div className="t-text-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
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
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${selectableClass(isActive)}`}
                      >
                        {fileName}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="t-text-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  Recommended Artifacts
                </div>
                <div className="t-bg-base t-border-subtle max-h-[130px] space-y-1 overflow-auto rounded-lg border p-2">
                  {recommendedArtifacts.length === 0 && <div className="t-text-muted text-[11px]">No highlighted artifacts for this turn.</div>}
                  {recommendedArtifacts.map((artifact) => {
                    const isActive = selectedArtifact === artifact.name
                    return (
                      <button
                        key={`recommended:${artifact.name}`}
                        type="button"
                        onClick={() => setSelectedArtifact(artifact.name)}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors ${selectableClass(isActive)}`}
                      >
                        <span className={`t-border-action rounded-full border px-1.5 py-0.5 text-[9px] ${reasonToneClass(isActive)}`}>
                          {artifact.reason}
                        </span>
                        <span className="truncate">{artifact.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="t-text-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  All Artifacts
                </div>
                <div className="max-h-[150px] space-y-1 overflow-auto">
                  {artifacts.length === 0 && <div className="t-text-muted text-[11px]">None</div>}
                  {artifacts.map((artifact) => {
                    const isActive = selectedArtifact === artifact.name
                    return (
                      <button
                        key={artifact.name}
                        type="button"
                        onClick={() => setSelectedArtifact(artifact.name)}
                        className={`block w-full truncate rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors ${selectableClass(isActive)}`}
                      >
                        {artifact.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
                <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneForStatus(selectedStatus)}`}>
                  {selectedStatus}
                </span>
                <p className="t-text-secondary mt-1.5 text-[11px] leading-relaxed">
                  {selectedSummary}
                </p>
                {(selectedResultMeta?.activePlanId
                  || selectedResultMeta?.statusChange
                  || selectedResultMeta?.delta
                  || selectedResultMeta?.planAttributionReason
                  || selectedResultMeta?.blockedReason
                  || selectedResultMeta?.lastFailureKind
                  || (selectedResultMeta?.plannerCheckpointReasons?.length ?? 0) > 0
                ) && (
                  <div className="t-text-muted mt-2 space-y-1 text-[10px]">
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
                    {selectedResultMeta?.lastFailureKind && (
                      <div>
                        failure_kind: {formatReasonToken(selectedResultMeta.lastFailureKind)}
                        {typeof selectedResultMeta.lastFailedExitCode === 'number' ? ` (exit ${selectedResultMeta.lastFailedExitCode})` : ''}
                      </div>
                    )}
                    {selectedResultMeta?.lastFailedCmd && (
                      <div>last_failed_cmd: {truncateText(selectedResultMeta.lastFailedCmd, 120)}</div>
                    )}
                    {selectedResultMeta?.lastFailedErrorExcerpt && (
                      <div>error_excerpt: {truncateText(selectedResultMeta.lastFailedErrorExcerpt, 140)}</div>
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
                className="t-bg-elevated t-text-muted mb-2 rounded-lg px-3 py-1.5 text-[11px] font-mono"
              >
                turn-{selectedTurnObject.turnNumber.toString().padStart(4, '0')} / {selectedArtifact || selectedTurnFile}
                {filePathLabel && <span className="t-text-muted"> — {filePathLabel}</span>}
              </div>
              <pre
                className="t-pre-terminal max-h-[560px] overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed whitespace-pre-wrap break-words"
              >
                {fileContent || '(no content)'}
              </pre>
            </div>
          </div>
        )}
      </section>

      <section className="t-bg-surface t-border shrink-0 rounded-lg border p-4">
        <h3 className="t-text-muted mb-2 text-[11px] font-semibold uppercase tracking-wider">
          FAILURES.md
        </h3>
        <pre
          className={`md-prose overflow-auto rounded-lg border p-4 text-[12px] leading-relaxed ${
            showExpandedFailures ? 'max-h-[220px]' : 'max-h-[120px]'
          } t-pre-panel`}
        >
          {failuresMarkdown || '(empty)'}
        </pre>
      </section>
    </div>
  )
}
