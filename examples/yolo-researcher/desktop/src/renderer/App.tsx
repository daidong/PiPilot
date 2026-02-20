import { useCallback, useEffect, useState } from 'react'
import type {
  DesktopOverview,
  TurnListItem,
  UiEvent,
  ActivityItem,
  TerminalLiveEvent,
  RuntimeKind,
  StartPayload,
  UsageSnapshot,
  UsageEvent
} from './lib/types'
import { DEFAULT_MAX_LOOP_TURNS, nowLabel } from './lib/types'
import StatusBar from './components/StatusBar'
import ControlPanel from './components/ControlPanel'
import MainTabs, { type TabId } from './components/MainTabs'
import EvidenceView from './components/EvidenceView'
import ActivityView from './components/ActivityView'
import TerminalView from './components/TerminalView'
import PauseModal from './components/PauseModal'

interface PendingQuestion {
  turnNumber: number
  question: string
  evidencePath?: string
}

const EMPTY_USAGE: UsageSnapshot = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  totalCost: 0,
  callCount: 0
}

function extractBlockingQuestion(markdown: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) return ''
  const withoutTitle = trimmed.replace(/^#\s*Blocking Question\s*/i, '').trim()
  return withoutTitle || trimmed
}

export default function App() {
  const api = window.api

  const [overview, setOverview] = useState<DesktopOverview | null>(null)
  const [projectMarkdown, setProjectMarkdown] = useState('')
  const [failuresMarkdown, setFailuresMarkdown] = useState('')
  const [turns, setTurns] = useState<TurnListItem[]>([])

  const [goalDraft, setGoalDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('gpt-5.2')
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeKind>('host')
  const [runtimeSystemInfoDraft, setRuntimeSystemInfoDraft] = useState('')
  const [autoRun, setAutoRun] = useState(true)
  const [maxLoopTurns, setMaxLoopTurns] = useState(DEFAULT_MAX_LOOP_TURNS)
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY_USAGE)

  const [events, setEvents] = useState<UiEvent[]>([])
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [terminalEvents, setTerminalEvents] = useState<TerminalLiveEvent[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [queuedInputDraft, setQueuedInputDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [submittingReply, setSubmittingReply] = useState(false)
  const [submittingQueuedInput, setSubmittingQueuedInput] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('evidence')

  const canOperate = Boolean(overview?.projectPath)
  const hasSession = canOperate && Boolean(overview?.hasSession)
  const pausedForUserInput = Boolean(overview?.pausedForUserInput || pendingQuestion)
  const canRunTurns = hasSession && !pausedForUserInput

  const appendEvent = useCallback((text: string) => {
    setEvents((prev) => {
      const next = [{
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: nowLabel(),
        text
      }, ...prev]
      return next.slice(0, 200)
    })
  }, [])

  const resetProjectScopedUi = useCallback(() => {
    setProjectMarkdown('')
    setFailuresMarkdown('')
    setTurns([])
    setActivities([])
    setTerminalEvents([])
    setPendingQuestion(null)
    setReplyDraft('')
    setQueuedInputDraft('')
    setGoalDraft('')
    setRuntimeSystemInfoDraft('')
    setUsage(EMPTY_USAGE)
    setActiveTab('evidence')
  }, [])

  const refreshCore = useCallback(async () => {
    const current = await api.getCurrentSession()
    setOverview(current)

    if (!current.projectPath) {
      resetProjectScopedUi()
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

    const latestTurn = turnList[turnList.length - 1] ?? null
    const latestStatus = latestTurn?.status?.toLowerCase() || ''
    if (!latestTurn || (latestStatus !== 'ask_user' && latestStatus !== 'paused')) {
      setPendingQuestion(null)
    } else {
      try {
        const askArtifact = await api.yoloReadArtifactFile(latestTurn.turnNumber, 'ask-user.md')
        const question = extractBlockingQuestion(askArtifact.content) || latestTurn.summary || 'User input required.'
        setPendingQuestion({
          turnNumber: latestTurn.turnNumber,
          question,
          evidencePath: askArtifact.relativePath || latestTurn.actionPath
        })
      } catch {
        setPendingQuestion({
          turnNumber: latestTurn.turnNumber,
          question: latestTurn.summary || 'User input required.',
          evidencePath: latestTurn.actionPath
        })
      }
    }

    if (!goalDraft.trim()) setGoalDraft(current.goal)
    if (!runtimeSystemInfoDraft.trim()) setRuntimeSystemInfoDraft(current.runtimeSystemInfo || '')
    setUsage(current.usage || EMPTY_USAGE)

    return current
  }, [api, goalDraft, resetProjectScopedUi, runtimeSystemInfoDraft])

  // Boot + event listeners
  useEffect(() => {
    let active = true

    const boot = async () => {
      try {
        const current = await refreshCore()
        if (!active) return
        if (current.projectPath) appendEvent(`Loaded project: ${current.projectPath}`)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void boot()

    const offEvent = api.onYoloEvent((payload) => {
      const type = payload?.type ? String(payload.type) : 'event'
      const turn = typeof payload?.turnNumber === 'number' ? ` turn-${String(payload.turnNumber).padStart(4, '0')}` : ''
      const detail = payload?.summary || payload?.message || payload?.reason || ''
      const intent = payload?.intent ? ` | intent: ${String(payload.intent)}` : ''
      const observation = payload?.observation ? ` | obs: ${String(payload.observation)}` : ''
      appendEvent(`${type}${turn}${detail ? `: ${String(detail)}` : ''}${intent}${observation}`)
      void refreshCore().catch(() => undefined)
    })

    const offTurn = api.onYoloTurnResult((payload) => {
      const status = String(payload?.status ?? 'unknown').toLowerCase() === 'ask_user'
        ? 'paused'
        : (payload?.status ?? 'unknown')
      appendEvent(`turn ${payload?.turnNumber ?? '?'} -> ${status}`)
      void refreshCore().catch(() => undefined)
    })

    const offActivity = api.onYoloActivity((item: ActivityItem) => {
      setActivities((prev) => [item, ...prev].slice(0, 500))
    })
    const offTerminal = api.onYoloTerminal((item: TerminalLiveEvent) => {
      setTerminalEvents((prev) => {
        const next = [...prev, item]
        return next.length > 3000 ? next.slice(next.length - 3000) : next
      })
    })
    const offUsage = api.onYoloUsage((item: UsageEvent) => {
      setUsage((prev) => ({
        promptTokens: prev.promptTokens + (item.promptTokens || 0),
        completionTokens: prev.completionTokens + (item.completionTokens || 0),
        totalTokens: prev.totalTokens + (item.totalTokens || 0),
        cachedTokens: prev.cachedTokens + (item.cachedTokens || 0),
        totalCost: prev.totalCost + (item.totalCost || 0),
        callCount: prev.callCount + (item.callCount || 0)
      }))
    })

    const offClosed = api.onProjectClosed(() => {
      appendEvent('project closed')
      setOverview(null)
      resetProjectScopedUi()
    })

    return () => {
      active = false
      offEvent()
      offTurn()
      offActivity()
      offTerminal()
      offUsage()
      offClosed()
    }
  }, [api, appendEvent, refreshCore, resetProjectScopedUi])

  // Actions
  const startSession = useCallback(async () => {
    if (!canOperate || !goalDraft.trim()) {
      setError('Goal is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: StartPayload = {
        goal: goalDraft,
        model: modelDraft,
        defaultRuntime: runtimeDraft,
        runtimeSystemInfo: runtimeSystemInfoDraft.trim() || undefined,
        autoRun,
        maxTurns: maxLoopTurns
      }
      const next = await api.yoloStart(payload)
      setOverview(next)
      setUsage(next.usage || EMPTY_USAGE)
      setTerminalEvents([])
      appendEvent('session started')
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, autoRun, canOperate, goalDraft, maxLoopTurns, modelDraft, refreshCore, runtimeDraft, runtimeSystemInfoDraft])

  const runOneTurn = useCallback(async () => {
    if (!canRunTurns) return
    setBusy(true)
    setError('')
    try {
      await api.yoloRunTurn()
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, canRunTurns, maxLoopTurns, refreshCore])

  const submitReply = useCallback(async () => {
    if (!pendingQuestion) return
    if (!hasSession) {
      setError('No active session. Start a session first.')
      return
    }

    const reply = replyDraft.trim()
    if (!reply) {
      setError('Reply is required.')
      return
    }

    setBusy(true)
    setSubmittingReply(true)
    setError('')
    try {
      await api.yoloSubmitUserInput(reply)
      appendEvent(`user reply submitted for turn-${pendingQuestion.turnNumber.toString().padStart(4, '0')}`)
      setReplyDraft('')
      await api.yoloRunTurn()
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingReply(false)
      setBusy(false)
    }
  }, [api, appendEvent, hasSession, pendingQuestion, refreshCore, replyDraft])

  const requestStop = useCallback(async () => {
    if (!canRunTurns) return
    setError('')
    try {
      await api.yoloStop()
      appendEvent('pause requested')
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, appendEvent, canRunTurns, refreshCore])

  const queueUserInput = useCallback(async () => {
    if (!hasSession) {
      setError('No active session. Start a session first.')
      return
    }

    const input = queuedInputDraft.trim()
    if (!input) return

    setSubmittingQueuedInput(true)
    setError('')
    try {
      await api.yoloSubmitUserInput(input)
      appendEvent('queued user input for next turn')
      setQueuedInputDraft('')
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingQueuedInput(false)
    }
  }, [api, appendEvent, hasSession, queuedInputDraft, refreshCore])

  const pickFolder = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.pickFolder()
      if (result) {
        resetProjectScopedUi()
        setOverview(result)
        setGoalDraft(result.goal || '')
        setRuntimeSystemInfoDraft(result.runtimeSystemInfo || '')
        setUsage(result.usage || EMPTY_USAGE)
        appendEvent(`folder selected: ${result.projectPath}`)
        await refreshCore()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, refreshCore, resetProjectScopedUi])

  const closeProject = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.closeProject()
      setOverview(result)
      resetProjectScopedUi()
      appendEvent('project closed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, resetProjectScopedUi])

  return (
    <div className="flex h-screen flex-col t-bg-base t-text">
      <StatusBar overview={overview} usage={usage} onPickFolder={pickFolder} onClose={closeProject} busy={busy} />

      {error && (
        <div
          className="shrink-0 border-b px-4 py-2 text-xs"
          style={{ borderColor: 'var(--color-action-stop)', background: 'rgba(244,63,94,0.1)', color: 'var(--color-accent-rose)' }}
        >
          {error}
          <button type="button" onClick={() => setError('')} className="ml-2 opacity-70 hover:opacity-100" style={{ color: 'var(--color-accent-rose)' }}>dismiss</button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ControlPanel
          overview={overview}
          goalDraft={goalDraft}
          setGoalDraft={setGoalDraft}
          modelDraft={modelDraft}
          setModelDraft={setModelDraft}
          runtimeDraft={runtimeDraft}
          setRuntimeDraft={setRuntimeDraft}
          runtimeSystemInfoDraft={runtimeSystemInfoDraft}
          setRuntimeSystemInfoDraft={setRuntimeSystemInfoDraft}
          autoRun={autoRun}
          setAutoRun={setAutoRun}
          maxLoopTurns={maxLoopTurns}
          setMaxLoopTurns={setMaxLoopTurns}
          pausedForUserInput={pausedForUserInput}
          busy={busy}
          queuedInputDraft={queuedInputDraft}
          setQueuedInputDraft={setQueuedInputDraft}
          submittingQueuedInput={submittingQueuedInput}
          onQueueInput={queueUserInput}
          onStart={startSession}
          onRunTurn={runOneTurn}
          onRunLoop={runBatch}
          onStop={requestStop}
        />
        <main className="flex-1 overflow-hidden">
          <MainTabs activeTab={activeTab} onTabChange={setActiveTab}>
            {activeTab === 'evidence' && (
              <EvidenceView
                overview={overview}
                turns={turns}
                projectMarkdown={projectMarkdown}
                failuresMarkdown={failuresMarkdown}
              />
            )}
            {activeTab === 'activity' && (
              <ActivityView activities={activities} />
            )}
            {activeTab === 'terminal' && (
              <TerminalView overview={overview} turns={turns} terminalEvents={terminalEvents} />
            )}
          </MainTabs>
        </main>
      </div>

      {pendingQuestion && (
        <PauseModal
          turnNumber={pendingQuestion.turnNumber}
          question={pendingQuestion.question}
          evidencePath={pendingQuestion.evidencePath}
          replyText={replyDraft}
          onReplyTextChange={setReplyDraft}
          onSubmit={submitReply}
          disabled={busy}
          submitting={submittingReply}
        />
      )}
    </div>
  )
}
