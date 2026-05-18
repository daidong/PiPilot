import React, { useEffect, useState } from 'react'
import { Eye, EyeOff, Check, ExternalLink, Cpu, Cloud, Box, Container, Settings as SettingsIcon, RefreshCw } from 'lucide-react'
import type { ComputeSettings as ComputeSettingsShape } from '../../../../../shared-ui/settings-types'
import { useComputeStore, type BackendView } from '../../stores/compute-store'

const api = (window as any).api

interface Props {
  compute: ComputeSettingsShape
  onChange: (settings: ComputeSettingsShape) => void
}

/**
 * Compute Settings — RFC-008 §7.7.
 *
 * Layout:
 *   • Global — cross-backend toggles (force-approval).
 *   • Local — informational; surfaces sandbox-mode availability so the
 *     user can see whether tasks will run as a host process or inside
 *     Docker. The planner picks per task; nothing user-tunable yet.
 *   • Modal — credentials (moved from API Keys per user request) +
 *     cost-kill threshold.
 *
 * New backends (AWS / GCP / etc.) get their own section here. The
 * generic ApprovalSection pattern keeps each section's affordances
 * contained.
 */
/**
 * Trigger a backend-availability re-probe. Shared by the Settings page
 * refresh button and the auto-refresh after credential saves; returns
 * the IPC result so callers can surface errors.
 */
export async function refreshBackendAvailability(): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await api?.refreshComputeAvailability?.()
    return result ?? { success: false, error: 'IPC unavailable' }
  } catch (err: any) {
    return { success: false, error: err?.message || 'Refresh failed' }
  }
}

export function ComputeSettings({ compute, onChange }: Props) {
  const localBackend = useComputeStore((s) => s.backends.get('local'))
  const modalBackend = useComputeStore((s) => s.backends.get('modal'))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(null)
    const result = await refreshBackendAvailability()
    if (!result.success && result.error) setRefreshError(result.error)
    setRefreshing(false)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between -mb-2">
        <p className="text-[11px] t-text-muted leading-relaxed max-w-md">
          Status reflects the last availability probe. Click refresh after starting Docker, saving
          credentials, or any other environment change.
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border t-border text-[11px] t-text-secondary hover:t-text disabled:opacity-50"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Re-probing…' : 'Refresh'}
        </button>
      </div>
      {refreshError && (
        <p className="text-[11px] text-red-500 -mt-3">{refreshError}</p>
      )}
      <GlobalSection compute={compute} onChange={onChange} />
      <LocalSection backend={localBackend} />
      <ModalSection compute={compute} onChange={onChange} backend={modalBackend} />
    </div>
  )
}

// ─── Section frame ────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  subtitle,
  status,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  status?: { dot: string; label: string }
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border t-border t-bg-surface/50">
      <header className="flex items-center gap-2.5 px-3.5 pt-3 pb-2 border-b t-border-subtle">
        <span className="t-text-muted shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold t-text leading-tight">{title}</h3>
          {subtitle && <p className="text-[11px] t-text-muted leading-relaxed mt-0.5">{subtitle}</p>}
        </div>
        {status && (
          <span className="inline-flex items-center gap-1.5 text-[11px] t-text-secondary shrink-0">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        )}
      </header>
      <div className="px-3.5 py-3 space-y-3">
        {children}
      </div>
    </section>
  )
}

function statusFromAvailability(backend?: BackendView): { dot: string; label: string } {
  if (!backend) return { dot: 'bg-[var(--color-text-muted)]', label: 'Not registered' }
  const av = backend.availability
  if (!av) return { dot: 'bg-[var(--color-text-muted)]', label: 'Checking…' }
  if (av.available) return { dot: 'bg-emerald-500', label: 'Ready' }
  return {
    dot: (av.missingRequirements?.length ?? 0) === 1 ? 'bg-amber-500' : 'bg-red-500',
    label: 'Unavailable',
  }
}

// ─── Global ───────────────────────────────────────────────────────────────

function GlobalSection({ compute, onChange }: Props) {
  const toggleForceApproval = (v: boolean) => onChange({ ...compute, requireApprovalForAllBackends: v })
  return (
    <Section
      icon={<SettingsIcon size={14} />}
      title="Global"
      subtitle="Settings that apply across every registered compute backend."
    >
      <label className="flex items-start gap-2 text-xs font-medium t-text cursor-pointer">
        <input
          type="checkbox"
          checked={compute.requireApprovalForAllBackends}
          onChange={(e) => toggleForceApproval(e.target.checked)}
          className="mt-0.5 accent-[var(--color-accent)]"
        />
        <span>
          Require approval for every compute backend
          <span className="block text-[11px] t-text-muted font-normal mt-0.5 leading-relaxed">
            When on, even local plans must be approved in the Compute tab before they execute. Takes
            effect for future plans only — in-flight plans keep the approval state they were created
            with. Useful on shared machines or for audit compliance.
          </span>
        </span>
      </label>
    </Section>
  )
}

// ─── Local backend ────────────────────────────────────────────────────────

function LocalSection({ backend }: { backend?: BackendView }) {
  const missing = backend?.availability?.missingRequirements ?? []
  const dockerMissing = missing.some((m) => m.toLowerCase().includes('docker'))
  // Process is always available — local backend always falls back to
  // spawning the script in the host process. Docker is conditional.
  return (
    <Section
      icon={<Cpu size={14} />}
      title="Local"
      subtitle="Runs on this machine. Sandbox mode is picked per-task by the planner based on risk."
      status={statusFromAvailability(backend)}
    >
      <ModeCard
        icon={<Box size={13} />}
        label="Process sandbox"
        statusDot="bg-emerald-500"
        statusLabel="Always available"
        description="Runs the script directly as a host child process. Faster startup; no isolation from the host filesystem outside the workspace."
      />
      <ModeCard
        icon={<Container size={13} />}
        label="Docker sandbox"
        statusDot={dockerMissing ? 'bg-amber-500' : 'bg-emerald-500'}
        statusLabel={dockerMissing ? 'Docker not detected' : 'Docker detected'}
        description={
          dockerMissing
            ? 'Install Docker Desktop to get sandboxed execution. Without it, the planner will fall back to the process sandbox.'
            : 'Runs the script inside a container. Stronger isolation; recommended for untrusted or unfamiliar code.'
        }
      />
      <p className="text-[11px] t-text-muted leading-relaxed">
        The planner reads risk + environment to pick the sandbox per task. To override, ask the agent
        explicitly in chat (e.g. <code className="font-mono">"run with the docker sandbox"</code>).
      </p>
    </Section>
  )
}

function ModeCard({
  icon,
  label,
  statusDot,
  statusLabel,
  description,
}: {
  icon: React.ReactNode
  label: string
  statusDot: string
  statusLabel: string
  description: string
}) {
  return (
    <div className="rounded-md border t-border-subtle px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="t-text-muted shrink-0">{icon}</span>
        <span className="text-xs font-medium t-text">{label}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] t-text-muted">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusLabel}
        </span>
      </div>
      <p className="text-[11px] t-text-muted leading-relaxed">{description}</p>
    </div>
  )
}

// ─── Modal backend ────────────────────────────────────────────────────────

function ModalSection({
  compute,
  onChange,
  backend,
}: {
  compute: ComputeSettingsShape
  onChange: (settings: ComputeSettingsShape) => void
  backend?: BackendView
}) {
  const threshold = compute.backends.modal?.costThresholdUsd ?? 5
  const updateThreshold = (v: number) =>
    onChange({
      ...compute,
      backends: {
        ...compute.backends,
        modal: { ...compute.backends.modal, costThresholdUsd: v },
      },
    })

  return (
    <Section
      icon={<Cloud size={14} />}
      title="Modal"
      subtitle="Remote GPU compute via modal.com. Plans require approval before running and are auto-killed when estimated cost exceeds the threshold below."
      status={statusFromAvailability(backend)}
    >
      <ModalCredentialFields />

      <div>
        <label className="block text-xs font-medium t-text mb-1.5">Auto-kill threshold (USD)</label>
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={threshold}
          onChange={(e) => updateThreshold(Math.max(0.1, Number(e.target.value) || 0.1))}
          className="w-32 text-xs px-2.5 py-1.5 rounded-md border t-border t-bg-base t-text font-mono focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        />
        <p className="text-[11px] t-text-muted mt-1 leading-relaxed">
          Runs are stopped when elapsed estimated GPU cost crosses this amount. The estimate is a
          lower bound — Modal also bills for CPU/RAM/idle containers, which are not modeled here.
        </p>
      </div>
    </Section>
  )
}

const MODAL_KEYS = [
  {
    name: 'MODAL_TOKEN_ID',
    label: 'Token ID',
    placeholder: 'ak-...',
  },
  {
    name: 'MODAL_TOKEN_SECRET',
    label: 'Token Secret',
    placeholder: 'as-...',
  },
] as const

function ModalCredentialFields() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  const refreshStatus = () => {
    api.getApiKeyStatus?.()
      .then((s: Record<string, boolean>) => setStatus(s ?? {}))
      .catch(() => { /* non-fatal */ })
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  const persist = async (name: string) => {
    const val = (values[name] ?? '').trim()
    if (!val) return
    setSaving((s) => ({ ...s, [name]: true }))
    setSaveError(null)
    try {
      const result = await api.saveApiKey?.(name, val)
      if (!result?.success) {
        setSaveError(result?.error || `Failed to save ${name}.`)
        return
      }
      // Clear the input so the placeholder shows "already set" on next render.
      setValues((v) => ({ ...v, [name]: '' }))
      refreshStatus()
      // Re-probe so the Modal section's status dot flips from "Unavailable"
      // (credentials missing) to "Ready" without waiting for the user to
      // click Refresh. saveApiKey already wrote process.env.* in main, so
      // ModalBackend.probeAvailability will see the new creds.
      void refreshBackendAvailability()
    } finally {
      setSaving((s) => ({ ...s, [name]: false }))
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium t-text">Credentials</span>
        <a
          href="https://modal.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
          onClick={(e) => { e.preventDefault(); window.open('https://modal.com/settings/tokens', '_blank') }}
          className="text-[11px] t-text-muted hover:t-text inline-flex items-center gap-1"
        >
          Get tokens <ExternalLink size={10} />
        </a>
      </div>
      {MODAL_KEYS.map((field) => {
        const alreadySet = status[field.name]
        const isSaving = saving[field.name]
        const currentValue = values[field.name] ?? ''
        return (
          <div key={field.name}>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={`modal-${field.name}`} className="text-[11px] t-text-secondary">
                {field.label}
              </label>
              {alreadySet && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
                  <Check size={10} /> configured
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <input
                  id={`modal-${field.name}`}
                  type={visible[field.name] ? 'text' : 'password'}
                  value={currentValue}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void persist(field.name) } }}
                  placeholder={alreadySet ? '••••••••  (already set — leave blank to keep)' : field.placeholder}
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-md border t-border t-bg-base t-text font-mono pr-8 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 t-text-muted hover:t-text"
                  onClick={() => setVisible((v) => ({ ...v, [field.name]: !v[field.name] }))}
                  tabIndex={-1}
                  aria-label={visible[field.name] ? 'Hide value' : 'Show value'}
                >
                  {visible[field.name] ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void persist(field.name)}
                disabled={isSaving || !currentValue.trim()}
                className="px-2.5 py-1.5 rounded-md border t-border text-[11px] t-text-secondary hover:t-text disabled:opacity-40"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )
      })}
      {saveError && <p className="text-[11px] text-red-500">{saveError}</p>}
      <p className="text-[11px] t-text-muted leading-relaxed">
        Tokens are stored encrypted in <code className="font-mono">~/.research-copilot/config.json</code> and exported
        to the spawned Modal CLI as <code className="font-mono">MODAL_TOKEN_ID</code> + <code className="font-mono">MODAL_TOKEN_SECRET</code>.
      </p>
    </div>
  )
}
