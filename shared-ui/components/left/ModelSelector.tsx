import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Cpu, Eye, EyeOff, LogIn, LogOut, X, Image as ImageIcon, FileText } from 'lucide-react'
import { SUPPORTED_MODELS } from '../../constants'
import { parseModelKey } from '../../utils'
import { getModelCapabilities } from '../../lib/model-capabilities'
import type { ModelOption } from '../../types'

// Group models by provider. Subscription providers come first so they are the
// first thing the user sees — we prefer sub over API key when both work.
// DeepSeek is intentionally listed last (text-only, niche pricing tier).
const PROVIDER_ORDER = [
  'ChatGPT Subscription',
  'Claude Subscription',
  'OpenAI',
  'Anthropic',
  'DeepSeek',
]
const allProviders = PROVIDER_ORDER.filter(p =>
  SUPPORTED_MODELS.some(m => m.provider === p)
)
const allGroupedModels: Record<string, ModelOption[]> = {}
for (const p of allProviders) {
  allGroupedModels[p] = SUPPORTED_MODELS.filter((m) => m.provider === p)
}

interface Props {
  selectedModel: string
  onSelectModel: (modelId: string) => void
}

export function ModelSelector({ selectedModel, onSelectModel }: Props) {
  const [open, setOpen] = useState(false)
  const [anthropicStatus, setAnthropicStatus] = useState<any>(null)
  const [codexStatus, setCodexStatus] = useState<{ isLoggedIn: boolean; isExpired: boolean } | null>(null)
  const [codexLoggingIn, setCodexLoggingIn] = useState(false)
  const [codexLoginError, setCodexLoginError] = useState<string | null>(null)
  const [anthropicSubStatus, setAnthropicSubStatus] = useState<{ isLoggedIn: boolean; isExpired: boolean } | null>(null)
  const [anthropicSubLoggingIn, setAnthropicSubLoggingIn] = useState(false)
  const [anthropicSubLoginError, setAnthropicSubLoginError] = useState<string | null>(null)
  const [showAnthropicDialog, setShowAnthropicDialog] = useState(false)
  const [showOpenAIDialog, setShowOpenAIDialog] = useState(false)
  const [showDeepSeekDialog, setShowDeepSeekDialog] = useState(false)
  // Tracks the model the user clicked while it was missing a key.
  // Falls back to `selectedModel` so the dialog never receives `null`.
  const [pendingModelId, setPendingModelId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const api = (window as any).api

  // Claude Subscription is enabled by default (the OAuth handlers are always wired)
  const providers = allProviders
  const groupedModels = allGroupedModels

  const current = SUPPORTED_MODELS.find((m) => m.id === selectedModel)

  const refreshAnthropicStatus = useCallback(async () => {
    try {
      const status = await api?.getAnthropicAuthStatus?.()
      setAnthropicStatus(status ?? null)
    } catch {
      setAnthropicStatus(null)
    }
  }, [api])

  const refreshCodexStatus = useCallback(async () => {
    try {
      const status = await api?.getOpenAICodexStatus?.()
      setCodexStatus(status ?? null)
    } catch {
      setCodexStatus(null)
    }
  }, [api])

  const refreshAnthropicSubStatus = useCallback(async () => {
    try {
      const status = await api?.getAnthropicSubStatus?.()
      setAnthropicSubStatus(status ?? null)
    } catch {
      setAnthropicSubStatus(null)
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
    refreshCodexStatus()
    refreshAnthropicSubStatus()
    const unsub = api?.onAnthropicAuthStatus?.((status: any) => setAnthropicStatus(status))
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [api, refreshAnthropicStatus, refreshCodexStatus, refreshAnthropicSubStatus])

  const handleCodexLogin = async () => {
    setCodexLoggingIn(true)
    setCodexLoginError(null)
    try {
      const result = await api?.openaiCodexLogin?.()
      if (result?.success) {
        await refreshCodexStatus()
      } else {
        setCodexLoginError(result?.error || 'ChatGPT sign-in failed')
      }
    } catch (err: any) {
      setCodexLoginError(err?.message || 'ChatGPT sign-in failed')
    } finally {
      setCodexLoggingIn(false)
    }
  }

  const handleCodexCancel = async () => {
    await api?.openaiCodexCancel?.()
  }

  const handleCodexLogout = async () => {
    await api?.openaiCodexLogout?.()
    await refreshCodexStatus()
  }

  const handleAnthropicSubLogin = async () => {
    setAnthropicSubLoggingIn(true)
    setAnthropicSubLoginError(null)
    try {
      const result = await api?.anthropicSubLogin?.()
      if (result?.success) {
        await refreshAnthropicSubStatus()
      } else {
        setAnthropicSubLoginError(result?.error || 'Anthropic sign-in failed')
      }
    } catch (err: any) {
      setAnthropicSubLoginError(err?.message || 'Anthropic sign-in failed')
    } finally {
      setAnthropicSubLoggingIn(false)
    }
  }

  const handleAnthropicSubCancel = async () => {
    await api?.anthropicSubCancel?.()
  }

  const handleAnthropicSubLogout = async () => {
    await api?.anthropicSubLogout?.()
    await refreshAnthropicSubStatus()
  }

  const handleModelSelect = async (model: ModelOption) => {
    const { provider } = parseModelKey(model.id)

    if (provider === 'openai-codex') {
      // Subscription models need OAuth login
      if (!codexStatus?.isLoggedIn) {
        await handleCodexLogin()
        const status = await api?.getOpenAICodexStatus?.()
        if (!status?.isLoggedIn) {
          setOpen(false)
          return
        }
      }
      onSelectModel(model.id)
      setOpen(false)
      return
    }

    if (provider === 'anthropic-sub') {
      if (!anthropicSubStatus?.isLoggedIn) {
        await handleAnthropicSubLogin()
        const status = await api?.getAnthropicSubStatus?.()
        if (!status?.isLoggedIn) {
          setOpen(false)
          return
        }
      }
      onSelectModel(model.id)
      setOpen(false)
      return
    }

    if (provider === 'openai') {
      const status = await api?.getOpenAIAuthStatus?.()
      if (!status?.hasApiKey) {
        setPendingModelId(model.id)
        setShowOpenAIDialog(true)
        setOpen(false)
        return
      }
    }

    if (provider === 'anthropic') {
      const status = await api?.getAnthropicAuthStatus?.()
      if (!status?.hasApiKeyFallback) {
        setPendingModelId(model.id)
        setShowAnthropicDialog(true)
        setOpen(false)
        return
      }
    }

    if (provider === 'deepseek') {
      const status = await api?.getApiKeyStatus?.()
      if (!status?.DEEPSEEK_API_KEY) {
        setPendingModelId(model.id)
        setShowDeepSeekDialog(true)
        setOpen(false)
        return
      }
    }

    onSelectModel(model.id)
    setOpen(false)
    refreshAnthropicStatus()
  }

  // Auth suffix — shown inline in the button label so users can tell at a
  // glance whether they're on a subscription or an API key.
  const { provider: currentProvider } = current
    ? parseModelKey(current.id)
    : { provider: '' }

  const authSuffix =
    currentProvider === 'anthropic-sub' || currentProvider === 'openai-codex'
      ? 'sub'
      : currentProvider === 'openai' || currentProvider === 'anthropic'
      ? 'api'
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
        <span className="truncate max-w-[108px]">
          {current?.label || selectedModel}
          {authSuffix && <span className="t-text-muted"> ({authSuffix})</span>}
        </span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl z-50" role="listbox" aria-label="Available models">
          {providers.map((provider) => (
            <div key={provider}>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider t-text-muted sticky top-0 t-bg-surface">
                {provider}
              </div>

              {/* Provider sub-label */}
              {provider === 'ChatGPT Subscription' && (
                <div className="px-3 pb-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] t-text-muted">
                      {codexStatus?.isLoggedIn
                        ? 'Signed in'
                        : codexLoggingIn
                        ? 'Waiting for browser…'
                        : 'OAuth required'}
                    </span>
                    {codexStatus?.isLoggedIn ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCodexLogout() }}
                        className="text-[10px] t-text-muted hover:t-text flex items-center gap-0.5"
                      >
                        <LogOut size={10} /> Sign out
                      </button>
                    ) : codexLoggingIn ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCodexCancel() }}
                        className="text-[10px] t-text-error flex items-center gap-0.5 hover:opacity-80"
                      >
                        <X size={10} /> Cancel
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCodexLogin() }}
                        className="text-[10px] t-text-accent flex items-center gap-0.5 hover:opacity-80"
                      >
                        <LogIn size={10} /> Sign in
                      </button>
                    )}
                  </div>
                  {codexLoginError && !codexLoggingIn && (
                    <p className="text-[10px] t-text-error mt-1 leading-snug" role="alert">
                      {codexLoginError}
                    </p>
                  )}
                </div>
              )}
              {provider === 'Claude Subscription' && (
                <div className="px-3 pb-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] t-text-muted">
                      {anthropicSubStatus?.isLoggedIn
                        ? 'Signed in'
                        : anthropicSubLoggingIn
                        ? 'Waiting for browser…'
                        : 'OAuth required'}
                    </span>
                    {anthropicSubStatus?.isLoggedIn ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAnthropicSubLogout() }}
                        className="text-[10px] t-text-muted hover:t-text flex items-center gap-0.5"
                      >
                        <LogOut size={10} /> Sign out
                      </button>
                    ) : anthropicSubLoggingIn ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAnthropicSubCancel() }}
                        className="text-[10px] t-text-error flex items-center gap-0.5 hover:opacity-80"
                      >
                        <X size={10} /> Cancel
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAnthropicSubLogin() }}
                        className="text-[10px] t-text-accent flex items-center gap-0.5 hover:opacity-80"
                      >
                        <LogIn size={10} /> Sign in
                      </button>
                    )}
                  </div>
                  {anthropicSubLoginError && !anthropicSubLoggingIn && (
                    <p className="text-[10px] t-text-error mt-1 leading-snug" role="alert">
                      {anthropicSubLoginError}
                    </p>
                  )}
                </div>
              )}
              {(provider === 'OpenAI' || provider === 'Anthropic' || provider === 'DeepSeek') && (
                <div className="px-3 pb-1 text-[11px] t-text-muted">
                  API Key
                </div>
              )}

              {groupedModels[provider].map((model) => {
                const caps = getModelCapabilities(model.id)
                return (
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
                    <span className="truncate flex-1">{model.label}</span>
                    {/* Capability badge: vision-capable models get an image icon;
                        text-only models get a "Text" tag so users can spot them
                        before sending images. */}
                    {caps.vision ? (
                      <span
                        className="shrink-0 inline-flex items-center gap-0.5 text-[10px] t-text-muted"
                        title="Supports image input"
                      >
                        <ImageIcon size={10} />
                      </span>
                    ) : (
                      <span
                        className="shrink-0 inline-flex items-center gap-0.5 text-[10px] t-text-muted"
                        title="Text-only — no image input"
                      >
                        <FileText size={10} /> Text
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {(showOpenAIDialog || showAnthropicDialog || showDeepSeekDialog) && (
        <ApiKeyDialog
          provider={showOpenAIDialog ? 'OpenAI' : showAnthropicDialog ? 'Anthropic' : 'DeepSeek'}
          keyName={showOpenAIDialog ? 'OPENAI_API_KEY' : showAnthropicDialog ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY'}
          placeholder={showOpenAIDialog ? 'sk-...' : showAnthropicDialog ? 'sk-ant-...' : 'sk-...'}
          onClose={() => {
            setShowOpenAIDialog(false)
            setShowAnthropicDialog(false)
            setShowDeepSeekDialog(false)
            setPendingModelId(null)
          }}
          onSaved={(model) => {
            setShowOpenAIDialog(false)
            setShowAnthropicDialog(false)
            setShowDeepSeekDialog(false)
            setPendingModelId(null)
            // Select the model that triggered the dialog (NOT the previous
            // active model — that bug made users have to pick the model again
            // after entering the key).
            onSelectModel(model)
            refreshAnthropicStatus()
          }}
          pendingModel={pendingModelId ?? selectedModel}
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

  // Portal to <body> so the modal escapes any transformed/contained
  // ancestor in the left sidebar (a fixed element gets trapped by ancestors
  // with `transform`, `filter`, `contain`, etc., which collapsed the dialog
  // into a thin strip on the right edge before).
  return createPortal(
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
    </div>,
    document.body
  )
}
