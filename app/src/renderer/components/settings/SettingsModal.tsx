import React, { useState, useEffect, useRef } from 'react'
import { X, Key, BookOpen, BarChart2, BookMarked } from 'lucide-react'
import { ApiKeysSettings } from './ApiKeysSettings'
import { ResearchSettings } from './ResearchSettings'
import { DataAnalysisSettings } from './DataAnalysisSettings'
import { WikiAgentSettings } from './WikiAgentSettings'
import type { AppSettings } from '../../../../../shared-ui/settings-types'
import { DEFAULT_SETTINGS } from '../../../../../shared-ui/settings-types'

const api = (window as any).api

type SettingsTab = 'api-keys' | 'research' | 'data-analysis' | 'paper-wiki'

const TABS: { id: SettingsTab; label: string; icon: typeof Key }[] = [
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'research', label: 'Research', icon: BookOpen },
  { id: 'data-analysis', label: 'Data Analysis', icon: BarChart2 },
  { id: 'paper-wiki', label: 'Paper Wiki', icon: BookMarked },
]

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: SettingsTab
}

export type { SettingsTab }

// CSS selector for focusable elements inside the dialog — used by the
// focus trap and the initial-focus effect.
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getVisibleFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null)
}

export function SettingsModal({ open, onClose, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'api-keys')
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Reset tab when initialTab prop changes and modal opens
  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab)
    }
  }, [open, initialTab])

  // Load settings on open
  useEffect(() => {
    if (!open) return
    api.loadSettings?.().then((s: AppSettings | null) => {
      if (s) setSettings(s)
      setLoaded(true)
      setDirty(false)
    }).catch(() => setLoaded(true))
  }, [open])

  // ── Dialog a11y: focus management + Escape + Tab trap ─────────────────
  //
  // On open: capture the element that had focus so we can restore it on
  // close, then move focus into the panel. On close: restore focus to the
  // trigger. While open: Escape closes; Tab cycles focus inside the panel.

  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement as HTMLElement | null

    // Defer to the next frame so the panel has mounted + laid out before
    // we query for focusable children.
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const focusable = getVisibleFocusable(panel)
      const first = focusable[0] ?? panel
      first.focus()
    })

    return () => {
      cancelAnimationFrame(frame)
      // Restore focus to whatever opened the dialog, but only if that
      // element still exists in the document.
      if (trigger && document.contains(trigger)) {
        trigger.focus?.()
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = getVisibleFocusable(panel)
      if (focusable.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      // If focus has somehow escaped the panel entirely, pull it back.
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [open, onClose])

  const updateSettings = (patch: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      // Deep merge for nested objects
      if (patch.research) next.research = { ...prev.research, ...patch.research }
      if (patch.dataAnalysis) next.dataAnalysis = { ...prev.dataAnalysis, ...patch.dataAnalysis }
      if (patch.wikiAgent) next.wikiAgent = { ...prev.wikiAgent, ...patch.wikiAgent }
      return next
    })
    setDirty(true)
  }

  // Auto-save when settings change (with a short delay to batch rapid clicks)
  useEffect(() => {
    if (!dirty || !loaded) return
    const timer = setTimeout(() => {
      api.saveSettings?.(settings).catch(() => {})
      setDirty(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [settings, dirty, loaded])

  if (!open) return null

  const activeLabel = TABS.find(t => t.id === activeTab)?.label ?? 'Settings'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop — opaque shade only, no blur (M1).
          No click-to-close to prevent accidental dismissal. */}
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />

      {/* Panel — a proper dialog landmark (C1) */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="relative w-full max-w-2xl h-[520px] rounded-xl border t-border t-bg-surface shadow-xl flex overflow-hidden outline-none"
      >
        {/* Left sidebar nav — h1 is the stable dialog title (H5) */}
        <nav
          aria-label="Settings categories"
          className="w-48 shrink-0 border-r t-border t-bg-base flex flex-col py-4 px-2"
        >
          <h1
            id="settings-dialog-title"
            className="px-3 mb-3 text-sm font-semibold t-text tracking-tight"
          >
            Settings
          </h1>
          <div className="space-y-0.5">
            {TABS.map(tab => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                    ${active
                      ? 't-text-accent bg-[var(--color-accent)]/10'
                      : 't-text-secondary hover:t-text hover:t-bg-hover'
                    }
                  `}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              )
            })}
          </div>
          <div className="flex-1" />
          <p className="px-3 text-[10px] t-text-muted leading-relaxed">
            Keys are stored in<br />
            <code className="font-mono">~/.research-copilot/</code>
          </p>
        </nav>

        {/* Right content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header with close button. Tab-section heading is h2 under the
              dialog's h1 "Settings" title. */}
          <div className="flex items-center justify-between px-6 pt-4 pb-2">
            <h2 className="text-sm font-semibold t-text">
              {activeLabel}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg t-text-muted hover:t-text hover:t-bg-hover transition-colors"
              aria-label="Close settings"
            >
              <X size={16} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 pb-4">
            {activeTab === 'api-keys' && (
              <ApiKeysSettings />
            )}
            {activeTab === 'research' && loaded && (
              <ResearchSettings
                researchIntensity={settings.research.researchIntensity}
                webSearchDepth={settings.research.webSearchDepth}
                autoSaveSensitivity={settings.research.autoSaveSensitivity}
                onChangeIntensity={v => updateSettings({ research: { ...settings.research, researchIntensity: v } })}
                onChangeWebDepth={v => updateSettings({ research: { ...settings.research, webSearchDepth: v } })}
                onChangeAutoSave={v => updateSettings({ research: { ...settings.research, autoSaveSensitivity: v } })}
              />
            )}
            {activeTab === 'data-analysis' && loaded && (
              <DataAnalysisSettings
                executionTimeLimit={settings.dataAnalysis.executionTimeLimit}
                onChange={v => updateSettings({ dataAnalysis: { executionTimeLimit: v } })}
              />
            )}
            {activeTab === 'paper-wiki' && loaded && (
              <WikiAgentSettings
                model={settings.wikiAgent?.model ?? 'none'}
                speed={settings.wikiAgent?.speed ?? 'medium'}
                onChangeModel={v => updateSettings({ wikiAgent: { ...settings.wikiAgent, model: v } })}
                onChangeSpeed={v => updateSettings({ wikiAgent: { ...settings.wikiAgent, speed: v } })}
              />
            )}
          </div>

          {/* Footer note for non-api-keys tabs */}
          {activeTab !== 'api-keys' && (
            <div className="px-6 py-2.5 border-t t-border-subtle">
              <p className="text-[10px] t-text-muted">
                Settings are saved automatically. Changes to research and analysis settings take effect for new agent sessions. Existing sessions require an app restart.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
