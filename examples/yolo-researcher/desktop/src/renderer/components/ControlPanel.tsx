import { useState } from 'react'
import type { DesktopOverview, RuntimeKind } from '../lib/types'
import { DEFAULT_MAX_LOOP_TURNS } from '../lib/types'

interface ControlPanelProps {
  overview: DesktopOverview | null
  goalDraft: string
  setGoalDraft: (v: string) => void
  currentPlan: string[]
  modelDraft: string
  setModelDraft: (v: string) => void
  runtimeDraft: RuntimeKind
  setRuntimeDraft: (v: RuntimeKind) => void
  runtimeSystemInfoDraft: string
  setRuntimeSystemInfoDraft: (v: string) => void
  autoRun: boolean
  setAutoRun: (v: boolean) => void
  maxLoopTurns: number
  setMaxLoopTurns: (v: number) => void
  pausedForUserInput: boolean
  busy: boolean
  queuedInputDraft: string
  setQueuedInputDraft: (v: string) => void
  submittingQueuedInput: boolean
  onQueueInput: () => void
  onStart: () => void
  onRunTurn: () => void
  onRunLoop: () => void
  onStop: () => void
}

interface ModelOption {
  id: string
  label: string
  provider: string
}

const SUPPORTED_MODELS: ModelOption[] = [
  // OpenAI
  { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI' },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'OpenAI' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', provider: 'OpenAI' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  // Anthropic
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
]

const MODEL_IDS = SUPPORTED_MODELS.map((m) => m.id)

export default function ControlPanel({
  overview,
  goalDraft,
  setGoalDraft,
  currentPlan,
  modelDraft,
  setModelDraft,
  runtimeDraft,
  setRuntimeDraft,
  runtimeSystemInfoDraft,
  setRuntimeSystemInfoDraft,
  autoRun,
  setAutoRun,
  maxLoopTurns,
  setMaxLoopTurns,
  pausedForUserInput,
  busy,
  queuedInputDraft,
  setQueuedInputDraft,
  submittingQueuedInput,
  onQueueInput,
  onStart,
  onRunTurn,
  onRunLoop,
  onStop
}: ControlPanelProps) {
  const canOperate = Boolean(overview?.projectPath)
  const hasSession = Boolean(overview?.hasSession)
  const canRunTurns = canOperate && Boolean(overview?.hasSession) && !pausedForUserInput
  const canPause = canOperate && hasSession && !pausedForUserInput && Boolean(overview?.loopRunning)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <aside
      className="t-bg-surface t-border flex w-80 shrink-0 flex-col overflow-y-auto border-r"
    >
      {/* Mission Board — V1 HeroSection inspired */}
      <div className="t-border border-b px-4 py-4">
        <div className="t-text-muted mb-1 text-[11px] font-semibold uppercase tracking-wider">Mission Board</div>
        <div className="t-text mb-4 text-sm font-medium">Configure & Launch</div>

        <div className="space-y-3">
          <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
            <label className="t-text-muted mb-1.5 block text-[10px] font-semibold uppercase tracking-wider">Research Goal</label>
            <textarea
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              rows={3}
              className="t-input w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-xs transition-colors"
              placeholder="Describe the research objective..."
            />
          </div>

          {pausedForUserInput && (
            <div className="t-status-warning rounded-lg border px-3 py-2 text-[11px] leading-relaxed">
              Session paused for user input. You can submit via the queue box below (or pause dialog when prompted).
            </div>
          )}

          <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
            <label className="t-text-muted mb-1.5 block text-[10px] font-semibold uppercase tracking-wider">Current Plan</label>
            {currentPlan.length === 0 ? (
              <div className="t-text-muted text-[11px]">No plan yet.</div>
            ) : (
              <div className="max-h-36 overflow-auto pr-1">
                <ol className="t-text-secondary space-y-1 text-[11px]">
                  {currentPlan.map((item, idx) => (
                    <li key={`${idx}-${item}`} className="leading-relaxed">
                      {idx + 1}. {item}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {/* Max turns + auto-run */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="t-text-secondary mb-1 block text-[10px] font-medium">Max turns</label>
              <input
                type="number"
                min={1}
                max={200}
                value={maxLoopTurns}
                onChange={(e) => setMaxLoopTurns(Number(e.target.value) || DEFAULT_MAX_LOOP_TURNS)}
                className="t-input w-full rounded-lg border px-3 py-2 text-xs transition-colors"
              />
            </div>
            <label className="t-text-secondary flex cursor-pointer items-end gap-2 pb-2 text-[11px]">
              <input
                type="checkbox"
                checked={autoRun}
                onChange={(e) => setAutoRun(e.target.checked)}
                className="t-checkbox-accent h-4 w-4 rounded"
              />
              Auto-run
            </label>
          </div>

          {/* Action buttons — solid fills with V1 styling */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onStart}
              disabled={busy || !canOperate}
              className="t-btn-accent flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:opacity-90 disabled:opacity-30"
            >
              {busy && (
                <div className="h-3 w-3 rounded-full border-[1.5px] border-white border-t-transparent animate-spin-slow" />
              )}
              {hasSession ? 'Restart' : 'Start'}
            </button>
            <button
              type="button"
              onClick={onRunTurn}
              disabled={busy || !canRunTurns}
              className="t-btn-neutral rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-30"
            >
              1 Turn
            </button>
            <button
              type="button"
              onClick={onRunLoop}
              disabled={busy || !canRunTurns}
              className="t-btn-accent rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:opacity-90 disabled:opacity-30"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={onStop}
              disabled={!canPause}
              className="t-btn-danger-ghost flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:opacity-90 disabled:opacity-30"
            >
              Pause
            </button>
          </div>

          {/* Queue user input for next turn */}
          <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
            <label className="t-text-muted mb-1.5 block text-[10px] font-semibold uppercase tracking-wider">
              Inject Input (Next Turn)
            </label>
            <textarea
              value={queuedInputDraft}
              onChange={(e) => setQueuedInputDraft(e.target.value)}
              rows={2}
              className="t-input w-full resize-y rounded-lg border px-3 py-2 text-xs transition-colors"
              placeholder="Add context/instructions to be injected into the next turn..."
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="t-text-muted text-[10px]">
                {overview?.loopRunning ? 'Can queue while loop is running.' : 'Will apply on the next turn.'}
              </div>
              <button
                type="button"
                onClick={onQueueInput}
                disabled={!hasSession || !queuedInputDraft.trim() || submittingQueuedInput}
                className="t-btn-accent rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-30"
              >
                {submittingQueuedInput ? 'Queueing...' : 'Queue Input'}
              </button>
            </div>
          </div>

          {/* Collapsible settings — V1 style */}
          <button
            type="button"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="t-text-muted flex w-full items-center gap-1.5 text-[11px] transition-colors"
          >
            <span className={`text-[9px] transition-transform ${settingsOpen ? 'rotate-90' : ''}`}>&#9654;</span>
            Settings
          </button>
          {settingsOpen && (
            <div className="t-bg-elevated t-border-subtle space-y-2 rounded-lg border p-3">
              <div>
                <label className="t-text-secondary mb-1 block text-[10px] font-medium">Model</label>
                <select
                  value={MODEL_IDS.includes(modelDraft) ? modelDraft : '__custom__'}
                  onChange={(e) => {
                    if (e.target.value !== '__custom__') setModelDraft(e.target.value)
                  }}
                  className="t-input w-full rounded-lg border px-2 py-1.5 text-xs"
                >
                  <optgroup label="OpenAI">
                    {SUPPORTED_MODELS.filter((m) => m.provider === 'OpenAI').map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Anthropic">
                    {SUPPORTED_MODELS.filter((m) => m.provider === 'Anthropic').map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </optgroup>
                  <option value="__custom__">Custom...</option>
                </select>
                {!MODEL_IDS.includes(modelDraft) && (
                  <input
                    value={modelDraft}
                    onChange={(e) => setModelDraft(e.target.value)}
                    placeholder="Enter model ID..."
                    className="t-input mt-1 w-full rounded-lg border px-2 py-1.5 text-xs"
                  />
                )}
              </div>
              <div>
                <label className="t-text-secondary mb-1 block text-[10px] font-medium">Runtime</label>
                <select
                  value={runtimeDraft}
                  onChange={(e) => setRuntimeDraft(e.target.value as RuntimeKind)}
                  className="t-input w-full rounded-lg border px-2 py-1.5 text-xs"
                >
                  <option value="host">host</option>
                  <option value="docker">docker</option>
                  <option value="venv">venv</option>
                </select>
                <label className="t-text-secondary mt-2 mb-1 block text-[10px] font-medium">
                  Local system notes (optional)
                </label>
                <textarea
                  value={runtimeSystemInfoDraft}
                  onChange={(e) => setRuntimeSystemInfoDraft(e.target.value)}
                  rows={3}
                  className="t-input w-full resize-y rounded-lg border px-2 py-1.5 text-xs"
                  placeholder="Example: macOS 14.6, Python 3.11 via pyenv, uv installed, Docker unavailable."
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
