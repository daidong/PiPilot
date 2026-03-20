import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, Check, Cpu } from 'lucide-react'
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
  const [anthropicCopyHint, setAnthropicCopyHint] = useState<string | null>(null)
  const [showOpenAIDialog, setShowOpenAIDialog] = useState(false)
  const [openAICopyHint, setOpenAICopyHint] = useState<string | null>(null)
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
        setOpenAICopyHint(null)
        setOpen(false)
        return
      }
    }

    if (model.provider === 'Anthropic') {
      const status = await api?.getAnthropicAuthStatus?.()
      if (!status?.hasApiKeyFallback) {
        setShowAnthropicDialog(true)
        setAnthropicCopyHint(null)
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
        className="no-drag flex items-center gap-1.5 px-2 py-1.5 rounded-lg t-text-secondary text-xs font-medium t-bg-hover transition-colors"
        title="Select model"
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
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

      {showOpenAIDialog && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="openai-dialog-title">
          <div className="w-full max-w-md rounded-xl border t-border t-bg-surface shadow-2xl p-4 space-y-3">
            <div>
              <div id="openai-dialog-title" className="text-sm font-semibold t-text">OpenAI API Key Required</div>
              <div className="text-xs t-text-secondary mt-1">
                OpenAI models require <code className="px-1 rounded t-bg-surface">OPENAI_API_KEY</code>.
              </div>
            </div>
            <div className="rounded-lg border t-border t-bg-base/60 p-3 space-y-2">
              <div className="text-xs font-medium t-text">How to set it</div>
              <ol className="text-xs t-text-secondary space-y-1 list-decimal pl-4">
                <li>Open your environment config (for example project <code className="px-1 rounded t-bg-surface">.env</code>).</li>
                <li>Add <code className="px-1 rounded t-bg-surface">OPENAI_API_KEY=sk-...</code>.</li>
                <li>Restart the app, then select the OpenAI model again.</li>
              </ol>
              <div className="flex items-center gap-2">
                <code className="text-[11px] px-2 py-1 rounded t-bg-surface border t-border">OPENAI_API_KEY=sk-...</code>
                <button
                  className="px-2 py-1 rounded text-[11px] t-bg-hover t-text-secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText('OPENAI_API_KEY=sk-...')
                      setOpenAICopyHint('Template copied')
                    } catch {
                      setOpenAICopyHint('Copy failed')
                    }
                    setTimeout(() => setOpenAICopyHint(null), 1500)
                  }}
                >
                  Copy
                </button>
                {openAICopyHint && <span className="text-[11px] t-text-muted">{openAICopyHint}</span>}
              </div>
            </div>
            <div className="flex items-center justify-end">
              <button
                className="px-3 py-1.5 rounded-lg text-xs t-bg-accent text-white hover:opacity-90"
                onClick={() => setShowOpenAIDialog(false)}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}

      {showAnthropicDialog && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="anthropic-dialog-title">
          <div className="w-full max-w-md rounded-xl border t-border t-bg-surface shadow-2xl p-4 space-y-3">
            <div>
              <div id="anthropic-dialog-title" className="text-sm font-semibold t-text">Anthropic API Key Required</div>
              <div className="text-xs t-text-secondary mt-1">
                Anthropic models require <code className="px-1 rounded t-bg-surface">ANTHROPIC_API_KEY</code>.
              </div>
            </div>
            <div className="rounded-lg border t-border t-bg-base/60 p-3 space-y-2">
              <div className="text-xs font-medium t-text">How to set it</div>
              <ol className="text-xs t-text-secondary space-y-1 list-decimal pl-4">
                <li>Open your environment config (for example project <code className="px-1 rounded t-bg-surface">.env</code>).</li>
                <li>Add <code className="px-1 rounded t-bg-surface">ANTHROPIC_API_KEY=sk-ant-...</code>.</li>
                <li>Restart the app, then select the Anthropic model again.</li>
              </ol>
              <div className="flex items-center gap-2">
                <code className="text-[11px] px-2 py-1 rounded t-bg-surface border t-border">ANTHROPIC_API_KEY=sk-ant-...</code>
                <button
                  className="px-2 py-1 rounded text-[11px] t-bg-hover t-text-secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText('ANTHROPIC_API_KEY=sk-ant-...')
                      setAnthropicCopyHint('Template copied')
                    } catch {
                      setAnthropicCopyHint('Copy failed')
                    }
                    setTimeout(() => setAnthropicCopyHint(null), 1500)
                  }}
                >
                  Copy
                </button>
                {anthropicCopyHint && <span className="text-[11px] t-text-muted">{anthropicCopyHint}</span>}
              </div>
            </div>
            <div className="flex items-center justify-end">
              <button
                className="px-3 py-1.5 rounded-lg text-xs t-bg-accent text-white hover:opacity-90"
                onClick={() => setShowAnthropicDialog(false)}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
