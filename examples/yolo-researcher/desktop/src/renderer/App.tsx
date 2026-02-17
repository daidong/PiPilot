import { useCallback, useEffect, useMemo, useState } from 'react'

type RuntimeKind = 'host' | 'docker' | 'venv'
type TurnFileName = 'action.md' | 'cmd.txt' | 'stdout.txt' | 'stderr.txt' | 'exit_code.txt' | 'patch.diff' | 'result.json'

interface TurnListItem {
  turnNumber: number
  status: string
  summary: string
  actionPath: string
  turnDir: string
}

interface DesktopOverview {
  projectPath: string
  projectId: string
  goal: string
  model: string
  defaultRuntime: RuntimeKind
  loopRunning: boolean
  hasSession: boolean
  turnCount: number
  lastTurn: TurnListItem | null
}

interface TurnFileContent {
  exists: boolean
  content: string
  relativePath: string
}

interface TurnArtifactMeta {
  name: string
  relativePath: string
  sizeBytes: number
}

interface StartPayload {
  goal: string
  projectId?: string
  model?: string
  defaultRuntime?: RuntimeKind
  autoRun?: boolean
  maxTurns?: number
}

interface DesktopApi {
  getCurrentSession: () => Promise<DesktopOverview>
  pickFolder: () => Promise<DesktopOverview | null>
  closeProject: () => Promise<DesktopOverview>

  yoloStart: (payload: StartPayload) => Promise<DesktopOverview>
  yoloRunTurn: () => Promise<any>
  yoloRunLoop: (maxTurns?: number) => Promise<DesktopOverview>
  yoloStop: () => Promise<DesktopOverview>
  yoloGetOverview: () => Promise<DesktopOverview>

  yoloGetProjectMarkdown: () => Promise<string>
  yoloGetFailuresMarkdown: () => Promise<string>
  yoloListTurns: () => Promise<TurnListItem[]>
  yoloReadTurnFile: (turnNumber: number, fileName: TurnFileName) => Promise<TurnFileContent>
  yoloListTurnArtifacts: (turnNumber: number) => Promise<TurnArtifactMeta[]>
  yoloReadArtifactFile: (turnNumber: number, fileName: string) => Promise<TurnFileContent>

  onYoloEvent: (cb: (payload: any) => void) => () => void
  onYoloTurnResult: (cb: (payload: any) => void) => () => void
  onProjectClosed: (cb: () => void) => () => void
}

interface UiEvent {
  id: string
  at: string
  text: string
}

const TURN_FILES: TurnFileName[] = ['action.md', 'stdout.txt', 'stderr.txt', 'cmd.txt', 'exit_code.txt', 'result.json', 'patch.diff']
const DEFAULT_MAX_LOOP_TURNS = 8

function nowLabel(): string {
  return new Date().toLocaleTimeString()
}

function toneForStatus(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'success') return 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
  if (normalized === 'failure' || normalized === 'blocked') return 'border-rose-400/50 bg-rose-500/10 text-rose-200'
  if (normalized === 'ask_user') return 'border-amber-400/50 bg-amber-500/10 text-amber-200'
  if (normalized === 'stopped') return 'border-sky-400/50 bg-sky-500/10 text-sky-200'
  return 'border-zinc-500/50 bg-zinc-500/10 text-zinc-200'
}

export default function App() {
  const api = window.api

  const [overview, setOverview] = useState<DesktopOverview | null>(null)
  const [projectMarkdown, setProjectMarkdown] = useState('')
  const [failuresMarkdown, setFailuresMarkdown] = useState('')
  const [turns, setTurns] = useState<TurnListItem[]>([])
  const [artifacts, setArtifacts] = useState<TurnArtifactMeta[]>([])

  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [selectedTurnFile, setSelectedTurnFile] = useState<TurnFileName>('action.md')
  const [selectedArtifact, setSelectedArtifact] = useState<string>('')
  const [fileContent, setFileContent] = useState('')
  const [filePathLabel, setFilePathLabel] = useState('')

  const [goalDraft, setGoalDraft] = useState('')
  const [projectIdDraft, setProjectIdDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('gpt-5-mini')
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeKind>('host')
  const [autoRun, setAutoRun] = useState(true)
  const [maxLoopTurns, setMaxLoopTurns] = useState(DEFAULT_MAX_LOOP_TURNS)

  const [events, setEvents] = useState<UiEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const canOperate = Boolean(overview?.projectPath)
  const canRunTurns = canOperate && Boolean(overview?.hasSession)

  const appendEvent = useCallback((text: string) => {
    setEvents((prev) => {
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: nowLabel(),
          text
        },
        ...prev
      ]
      return next.slice(0, 140)
    })
  }, [])

  const clearSessionView = useCallback(() => {
    setProjectMarkdown('')
    setFailuresMarkdown('')
    setTurns([])
    setArtifacts([])
    setSelectedTurn(null)
    setFileContent('')
    setFilePathLabel('')
  }, [])

  const refreshCore = useCallback(async () => {
    const current = await api.getCurrentSession()
    setOverview(current)

    if (!current.projectPath || !current.projectId) {
      clearSessionView()
      return current
    }

    const [projectMd, failuresMd, turnList] = await Promise.all([
      api.yoloGetProjectMarkdown(),
      api.yoloGetFailuresMarkdown(),
      api.yoloListTurns()
    ])

    setProjectMarkdown(projectMd)
    setFailuresMarkdown(failuresMd)
    setTurns(turnList)

    const inferredSelected = turnList.some((item) => item.turnNumber === selectedTurn)
      ? selectedTurn
      : (turnList[turnList.length - 1]?.turnNumber ?? null)
    setSelectedTurn(inferredSelected)

    if (!goalDraft.trim()) {
      setGoalDraft(current.goal)
    }
    if (!projectIdDraft.trim()) {
      setProjectIdDraft(current.projectId || 'research-v2')
    }

    return current
  }, [api, clearSessionView, goalDraft, projectIdDraft, selectedTurn])

  const loadTurnArtifacts = useCallback(async (turnNumber: number | null) => {
    if (!turnNumber || !canOperate) {
      setArtifacts([])
      setSelectedArtifact('')
      return
    }

    const items = await api.yoloListTurnArtifacts(turnNumber)
    setArtifacts(items)
    if (!items.some((item) => item.name === selectedArtifact)) {
      setSelectedArtifact('')
    }
  }, [api, canOperate, selectedArtifact])

  const loadTurnFile = useCallback(async (turnNumber: number | null, fileName: TurnFileName) => {
    if (!turnNumber || !canOperate) {
      setFileContent('')
      setFilePathLabel('')
      return
    }

    const payload = await api.yoloReadTurnFile(turnNumber, fileName)
    setFileContent(payload.exists ? payload.content : '(file not found)')
    setFilePathLabel(payload.relativePath)
  }, [api, canOperate])

  const loadArtifactFile = useCallback(async (turnNumber: number | null, fileName: string) => {
    if (!turnNumber || !canOperate || !fileName) {
      setFileContent('')
      setFilePathLabel('')
      return
    }

    const payload = await api.yoloReadArtifactFile(turnNumber, fileName)
    setFileContent(payload.exists ? payload.content : '(artifact not found)')
    setFilePathLabel(payload.relativePath)
  }, [api, canOperate])

  useEffect(() => {
    let active = true

    const boot = async () => {
      try {
        const current = await refreshCore()
        if (!active) return
        if (current.projectPath) {
          appendEvent(`Loaded project: ${current.projectPath}`)
        }
      } catch (err) {
        if (!active) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
      }
    }

    void boot()

    const offEvent = api.onYoloEvent((payload) => {
      const type = payload?.type ? String(payload.type) : 'event'
      appendEvent(`${type}${payload?.summary ? `: ${payload.summary}` : ''}`)
      void refreshCore().catch(() => undefined)
    })

    const offTurn = api.onYoloTurnResult((payload) => {
      const turnNumber = payload?.turnNumber ?? '?'
      const status = payload?.status ?? 'unknown'
      appendEvent(`turn ${turnNumber} -> ${status}`)
      void refreshCore().catch(() => undefined)
    })

    const offClosed = api.onProjectClosed(() => {
      appendEvent('project closed')
      setOverview(null)
      clearSessionView()
      setGoalDraft('')
      setProjectIdDraft('')
    })

    return () => {
      active = false
      offEvent()
      offTurn()
      offClosed()
    }
  }, [api, appendEvent, clearSessionView, refreshCore])

  useEffect(() => {
    void loadTurnArtifacts(selectedTurn)
    if (!selectedArtifact) {
      void loadTurnFile(selectedTurn, selectedTurnFile)
    }
  }, [loadTurnArtifacts, loadTurnFile, selectedTurn, selectedTurnFile, selectedArtifact])

  useEffect(() => {
    if (!selectedArtifact) return
    void loadArtifactFile(selectedTurn, selectedArtifact)
  }, [loadArtifactFile, selectedArtifact, selectedTurn])

  const startSession = useCallback(async () => {
    if (!canOperate) return
    if (!goalDraft.trim()) {
      setError('Goal is required.')
      return
    }

    setBusy(true)
    setError('')
    try {
      const payload: StartPayload = {
        goal: goalDraft,
        projectId: projectIdDraft,
        model: modelDraft,
        defaultRuntime: runtimeDraft,
        autoRun,
        maxTurns: maxLoopTurns
      }
      const next = await api.yoloStart(payload)
      setOverview(next)
      appendEvent(`session started (${next.projectId})`)
      await refreshCore()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, autoRun, canOperate, goalDraft, maxLoopTurns, modelDraft, projectIdDraft, refreshCore, runtimeDraft])

  const runOneTurn = useCallback(async () => {
    if (!canRunTurns) return
    setBusy(true)
    setError('')
    try {
      await api.yoloRunTurn()
      await refreshCore()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, canRunTurns, refreshCore])

  const runBatch = useCallback(async () => {
    if (!canRunTurns) return
    setBusy(true)
    setError('')
    try {
      await api.yoloRunLoop(maxLoopTurns)
      await refreshCore()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, canRunTurns, maxLoopTurns, refreshCore])

  const requestStop = useCallback(async () => {
    if (!canRunTurns) return
    setBusy(true)
    setError('')
    try {
      await api.yoloStop()
      appendEvent('stop requested')
      await refreshCore()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, canRunTurns, refreshCore])

  const pickFolder = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.pickFolder()
      if (result) {
        setOverview(result)
        setProjectIdDraft(result.projectId || 'research-v2')
        setGoalDraft(result.goal || '')
        appendEvent(`folder selected: ${result.projectPath}`)
        await refreshCore()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, refreshCore])

  const closeProject = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.closeProject()
      setOverview(result)
      clearSessionView()
      setGoalDraft('')
      setProjectIdDraft('')
      appendEvent('project closed')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, clearSessionView])

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await refreshCore()
      appendEvent('manual refresh')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [appendEvent, refreshCore])

  const selectedTurnObject = useMemo(() => turns.find((item) => item.turnNumber === selectedTurn) ?? null, [selectedTurn, turns])

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_12%_12%,rgba(16,185,129,0.22),transparent_34%),radial-gradient(circle_at_88%_0%,rgba(245,158,11,0.18),transparent_34%),radial-gradient(circle_at_50%_100%,rgba(14,116,144,0.24),transparent_40%),#09090b] text-zinc-100">
      <div className="mx-auto max-w-[1500px] px-4 py-4 md:px-6 md:py-6">
        <header className="mb-4 rounded-3xl border border-zinc-700/70 bg-zinc-950/70 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300">YOLO Researcher v2</p>
              <h1 className="mt-1 text-3xl leading-none text-zinc-50 md:text-4xl" style={{ fontFamily: 'Playfair Display, serif' }}>
                Evidence Deck
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-zinc-300">
                Minimal discipline to avoid dead loops. Every fact points to raw evidence under <code>runs/turn-xxxx/</code>.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={pickFolder}
                disabled={busy}
                className="rounded-xl border border-zinc-600 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 hover:border-emerald-400 disabled:opacity-60"
              >
                Pick Folder
              </button>
              <button
                type="button"
                onClick={refresh}
                disabled={busy || !canOperate}
                className="rounded-xl border border-zinc-600 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 hover:border-sky-400 disabled:opacity-60"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={closeProject}
                disabled={busy || !canOperate}
                className="rounded-xl border border-zinc-600 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 hover:border-rose-400 disabled:opacity-60"
              >
                Close
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 text-xs text-zinc-300 md:grid-cols-4">
            <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/60 px-3 py-2">
              <div className="text-zinc-500">Project</div>
              <div className="truncate text-zinc-100">{overview?.projectPath || '(none)'}</div>
            </div>
            <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/60 px-3 py-2">
              <div className="text-zinc-500">Project ID</div>
              <div className="text-zinc-100">{overview?.projectId || '-'}</div>
            </div>
            <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/60 px-3 py-2">
              <div className="text-zinc-500">Turns</div>
              <div className="text-zinc-100">{overview?.turnCount ?? 0}</div>
            </div>
            <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/60 px-3 py-2">
              <div className="text-zinc-500">Loop</div>
              <div className="text-zinc-100">{overview?.loopRunning ? 'Running' : 'Idle'}</div>
            </div>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-2xl border border-rose-400/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <main className="grid gap-4 xl:grid-cols-[360px_1fr]">
          <section className="space-y-4">
            <article className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
              <h2 className="mb-3 text-sm uppercase tracking-[0.18em] text-zinc-400">Session Control</h2>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Goal</label>
                  <textarea
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                    placeholder="Describe the research objective..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Project ID</label>
                    <input
                      value={projectIdDraft}
                      onChange={(event) => setProjectIdDraft(event.target.value)}
                      placeholder="research-v2"
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Model</label>
                    <input
                      value={modelDraft}
                      onChange={(event) => setModelDraft(event.target.value)}
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Runtime</label>
                    <select
                      value={runtimeDraft}
                      onChange={(event) => setRuntimeDraft(event.target.value as RuntimeKind)}
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                    >
                      <option value="host">host</option>
                      <option value="docker">docker</option>
                      <option value="venv">venv</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Max loop turns</label>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={maxLoopTurns}
                      onChange={(event) => setMaxLoopTurns(Number(event.target.value) || 1)}
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={autoRun}
                    onChange={(event) => setAutoRun(event.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                  />
                  Auto-run immediately after start
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={startSession}
                    disabled={busy || !canOperate}
                    className="rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    Start / Rebind
                  </button>
                  <button
                    type="button"
                    onClick={runOneTurn}
                    disabled={busy || !canRunTurns}
                    className="rounded-xl border border-sky-400/50 bg-sky-500/15 px-3 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/25 disabled:opacity-50"
                  >
                    Run One Turn
                  </button>
                  <button
                    type="button"
                    onClick={runBatch}
                    disabled={busy || !canRunTurns}
                    className="rounded-xl border border-amber-400/50 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    Run Loop
                  </button>
                  <button
                    type="button"
                    onClick={requestStop}
                    disabled={busy || !canRunTurns}
                    className="rounded-xl border border-rose-400/50 bg-rose-500/15 px-3 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
                  >
                    Stop Loop
                  </button>
                </div>
              </div>
            </article>

            <article className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
              <h2 className="mb-3 text-sm uppercase tracking-[0.18em] text-zinc-400">Live Events</h2>
              <div className="max-h-[360px] space-y-2 overflow-auto pr-1 text-xs">
                {events.length === 0 && <div className="text-zinc-500">No events yet.</div>}
                {events.map((item) => (
                  <div key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                    <div className="text-zinc-500">{item.at}</div>
                    <div className="mt-1 text-zinc-200">{item.text}</div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
              <h2 className="mb-3 text-sm uppercase tracking-[0.18em] text-zinc-400">PROJECT.md</h2>
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 text-[12px] leading-5 text-zinc-100">
                {projectMarkdown || '(empty)'}
              </pre>
            </article>

            <article className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
              <h2 className="mb-3 text-sm uppercase tracking-[0.18em] text-zinc-400">FAILURES.md</h2>
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 text-[12px] leading-5 text-zinc-100">
                {failuresMarkdown || '(empty)'}
              </pre>
            </article>

            <article className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4 xl:col-span-2">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm uppercase tracking-[0.18em] text-zinc-400">Turn Evidence Browser</h2>
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <span>Selected turn</span>
                  <select
                    value={selectedTurn ?? ''}
                    onChange={(event) => setSelectedTurn(event.target.value ? Number(event.target.value) : null)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  >
                    {turns.length === 0 && <option value="">(none)</option>}
                    {turns.map((turn) => (
                      <option key={turn.turnNumber} value={turn.turnNumber}>
                        {`turn-${turn.turnNumber.toString().padStart(4, '0')}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
                <div className="space-y-3">
                  <div className="max-h-[220px] space-y-2 overflow-auto pr-1">
                    {turns.map((turn) => (
                      <button
                        key={turn.turnNumber}
                        type="button"
                        onClick={() => {
                          setSelectedTurn(turn.turnNumber)
                          setSelectedArtifact('')
                        }}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition ${turn.turnNumber === selectedTurn
                          ? 'border-emerald-400/60 bg-emerald-500/10'
                          : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-600'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-zinc-100">{`turn-${turn.turnNumber.toString().padStart(4, '0')}`}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${toneForStatus(turn.status)}`}>
                            {turn.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-400">{turn.summary}</p>
                      </button>
                    ))}
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">Turn Files</div>
                    <div className="flex flex-wrap gap-1">
                      {TURN_FILES.map((fileName) => (
                        <button
                          key={fileName}
                          type="button"
                          onClick={() => {
                            setSelectedArtifact('')
                            setSelectedTurnFile(fileName)
                          }}
                          className={`rounded-lg border px-2 py-1 text-[11px] ${selectedArtifact === '' && selectedTurnFile === fileName
                            ? 'border-sky-400/60 bg-sky-500/15 text-sky-100'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'}`}
                        >
                          {fileName}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">Artifacts</div>
                    <div className="max-h-[120px] space-y-1 overflow-auto pr-1">
                      {artifacts.length === 0 && <div className="text-xs text-zinc-500">No artifacts</div>}
                      {artifacts.map((artifact) => (
                        <button
                          key={artifact.name}
                          type="button"
                          onClick={() => setSelectedArtifact(artifact.name)}
                          className={`block w-full truncate rounded-lg border px-2 py-1 text-left text-[11px] ${selectedArtifact === artifact.name
                            ? 'border-amber-400/60 bg-amber-500/15 text-amber-100'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'}`}
                        >
                          {artifact.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-2 rounded-xl border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                    {selectedTurnObject
                      ? `Viewing turn-${selectedTurnObject.turnNumber.toString().padStart(4, '0')} · ${selectedArtifact || selectedTurnFile}`
                      : 'Select a turn to inspect evidence files.'}
                    {filePathLabel ? ` · ${filePathLabel}` : ''}
                  </div>
                  <pre className="max-h-[560px] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/85 p-3 text-[12px] leading-5 text-zinc-100">
                    {fileContent || '(no content)'}
                  </pre>
                </div>
              </div>
            </article>
          </section>
        </main>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
