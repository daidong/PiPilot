import React, { useState, useEffect } from 'react'
import { Key, Eye, EyeOff, Check, ExternalLink } from 'lucide-react'

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

interface Props {
  /** Called after the user saves at least one LLM key */
  onComplete: () => void
}

export function ApiKeySetup({ onComplete }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getApiKeyStatus().then((s: Record<string, boolean>) => setStatus(s))
  }, [])

  const hasAnyLlmKey =
    status.ANTHROPIC_API_KEY || status.OPENAI_API_KEY ||
    !!(values.ANTHROPIC_API_KEY || '').trim() || !!(values.OPENAI_API_KEY || '').trim()

  const handleSave = async () => {
    const entries = Object.entries(values).filter(([, v]) => v.trim())
    if (entries.length === 0 && !status.ANTHROPIC_API_KEY && !status.OPENAI_API_KEY) {
      setError('Please enter at least one API key (Anthropic or OpenAI) to continue.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      for (const [key, val] of entries) {
        await api.saveApiKey(key, val)
      }
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to save keys')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-screen w-screen t-bg-base t-text items-center justify-center">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
      <div className="w-full max-w-lg px-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="relative mx-auto mb-6 w-fit">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-2) 100%)',
                boxShadow: '0 8px 32px var(--color-accent-2-muted)',
              }}
            >
              <Key className="text-white" size={22} />
            </div>
          </div>
          <h1 className="text-xl font-semibold tracking-tight mb-1">Configure API Keys</h1>
          <p className="t-text-secondary text-[13px] leading-relaxed">
            At least one LLM key (Anthropic or OpenAI) is required.
            <br />
            Keys are stored locally in <code className="px-1 py-0.5 rounded t-bg-surface text-xs font-mono">~/.research-copilot/config.json</code>
          </p>
        </div>

        {/* Key inputs */}
        <div className="space-y-3 mb-6">
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
                    onClick={(e) => {
                      e.preventDefault()
                      window.open(field.url, '_blank')
                    }}
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

        <p className="text-[11px] t-text-muted mb-1">
          * You need at least one of Anthropic or OpenAI. Both is fine too.
        </p>

        {error && (
          <p className="text-xs text-red-400 mb-3">{error}</p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between">
          {/* Skip only if keys already exist in env */}
          {(status.ANTHROPIC_API_KEY || status.OPENAI_API_KEY) && (
            <button
              onClick={onComplete}
              className="text-xs t-text-secondary hover:t-text transition-colors"
            >
              Skip — keys already configured
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-all duration-200 disabled:opacity-50"
            style={{
              background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-2) 100%)',
              boxShadow: '0 4px 16px var(--color-accent-2-muted)',
            }}
          >
            {saving ? 'Saving...' : hasAnyLlmKey ? 'Save & Continue' : 'Save & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
