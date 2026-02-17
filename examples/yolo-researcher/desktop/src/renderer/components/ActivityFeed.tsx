import { useRef, useEffect, useMemo, useState } from 'react'
import { Bot, Wrench, MessageSquare, Play, CheckCircle, X } from 'lucide-react'
import type { ActivityItem } from '@/lib/types'
import { cleanStageRefs } from '@/lib/formatters'

interface ActivityFeedProps {
  items: ActivityItem[]
}

const ICON_MAP: Record<string, typeof Bot> = {
  planner_start: Play,
  planner_end: CheckCircle,
  coordinator_start: Play,
  coordinator_end: CheckCircle,
  tool_call: Wrench,
  tool_result: Wrench,
  llm_text: MessageSquare,
}

const KIND_LABEL: Record<string, string> = {
  planner_start: 'Planner thinking...',
  planner_end: 'Plan ready',
  coordinator_start: 'Coordinator executing...',
  coordinator_end: 'Execution complete',
  reviewer_start: 'Reviewer evaluating...',
  reviewer_end: 'Review complete',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  llm_text: 'LLM output',
}

type ActivityRow =
  | { type: 'item'; item: ActivityItem }
  | { type: 'tool_group'; id: string; items: ActivityItem[] }

function isToolActivity(item: ActivityItem): boolean {
  return item.kind === 'tool_call' || item.kind === 'tool_result'
}

function clock(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function prettifyKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map((line) => (line ? `${pad}${line}` : line)).join('\n')
}

function readableScalar(value: unknown): string {
  if (typeof value === 'string') return cleanStageRefs(value)
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value == null) return 'None'
  return String(value)
}

function readableFromValue(value: unknown, depth = 0): string {
  if (depth > 4) return '...'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return readableScalar(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return 'None'
    const limit = 20
    const clipped = value.slice(0, limit)
    const allPrimitive = clipped.every((v) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
    if (allPrimitive) {
      const joined = clipped.map((v) => readableScalar(v)).join(', ')
      return value.length > limit ? `${joined} ... (+${value.length - limit} more)` : joined
    }
    const lines = clipped.map((item, index) => {
      const body = readableFromValue(item, depth + 1)
      if (body.includes('\n')) return `${index + 1}.\n${indentLines(body, 2)}`
      return `${index + 1}. ${body}`
    })
    if (value.length > limit) lines.push(`... (+${value.length - limit} more)`)
    return lines.join('\n')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return 'No details'
    const limit = 30
    const clipped = entries.slice(0, limit)
    const lines = clipped.map(([key, nested]) => {
      const label = prettifyKey(key)
      const body = readableFromValue(nested, depth + 1)
      if (body.includes('\n')) return `${label}:\n${indentLines(body, 2)}`
      return `${label}: ${body}`
    })
    if (entries.length > limit) lines.push(`... (+${entries.length - limit} more fields)`)
    return lines.join('\n')
  }

  return String(value)
}

function tryParseStructuredPreview(raw: string): unknown | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const looksJson = (candidate.startsWith('{') && candidate.endsWith('}'))
    || (candidate.startsWith('[') && candidate.endsWith(']'))
  if (!looksJson) return null

  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function formatPreviewForDisplay(raw: string): string {
  const parsed = tryParseStructuredPreview(raw)
  if (parsed !== null) return readableFromValue(parsed)
  return cleanStageRefs(raw)
}

function formatPreviewSnippet(raw: string): string {
  const formatted = formatPreviewForDisplay(raw).trim()
  if (!formatted) return ''
  const lines = formatted.split('\n').slice(0, 4)
  const snippet = lines.join('\n')
  return snippet.length > 360 ? `${snippet.slice(0, 357)}...` : snippet
}

function LlmPreview({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <pre
      ref={preRef}
      className="mt-0.5 max-h-[10lh] overflow-y-auto whitespace-pre-wrap break-words t-text-muted font-[inherit]"
    >
      {text}
    </pre>
  )
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [previewModal, setPreviewModal] = useState<{
    id: string
    title: string
    rawText: string
    timestamp: string
  } | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [items[0]?.id])

  useEffect(() => {
    if (!previewModal) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreviewModal(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewModal])

  const rows = useMemo<ActivityRow[]>(() => {
    const next: ActivityRow[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!isToolActivity(item)) {
        next.push({ type: 'item', item })
        continue
      }

      const grouped: ActivityItem[] = [item]
      while (i + 1 < items.length && isToolActivity(items[i + 1])) {
        i += 1
        grouped.push(items[i])
      }

      next.push({
        type: 'tool_group',
        id: `tool-group-${grouped[0]?.id ?? i}-${grouped[grouped.length - 1]?.id ?? i}`,
        items: grouped,
      })
    }
    return next
  }, [items])

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border t-border t-bg-surface p-3 text-xs t-text-muted">
        No activity yet. Events will appear here when agents start working.
      </div>
    )
  }

  // Derive current phase from the most recent activity item
  const latestKind = items[0]?.kind
  const phaseLabel = (() => {
    switch (latestKind) {
      case 'planner_start': return 'Planning next step'
      case 'planner_end': return 'Plan ready'
      case 'coordinator_start': return 'Executing plan'
      case 'coordinator_end': return 'Execution complete'
      case 'reviewer_start': return 'Reviewing quality'
      case 'reviewer_end': return 'Review complete'
      default: return null
    }
  })()
  const isActivePhase = latestKind === 'planner_start' || latestKind === 'coordinator_start' || latestKind === 'reviewer_start'

  function openPreview(item: ActivityItem) {
    if (!item.preview || isToolActivity(item)) return
    const title = `${KIND_LABEL[item.kind] ?? item.kind}${item.tool ? ` · ${item.tool}` : ''}`
    setPreviewModal({
      id: item.id,
      title,
      rawText: item.preview,
      timestamp: item.timestamp,
    })
  }

  return (
    <>
      <div className="rounded-2xl border t-border t-bg-surface p-3">
        <div className="mb-2 flex items-center gap-2">
          <Bot size={14} className={isActivePhase ? 't-accent-teal animate-pulse' : 't-accent-teal'} />
          <span className="text-[11px] font-medium">{phaseLabel ?? 'Live Activity'}</span>
          {isActivePhase && <span className="text-[11px] t-text-muted animate-pulse">...</span>}
          <span className="text-[11px] t-text-muted">{items.length} events · {rows.length} visible</span>
        </div>
        <div ref={scrollRef} className="max-h-[320px] overflow-y-auto space-y-1">
          {rows.map((row) => {
            if (row.type === 'tool_group') {
              const names = Array.from(new Set(row.items.map((item) => item.tool).filter((tool): tool is string => Boolean(tool))))
              const toolSummary = names.length === 0
                ? 'multiple tools'
                : names.length <= 2
                  ? names.join(', ')
                  : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
              return (
                <div key={row.id} className="flex items-center gap-2 rounded-lg border t-border-subtle px-2 py-1 text-[11px]">
                  <Wrench size={12} className="shrink-0 t-text-muted" />
                  <div className="min-w-0 flex-1 truncate t-text-secondary">
                    Tool activity collapsed · {row.items.length} events · {toolSummary}
                  </div>
                  <span className="shrink-0 t-text-muted">{clock(row.items[0]?.timestamp ?? new Date().toISOString())}</span>
                </div>
              )
            }

            const item = row.item
            const Icon = ICON_MAP[item.kind] ?? Bot
            const isActive = item.kind === 'planner_start' || item.kind === 'coordinator_start'
            const previewSnippet = item.preview ? formatPreviewSnippet(item.preview) : ''

            return (
              <div key={item.id} className={`flex items-start gap-2 rounded-lg px-2 py-1 text-[11px] ${
                isActive ? 't-bg-elevated' : ''
              }`}>
                <Icon size={12} className={`mt-0.5 shrink-0 ${isActive ? 't-accent-teal animate-pulse' : 't-text-muted'}`} />
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{KIND_LABEL[item.kind] ?? item.kind}</span>
                  {item.tool && <span className="ml-1 t-text-secondary">&middot; {item.tool}</span>}
                  {previewSnippet && item.kind === 'llm_text' ? (
                    <button
                      onClick={() => openPreview(item)}
                      className="mt-0.5 w-full rounded-md text-left hover:t-bg-elevated"
                      title="Click to view full output"
                    >
                      <LlmPreview text={previewSnippet} />
                      <div className="mt-0.5 text-[10px] t-accent-teal">Click to view full output</div>
                    </button>
                  ) : previewSnippet ? (
                    <button
                      onClick={() => openPreview(item)}
                      className="mt-0.5 w-full rounded-md text-left hover:t-bg-elevated"
                      title="Click to view full output"
                    >
                      <div className="mt-0.5 whitespace-pre-wrap break-words t-text-muted">{previewSnippet}</div>
                      <div className="mt-0.5 text-[10px] t-accent-teal">Click to view full output</div>
                    </button>
                  ) : null}
                </div>
                <span className="shrink-0 t-text-muted">
                  {clock(item.timestamp)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {previewModal && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4"
          onClick={() => setPreviewModal(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-2xl border t-border t-bg-surface shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b t-border px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{previewModal.title}</div>
                <div className="text-[11px] t-text-muted">{clock(previewModal.timestamp)}</div>
              </div>
              <button
                onClick={() => setPreviewModal(null)}
                className="rounded-md border t-border p-1.5 t-text-secondary t-hoverable"
                aria-label="Close full output"
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px] leading-relaxed whitespace-pre-wrap break-words">
              {formatPreviewForDisplay(previewModal.rawText)}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
