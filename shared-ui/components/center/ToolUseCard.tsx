import React, { useState, useEffect } from 'react'
import {
  CheckCircle2, AlertCircle, Loader2,
  ChevronRight,
  FileText, Terminal, Search, Globe, Wrench,
  BookOpen, Database, Sparkles
} from 'lucide-react'
import type { ToolEvent } from '../../stores/tool-events-store'
import { getToolDisplayName, getToolIcon } from '../../tool-renderers/registry'

// ─── Icon resolution ──────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  FileText, Terminal, Search, Globe, Wrench, BookOpen, Database, Sparkles
}

function getToolMeta(tool: string): { name: string; Icon: React.ElementType } {
  return {
    name: getToolDisplayName(tool),
    Icon: ICON_MAP[getToolIcon(tool)] || Wrench,
  }
}

// ─── Status icon ──────────────────────────────────

function StatusIcon({ status, size = 13 }: { status: ToolEvent['status']; size?: number }) {
  switch (status) {
    case 'running':
      return <Loader2 size={size} className="animate-spin t-text-accent-soft" />
    case 'success':
      return <CheckCircle2 size={size} className="t-text-success" />
    case 'error':
      return <AlertCircle size={size} className="t-text-error" />
  }
}

// ─── Duration formatter ──────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt)
  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => clearInterval(interval)
  }, [startedAt])
  return <span className="text-[10px] t-text-muted tabular-nums">{formatDuration(elapsed)}</span>
}

// ─── Compact completed tool line ──────────────────────────────────
// Like Claude Code: just a flat single line, no card chrome

const CompactToolLine = React.memo(function CompactToolLine({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const { name, Icon } = getToolMeta(event.tool)
  const displaySummary = event.resultSummary || event.summary
  const detailItems = buildDetailItems(event.tool, event.detail, event.resultDetail)
  const hasExpandable = detailItems.length > 0

  return (
    <div>
      <button
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={`w-full flex items-center gap-1.5 px-2 py-[3px] text-[11px] rounded transition-colors ${
          hasExpandable ? 'hover:t-bg-hover cursor-pointer' : 'cursor-default'
        }`}
      >
        <StatusIcon status={event.status} size={11} />
        <Icon size={10} className="t-text-muted shrink-0" />
        <span className="font-medium t-text-secondary shrink-0">{name}</span>
        <span className="t-text-muted select-none">·</span>
        <span className="t-text-muted truncate flex-1 text-left">{displaySummary}</span>
        {event.durationMs != null && (
          <span className="text-[10px] t-text-muted tabular-nums shrink-0">{formatDuration(event.durationMs)}</span>
        )}
        {hasExpandable && (
          <span className="t-text-muted shrink-0 transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            <ChevronRight size={9} />
          </span>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mr-2 mb-1 mt-0.5">
          <ExpandedDetail event={event} />
        </div>
      )}
    </div>
  )
})

// ─── Full card for running tools ──────────────────────────────────

const RunningToolCard = React.memo(function RunningToolCard({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const { name, Icon } = getToolMeta(event.tool)
  const displaySummary = event.summary
  const detailItems = buildDetailItems(event.tool, event.detail, event.resultDetail)
  const hasExpandable = detailItems.length > 0 || event.progress

  return (
    <div className="rounded-lg border t-border t-bg-surface shadow-sm overflow-hidden">
      <button
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
          hasExpandable ? 'hover:t-bg-hover cursor-pointer' : 'cursor-default'
        }`}
      >
        <StatusIcon status={event.status} />
        <Icon size={12} className="t-text-accent-soft shrink-0" />
        <span className="font-medium t-text shrink-0">{name}</span>
        <span className="t-text-muted select-none">·</span>
        <span className="t-text-secondary truncate flex-1 text-left">{displaySummary}</span>
        <ElapsedTimer startedAt={event.startedAt} />
        {hasExpandable && (
          <span className="t-text-muted shrink-0 transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            <ChevronRight size={10} />
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t t-border px-3 py-2">
          <ExpandedDetail event={event} />
        </div>
      )}

      {/* Inline progress for running tools (always visible, no expand needed) */}
      {!expanded && event.progress && (
        <div className="border-t t-border px-3 py-1.5">
          <pre className="text-[10px] font-mono t-text-muted overflow-hidden max-h-14 leading-relaxed whitespace-pre-wrap">
            {event.progress}
          </pre>
        </div>
      )}
    </div>
  )
})

// ─── Public component ──────────────────────────────────

interface ToolUseCardProps {
  event: ToolEvent
  /** Compact mode: renders as flat inline text, no card chrome */
  compact?: boolean
}

export const ToolUseCard = React.memo(function ToolUseCard({ event, compact }: ToolUseCardProps) {
  if (compact || event.status !== 'running') {
    return <CompactToolLine event={event} />
  }
  return <RunningToolCard event={event} />
})

// ─── Shared expanded detail ──────────────────────────────────

function ExpandedDetail({ event }: { event: ToolEvent }) {
  const items = buildDetailItems(event.tool, event.detail, event.resultDetail)
  const hasProgress = !!event.progress

  if (items.length === 0 && !hasProgress) return null

  return (
    <div className="space-y-1.5">
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map((item, i) => (
            <DetailItem key={i} {...item} />
          ))}
        </div>
      )}
      {hasProgress && (
        <pre className="p-2 rounded t-bg-base text-[10px] font-mono t-text-secondary overflow-x-auto max-h-28 overflow-y-auto leading-relaxed whitespace-pre-wrap border t-border-subtle">
          {event.progress}
        </pre>
      )}
    </div>
  )
}

// ─── Detail items ──────────────────────────────────

interface DetailItemData {
  type: 'path' | 'code' | 'kv' | 'stat'
  label?: string
  value: string
}

function DetailItem({ type, label, value }: DetailItemData) {
  switch (type) {
    case 'path':
      return (
        <div className="flex items-center gap-1.5 text-[11px]">
          <FileText size={10} className="t-text-muted shrink-0" />
          <span className="font-mono t-text-secondary truncate" title={value}>{value}</span>
        </div>
      )
    case 'code':
      return (
        <pre className="p-2 rounded t-bg-base text-[10px] font-mono t-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap border t-border-subtle">
          {value}
        </pre>
      )
    case 'stat':
      return (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="t-text-muted">{label}</span>
          <span className="font-medium t-text-secondary tabular-nums">{value}</span>
        </div>
      )
    case 'kv':
    default:
      return (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="t-text-muted shrink-0 text-[10px]">{label}</span>
          <span className="t-text-secondary font-mono truncate" title={value}>{value}</span>
        </div>
      )
  }
}

/** Build meaningful detail items per tool type */
function buildDetailItems(
  tool: string,
  detail?: Record<string, unknown>,
  resultDetail?: Record<string, unknown>
): DetailItemData[] {
  const items: DetailItemData[] = []
  if (!detail && !resultDetail) return items

  switch (tool) {
    case 'read': {
      const path = detail?.path as string
      if (path) items.push({ type: 'path', value: path })
      const lineCount = resultDetail?.lineCount as number
      if (lineCount) items.push({ type: 'stat', label: 'Lines read', value: String(lineCount) })
      break
    }
    case 'write':
    case 'edit': {
      const path = detail?.path as string || resultDetail?.path as string
      if (path) items.push({ type: 'path', value: path })
      break
    }
    case 'bash': {
      const cmd = detail?.command as string
      if (cmd) items.push({ type: 'code', value: `$ ${cmd}` })
      const preview = resultDetail?.outputPreview as string
      if (preview) items.push({ type: 'code', value: preview })
      const lines = resultDetail?.outputLines as number
      if (lines && !preview) items.push({ type: 'stat', label: 'Output', value: `${lines} lines` })
      break
    }
    case 'grep': {
      const pattern = detail?.pattern as string
      const path = detail?.path as string
      if (pattern) items.push({ type: 'kv', label: 'Pattern', value: pattern })
      if (path) items.push({ type: 'kv', label: 'Path', value: path })
      const count = resultDetail?.matchCount as number
      if (count != null) items.push({ type: 'stat', label: 'Matches', value: String(count) })
      break
    }
    case 'glob': {
      const pattern = detail?.pattern as string
      if (pattern) items.push({ type: 'kv', label: 'Pattern', value: pattern })
      const count = resultDetail?.fileCount as number
      if (count != null) items.push({ type: 'stat', label: 'Files found', value: String(count) })
      break
    }
    case 'fetch':
    case 'web_fetch': {
      const url = detail?.url as string
      if (url) items.push({ type: 'kv', label: 'URL', value: url })
      const size = resultDetail?.sizeKB as number || resultDetail?.charCount as number
      if (size) items.push({ type: 'stat', label: 'Received', value: size > 1024 ? `${(size / 1024).toFixed(1)}MB` : `${size}KB` })
      break
    }
    case 'web_search': {
      const query = detail?.query as string
      if (query) items.push({ type: 'kv', label: 'Query', value: query })
      break
    }
    case 'literature-search': {
      const query = detail?.query as string
      if (query) items.push({ type: 'kv', label: 'Query', value: query })
      const found = resultDetail?.papersFound as number
      const saved = resultDetail?.papersSaved as number
      const coverage = resultDetail?.coverage as number
      if (found != null) items.push({ type: 'stat', label: 'Papers found', value: String(found) })
      if (saved != null && saved > 0) items.push({ type: 'stat', label: 'Saved', value: String(saved) })
      if (coverage != null) items.push({ type: 'stat', label: 'Coverage', value: `${Math.round(coverage * 100)}%` })
      break
    }
    case 'artifact-create':
    case 'artifact-update': {
      const type = detail?.type as string || resultDetail?.type as string
      const title = detail?.title as string || resultDetail?.title as string
      if (type) items.push({ type: 'kv', label: 'Type', value: type })
      if (title) items.push({ type: 'kv', label: 'Title', value: title })
      break
    }
    case 'artifact-search': {
      const query = detail?.query as string
      if (query) items.push({ type: 'kv', label: 'Query', value: query })
      break
    }
    default: {
      const skipKeys = new Set(['success', 'path'])
      const source = { ...detail, ...resultDetail }
      for (const [key, val] of Object.entries(source)) {
        if (val == null || skipKeys.has(key)) continue
        const strVal = typeof val === 'string' ? val : JSON.stringify(val)
        if (strVal.length === 0 || strVal === 'true' || strVal === 'false') continue
        items.push({ type: 'kv', label: key, value: strVal })
      }
      break
    }
  }
  return items
}
