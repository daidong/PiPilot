import React, { useState, useEffect } from 'react'
import { Eye, EyeOff, Check, ExternalLink, LogIn, ArrowUpCircle, Copy, X } from 'lucide-react'

const api = (window as any).api

const KEY_FIELDS = [
  {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
    hint: 'Powers Claude models. Get a key at console.anthropic.com',
    url: 'https://console.anthropic.com/settings/keys',
    required: true,
  },
  {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI',
    placeholder: 'sk-...',
    hint: 'Powers GPT / o-series models. Get a key at platform.openai.com',
    url: 'https://platform.openai.com/api-keys',
    required: true,
  },
  {
    name: 'BRAVE_API_KEY',
    label: 'Brave Search',
    placeholder: 'BSA...',
    hint: 'Enables web search. Without it, search falls back to arXiv only.',
    url: 'https://brave.com/search/api/',
    required: false,
  },
  {
    name: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    placeholder: 'sk-or-...',
    hint: 'Enables AI-generated scientific diagrams. Optional.',
    url: 'https://openrouter.ai/',
    required: false,
  },
] as const

function UpdateBanner() {
  const [update, setUpdate] = useState<{ latest: string; current: string; hasUpdate: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.checkForUpdate().then((info: { latest: string; current: string; hasUpdate: boolean }) => {
      if (info.hasUpdate) setUpdate(info)
    }).catch(() => {})
  }, [])

  if (!update || dismissed) return null

  const command = 'npm update -g research-copilot'

  return (
    <div className="mb-4 relative rounded-lg border t-border-subtle t-bg-elevated overflow-hidden">
      {/* 2px accent bar — same distinguishing treatment used on wiki-only
          rows in LiteratureView and active rows in FolderGate. */}
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] t-bg-accent-soft" />
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <ArrowUpCircle size={15} className="t-text-accent-soft mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium t-text">
            v{update.latest} available
            <span className="t-text-secondary font-normal ml-1.5">(current: v{update.current})</span>
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <code className="flex-1 text-[10px] font-mono px-2 py-1 rounded t-bg-surface t-text select-all">
              {command}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
              className="shrink-0 p-1 rounded t-bg-surface hover:opacity-80 transition-opacity"
              title="Copy command"
            >
              {copied ? <Check size={12} className="t-text-success" /> : <Copy size={12} className="t-text-secondary" />}
            </button>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 p-0.5 rounded hover:t-bg-surface transition-colors t-text-secondary hover:t-text"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}

interface Props {
  /** When true, shows a "Save & Continue" button instead of just auto-saving */
  showSaveButton?: boolean
  onSaved?: () => void
}

export function ApiKeysSettings({ showSaveButton, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [codexStatus, setCodexStatus] = useState<{ isLoggedIn: boolean } | null>(null)
  const [codexLoggingIn, setCodexLoggingIn] = useState(false)

  useEffect(() => {
    api.getApiKeyStatus().then((s: Record<string, boolean>) => setStatus(s))
    api.getOpenAICodexStatus?.().then((s: any) => setCodexStatus(s)).catch(() => {})
  }, [])

  const handleCodexLogin = async () => {
    setCodexLoggingIn(true)
    try {
      const result = await api.openaiCodexLogin?.()
      if (result?.success) {
        setCodexStatus({ isLoggedIn: true })
      } else {
        setError(result?.error || 'ChatGPT sign-in failed')
      }
    } catch (err: any) {
      setError(err.message || 'ChatGPT sign-in failed')
    } finally {
      setCodexLoggingIn(false)
    }
  }

  const handleSave = async () => {
    const entries = Object.entries(values).filter(([, v]) => v.trim())
    if (entries.length === 0 && !status.ANTHROPIC_API_KEY && !status.OPENAI_API_KEY && !codexStatus?.isLoggedIn) {
      setError('Please enter at least one LLM API key or sign in with ChatGPT.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      for (const [key, val] of entries) {
        await api.saveApiKey(key, val)
      }
      // Refresh status after save
      const newStatus = await api.getApiKeyStatus()
      setStatus(newStatus)
      setValues({})
      onSaved?.()
    } catch (err: any) {
      setError(err.message || 'Failed to save keys')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <UpdateBanner />

      <div className="space-y-3">
        {KEY_FIELDS.map((field) => {
          const alreadySet = status[field.name]
          return (
            <div key={field.name} className="rounded-lg border t-border t-bg-surface/50 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium t-text flex items-center gap-1.5">
                  {field.label}
                  {field.required && <span className="text-[10px] t-text-muted">(required*)</span>}
                  {!field.required && <span className="text-[10px] t-text-muted">(optional)</span>}
                  {alreadySet && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-green-500">
                      <Check size={10} /> configured
                    </span>
                  )}
                </label>
                <a
                  href={field.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] t-text-muted hover:t-text flex items-center gap-0.5"
                  onClick={(e) => { e.preventDefault(); window.open(field.url, '_blank') }}
                >
                  Get key <ExternalLink size={9} />
                </a>
              </div>
              <div className="relative">
                <input
                  type={visible[field.name] ? 'text' : 'password'}
                  className="w-full text-xs px-2.5 py-1.5 rounded-md border t-border t-bg-base t-text font-mono pr-8
                             focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  placeholder={alreadySet ? '••••••••  (already set — leave blank to keep)' : field.placeholder}
                  value={values[field.name] || ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  aria-label={`${field.label} API key`}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 t-text-muted hover:t-text"
                  onClick={() => setVisible((prev) => ({ ...prev, [field.name]: !prev[field.name] }))}
                  tabIndex={-1}
                >
                  {visible[field.name] ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <p className="text-[11px] t-text-muted mt-1">{field.hint}</p>
            </div>
          )
        })}
      </div>

      {/* ChatGPT Subscription */}
      <div className="rounded-lg border t-border t-bg-surface/50 p-3 mt-3">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium t-text flex items-center gap-1.5">
            ChatGPT Subscription
            <span className="text-[10px] t-text-muted">(alternative to OpenAI API key)</span>
            {codexStatus?.isLoggedIn && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-green-500">
                <Check size={10} /> signed in
              </span>
            )}
          </label>
        </div>
        <button
          onClick={handleCodexLogin}
          disabled={codexLoggingIn || codexStatus?.isLoggedIn}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border t-border text-xs t-text-secondary hover:t-text t-bg-hover disabled:opacity-50"
        >
          <LogIn size={12} />
          {codexLoggingIn ? 'Signing in...' : codexStatus?.isLoggedIn ? 'Already signed in' : 'Sign in with ChatGPT'}
        </button>
        <p className="text-[11px] t-text-muted mt-1">
          Use your ChatGPT Plus/Pro subscription instead of an API key. No per-token billing.
        </p>
      </div>

      <p className="text-[11px] t-text-muted mt-2">
        * At least one of Anthropic or OpenAI (API key or ChatGPT subscription) is required.
      </p>

      {error && <p className="text-xs text-red-400 mt-2" role="alert">{error}</p>}

      {showSaveButton && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md text-white text-[13px] font-medium hover:brightness-110 transition-[filter] duration-150 disabled:opacity-50 bg-[var(--color-accent)]"
          >
            {saving ? 'Saving…' : 'Save & Continue'}
          </button>
        </div>
      )}
    </div>
  )
}
