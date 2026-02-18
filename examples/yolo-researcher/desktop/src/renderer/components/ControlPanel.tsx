import { useRef, useEffect, useState } from 'react'
import type { DesktopOverview, RuntimeKind, UiEvent } from '../lib/types'
import { DEFAULT_MAX_LOOP_TURNS } from '../lib/types'

interface ControlPanelProps {
  overview: DesktopOverview | null
  events: UiEvent[]
  goalDraft: string
  setGoalDraft: (v: string) => void
  currentPlan: string[]
  modelDraft: string
  setModelDraft: (v: string) => void
  runtimeDraft: RuntimeKind
  setRuntimeDraft: (v: RuntimeKind) => void
  autoRun: boolean
  setAutoRun: (v: boolean) => void
  maxLoopTurns: number
  setMaxLoopTurns: (v: number) => void
  pausedForUserInput: boolean
  busy: boolean
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

const inputStyle = {
  background: 'var(--color-input-bg)',
  borderColor: 'var(--color-input-border)',
  color: 'var(--color-text)'
}

export default function ControlPanel({
  overview,
  events,
  goalDraft,
  setGoalDraft,
  currentPlan,
  modelDraft,
  setModelDraft,
  runtimeDraft,
  setRuntimeDraft,
  autoRun,
  setAutoRun,
  maxLoopTurns,
  setMaxLoopTurns,
  pausedForUserInput,
  busy,
  onStart,
  onRunTurn,
  onRunLoop,
  onStop
}: ControlPanelProps) {
  const canOperate = Boolean(overview?.projectPath)
  const canRunTurns = canOperate && Boolean(overview?.hasSession) && !pausedForUserInput
  const [settingsOpen, setSettingsOpen] = useState(false)
  const eventsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (eventsRef.current) {
      eventsRef.current.scrollTop = 0
    }
  }, [events.length])

  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-hidden border-r"
      style={{ background: 'var(--color-bg-surface)', borderColor: 'var(--color-border)' }}
    >
      {/* Mission Board — V1 HeroSection inspired */}
      <div className="flex-none border-b px-4 py-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Mission Board</div>
        <div className="text-sm font-medium mb-4" style={{ color: 'var(--color-text)' }}>Configure & Launch</div>

        <div className="space-y-3">
          {/* Goal — teal card */}
          <div className="rounded-lg border p-3 t-card-teal">
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-teal)' }}>Research Goal</label>
            <textarea
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-xs outline-none transition-colors focus:border-teal-500"
              style={{ borderColor: 'rgba(20,184,166,0.2)', color: 'var(--color-text)' }}
              placeholder="Describe the research objective..."
            />
          </div>

          {pausedForUserInput && (
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed t-card-amber">
              Session paused for user input. Submit reply in the pause dialog to resume turns.
            </div>
          )}

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-elevated)' }}>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Current Plan</label>
            {currentPlan.length === 0 ? (
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No plan yet.</div>
            ) : (
              <ol className="space-y-1 text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
                {currentPlan.map((item, idx) => (
                  <li key={`${idx}-${item}`} className="leading-relaxed">
                    {idx + 1}. {item}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Max turns + auto-run */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>Max turns</label>
              <input
                type="number"
                min={1}
                max={200}
                value={maxLoopTurns}
                onChange={(e) => setMaxLoopTurns(Number(e.target.value) || DEFAULT_MAX_LOOP_TURNS)}
                className="w-full rounded-lg border px-3 py-2 text-xs outline-none transition-colors focus:border-teal-500"
                style={inputStyle}
              />
            </div>
            <label className="flex items-end gap-2 pb-2 text-[11px] cursor-pointer" style={{ color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={autoRun}
                onChange={(e) => setAutoRun(e.target.checked)}
                className="h-4 w-4 rounded accent-teal-500"
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
              className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-30"
              style={{ background: 'var(--color-action-start)' }}
            >
              {busy && (
                <div className="h-3 w-3 rounded-full border-[1.5px] border-white border-t-transparent animate-spin-slow" />
              )}
              Start
            </button>
            <button
              type="button"
              onClick={onRunTurn}
              disabled={busy || !canRunTurns}
              className="rounded-lg px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-30"
              style={{ background: 'var(--color-action-turn)' }}
            >
              1 Turn
            </button>
            <button
              type="button"
              onClick={onRunLoop}
              disabled={busy || !canRunTurns}
              className="rounded-lg px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-30"
              style={{ background: 'var(--color-action-loop)' }}
            >
              Loop
            </button>
            <button
              type="button"
              onClick={onStop}
              disabled={busy || !canRunTurns}
              className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:opacity-90 disabled:opacity-30"
              style={{ borderColor: 'var(--color-action-stop)', color: 'var(--color-action-stop-text)' }}
            >
              Stop
            </button>
          </div>

          {/* Collapsible settings — V1 style */}
          <button
            type="button"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="flex w-full items-center gap-1.5 text-[11px] transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <span className={`text-[9px] transition-transform ${settingsOpen ? 'rotate-90' : ''}`}>&#9654;</span>
            Settings
          </button>
          {settingsOpen && (
            <div className="rounded-lg border p-3 space-y-2 t-card-sky">
              <div>
                <label className="mb-1 block text-[10px] font-medium" style={{ color: 'var(--color-accent-sky)' }}>Model</label>
                <select
                  value={MODEL_IDS.includes(modelDraft) ? modelDraft : '__custom__'}
                  onChange={(e) => {
                    if (e.target.value !== '__custom__') setModelDraft(e.target.value)
                  }}
                  className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                  style={inputStyle}
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
                    className="mt-1 w-full rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                    style={inputStyle}
                  />
                )}
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium" style={{ color: 'var(--color-accent-sky)' }}>Runtime</label>
                <select
                  value={runtimeDraft}
                  onChange={(e) => setRuntimeDraft(e.target.value as RuntimeKind)}
                  className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                  style={inputStyle}
                >
                  <option value="host">host</option>
                  <option value="docker">docker</option>
                  <option value="venv">venv</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live Events — V1 ActivityFeed inspired */}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full animate-status-pulse" style={{ background: 'var(--color-accent)' }} />
          <h2 className="flex-none text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            Live Events
          </h2>
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{events.length}</span>
        </div>
        <div ref={eventsRef} className="flex-1 space-y-1.5 overflow-auto pr-1">
          {events.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              No events yet. Events will appear here when agents start working.
            </div>
          )}
          {events.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border px-3 py-2"
              style={{ background: 'var(--color-bg-base)', borderColor: 'var(--color-border-subtle)' }}
            >
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{item.at}</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>{item.text}</div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
