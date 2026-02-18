import { useCallback, useEffect, useState } from 'react'
import type { DesktopOverview, TurnListItem, UiEvent, ActivityItem, TerminalLiveEvent, RuntimeKind, StartPayload } from './lib/types'
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

function parseCurrentPlan(markdown: string): string[] {
  if (!markdown.trim()) return []
  const sectionMatch = /##\s+Current Plan(?:[^\n]*)\n([\s\S]*?)(?=\n##\s+|$)/i.exec(markdown)
  if (!sectionMatch?.[1]) return []

  return sectionMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
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
  const [currentPlan, setCurrentPlan] = useState<string[]>([])
  const [turns, setTurns] = useState<TurnListItem[]>([])

  const [goalDraft, setGoalDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('gpt-5.2')
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeKind>('host')
  const [autoRun, setAutoRun] = useState(true)
  const [maxLoopTurns, setMaxLoopTurns] = useState(DEFAULT_MAX_LOOP_TURNS)

  const [events, setEvents] = useState<UiEvent[]>([])
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [terminalEvents, setTerminalEvents] = useState<TerminalLiveEvent[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [submittingReply, setSubmittingReply] = useState(false)
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

  const refreshCore = useCallback(async () => {
    const current = await api.getCurrentSession()
    setOverview(current)

    if (!current.projectPath) {
      setProjectMarkdown('')
      setFailuresMarkdown('')
      setCurrentPlan([])
      setTurns([])
      setTerminalEvents([])
      setPendingQuestion(null)
      return current
    }

    const [projectMd, failuresMd, turnList] = await Promise.all([
      api.yoloGetProjectMarkdown(),
      api.yoloGetFailuresMarkdown(),
      api.yoloListTurns()
    ])

    setProjectMarkdown(projectMd)
    setFailuresMarkdown(failuresMd)
    setCurrentPlan(parseCurrentPlan(projectMd))
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

    return current
  }, [api, goalDraft])

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

    const offClosed = api.onProjectClosed(() => {
      appendEvent('project closed')
      setOverview(null)
      setProjectMarkdown('')
      setFailuresMarkdown('')
      setCurrentPlan([])
      setTurns([])
      setTerminalEvents([])
      setGoalDraft('')
      setPendingQuestion(null)
      setReplyDraft('')
    })

    return () => {
      active = false
      offEvent()
      offTurn()
      offActivity()
      offTerminal()
      offClosed()
    }
  }, [api, appendEvent, refreshCore])

  // Actions
  const startSession = useCallback(async () => {
    if (!canOperate || !goalDraft.trim()) {
      setError('Goal is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: StartPayload = { goal: goalDraft, model: modelDraft, defaultRuntime: runtimeDraft, autoRun, maxTurns: maxLoopTurns }
      const next = await api.yoloStart(payload)
      setOverview(next)
      setTerminalEvents([])
      appendEvent('session started')
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent, autoRun, canOperate, goalDraft, maxLoopTurns, modelDraft, refreshCore, runtimeDraft])

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
    setBusy(true)
    setError('')
    try {
      await api.yoloStop()
      appendEvent('stop requested')
      await refreshCore()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
        setTerminalEvents([])
        setGoalDraft(result.goal || '')
        appendEvent(`folder selected: ${result.projectPath}`)
        await refreshCore()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      setProjectMarkdown('')
      setFailuresMarkdown('')
      setCurrentPlan([])
      setTurns([])
      setTerminalEvents([])
      setGoalDraft('')
      setPendingQuestion(null)
      setReplyDraft('')
      appendEvent('project closed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, appendEvent])

  return (
    <div className="flex h-screen flex-col t-bg-base t-text">
      <StatusBar overview={overview} onPickFolder={pickFolder} onClose={closeProject} busy={busy} />

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
          events={events}
          goalDraft={goalDraft}
          setGoalDraft={setGoalDraft}
          currentPlan={currentPlan}
          modelDraft={modelDraft}
          setModelDraft={setModelDraft}
          runtimeDraft={runtimeDraft}
          setRuntimeDraft={setRuntimeDraft}
          autoRun={autoRun}
          setAutoRun={setAutoRun}
          maxLoopTurns={maxLoopTurns}
          setMaxLoopTurns={setMaxLoopTurns}
          pausedForUserInput={pausedForUserInput}
          busy={busy}
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
