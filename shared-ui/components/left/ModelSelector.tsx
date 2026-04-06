import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, Check, Cpu, Eye, EyeOff } from 'lucide-react'
import { SUPPORTED_MODELS } from '../../constants'
import type { ModelOption } from '../../types'

// Group models by provider
const providers = [...new Set(SUPPORTED_MODELS.map((m) => m.provider))]
const groupedModels: Record<string, ModelOption[]> = {}
for (const p of providers) {
  groupedModels[p] = SUPPORTED_MODELS.filter((m) => m.provider === p)
}

interface Props {
  selectedModel: string
  onSelectModel: (modelId: string) => void
}

export function ModelSelector({ selectedModel, onSelectModel }: Props) {
  const [open, setOpen] = useState(false)
  const [anthropicStatus, setAnthropicStatus] = useState<any>(null)
  const [showAnthropicDialog, setShowAnthropicDialog] = useState(false)
  const [showOpenAIDialog, setShowOpenAIDialog] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const api = (window as any).api

  const current = SUPPORTED_MODELS.find((m) => m.id === selectedModel)

  const refreshAnthropicStatus = useCallback(async () => {
    try {
      const status = await api?.getAnthropicAuthStatus?.()
      setAnthropicStatus(status ?? null)
    } catch {
      setAnthropicStatus(null)
    }
  }, [api])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  useEffect(() => {
    refreshAnthropicStatus()
    const unsub = api?.onAnthropicAuthStatus?.((status: any) => setAnthropicStatus(status))
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [api, refreshAnthropicStatus])

  const handleModelSelect = async (model: ModelOption) => {
    if (model.provider === 'OpenAI') {
      const status = await api?.getOpenAIAuthStatus?.()
      if (!status?.hasApiKey) {
        setShowOpenAIDialog(true)
        setOpen(false)
        return
      }
    }

    if (model.provider === 'Anthropic') {
      const status = await api?.getAnthropicAuthStatus?.()
      if (!status?.hasApiKeyFallback) {
        setShowAnthropicDialog(true)
        setOpen(false)
        return
      }
    }

    onSelectModel(model.id)
    setOpen(false)
    refreshAnthropicStatus()
  }

  const authBadge = current?.provider === 'Anthropic'
    ? anthropicStatus?.authMode === 'api-key'
      ? 'api'
      : 'auth'
    : null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="no-drag group relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg t-text-secondary text-xs font-medium t-bg-hover transition-colors"
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {/* Fast tooltip — matches ToolbarButton pattern exactly */}
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-0.5 rounded text-[10px] t-bg-elevated t-text-secondary border t-border shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 z-50"
          style={{ transition: 'opacity 0.15s ease', transitionDelay: '0.2s' }}
        >
          Select model
        </span>
        <Cpu size={14} />
        <span className="truncate max-w-[100px]">{current?.label || selectedModel}</span>
        {authBadge && (
          <span className="text-[10px] px-1 rounded border t-border t-text-muted uppercase">{authBadge}</span>
        )}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl z-50" role="listbox" aria-label="Available models">
          {providers.map((provider) => (
            <div key={provider}>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider t-text-muted sticky top-0 t-bg-surface">
                {provider}
              </div>
              {(provider === 'OpenAI' || provider === 'Anthropic') && (
                <div className="px-3 pb-1 text-[11px] t-text-muted">
                  API Key Only
                </div>
              )}
              {groupedModels[provider].map((model) => (
                <button
                  key={model.id}
                  role="option"
                  aria-selected={model.id === selectedModel}
                  onClick={() => {
                    handleModelSelect(model).catch((err) => {
                      console.error('[ModelSelector] failed to switch model:', err)
                      window.alert(err?.message || 'Failed to switch model.')
                    })
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors t-bg-hover ${
                    model.id === selectedModel ? 't-text' : 't-text-secondary'
                  }`}
                >
                  <span className="w-4 shrink-0">
                    {model.id === selectedModel && <Check size={14} className="t-text-accent-soft" />}
                  </span>
                  <span className="truncate">{model.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {(showOpenAIDialog || showAnthropicDialog) && (
        <ApiKeyDialog
          provider={showOpenAIDialog ? 'OpenAI' : 'Anthropic'}
          keyName={showOpenAIDialog ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}
          placeholder={showOpenAIDialog ? 'sk-...' : 'sk-ant-...'}
          onClose={() => { setShowOpenAIDialog(false); setShowAnthropicDialog(false) }}
          onSaved={(model) => {
            setShowOpenAIDialog(false)
            setShowAnthropicDialog(false)
            // Select the model that triggered the dialog
            onSelectModel(model)
            refreshAnthropicStatus()
          }}
          pendingModel={selectedModel}
        />
      )}
    </div>
  )
}

/** Inline dialog for entering a missing API key */
function ApiKeyDialog({
  provider,
  keyName,
  placeholder,
  onClose,
  onSaved,
  pendingModel,
}: {
  provider: string
  keyName: string
  placeholder: string
  onClose: () => void
  onSaved: (model: string) => void
  pendingModel: string
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const api = (window as any).api

  // Focus trap: keep Tab cycling within the dialog
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    first.focus()

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    dialog.addEventListener('keydown', handler)
    return () => dialog.removeEventListener('keydown', handler)
  }, [])

  const handleSave = async () => {
    const trimmed = value.trim()
    if (!trimmed) { setError('Please enter a valid API key.'); return }
    setSaving(true)
    setError(null)
    try {
      await api.saveApiKey(keyName, trimmed)
      onSaved(pendingModel)
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={`${provider} API Key Required`}>
      <div ref={dialogRef} className="w-full max-w-md rounded-xl border t-border t-bg-surface shadow-2xl p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold t-text">{provider} API Key Required</div>
          <div className="text-xs t-text-secondary mt-1">
            Enter your <code className="px-1 rounded t-bg-surface">{keyName}</code> to use {provider} models.
          </div>
        </div>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            className="w-full text-xs px-2.5 py-2 rounded-md border t-border t-bg-base t-text font-mono pr-8
                       focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            aria-label={`${provider} API key`}
            autoFocus
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 t-text-muted hover:t-text"
            onClick={() => setShowKey(!showKey)}
            tabIndex={-1}
          >
            {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <p className="text-[11px] t-text-muted">
          Key is saved to <code className="px-1 rounded t-bg-surface">~/.research-copilot/config.json</code>. No restart needed.
        </p>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded-lg text-xs t-text-secondary t-bg-hover"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded-lg text-xs t-bg-accent text-white hover:opacity-90 disabled:opacity-50"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save & Use'}
          </button>
        </div>
      </div>
    </div>
  )
}
