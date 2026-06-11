import type { AuditGraph, GraphNode } from '../../../../../../lib/audit-graph/index'

export interface AuditSearchMatch {
  id: string
  nodeId: string
  nodeLabel: string
  nodeKind: GraphNode['kind']
  field: string
  eventName?: string
  excerpt: string
  matchStart: number
  matchEnd: number
}

interface SearchEntry {
  node: GraphNode
  field: string
  eventName?: string
  text: string
}

const EXCERPT_RADIUS = 72

function normalizeText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function makeExcerpt(text: string, index: number, queryLength: number): { excerpt: string; matchStart: number; matchEnd: number } {
  const from = Math.max(0, index - EXCERPT_RADIUS)
  const to = Math.min(text.length, index + queryLength + EXCERPT_RADIUS)
  const prefix = from > 0 ? '...' : ''
  const suffix = to < text.length ? '...' : ''
  const excerpt = `${prefix}${text.slice(from, to)}${suffix}`.replace(/\s+/g, ' ').trim()
  const prefixOffset = prefix.length
  return {
    excerpt,
    matchStart: prefixOffset + index - from,
    matchEnd: prefixOffset + index - from + queryLength,
  }
}

function addEntry(entries: SearchEntry[], node: GraphNode, field: string, value: unknown, eventName?: string): void {
  const text = normalizeText(value)
  if (!text.trim()) return
  entries.push({ node, field, eventName, text })
}

function buildEntries(graph: AuditGraph): SearchEntry[] {
  const entries: SearchEntry[] = []
  for (const node of graph.nodes) {
    addEntry(entries, node, 'label', node.label)
    addEntry(entries, node, 'path', node.path)
    addEntry(entries, node, 'title', node.title)
    addEntry(entries, node, 'tool', node.toolName)
    addEntry(entries, node, 'model', node.model)
    addEntry(entries, node, 'trace', node.traceId)
    addEntry(entries, node, 'span', node.spanId)
    for (const event of node.rawEvents ?? []) {
      addEntry(entries, node, 'event', event.name, event.name)
      addEntry(entries, node, EVENT_FIELD_LABELS[event.name] ?? 'input/output', event.body, event.name)
    }
  }
  return entries
}

const EVENT_FIELD_LABELS: Record<string, string> = {
  'pipilot.tool.args': 'tool input',
  'pipilot.tool.result': 'tool output',
  'pipilot.chat.request_payload': 'prompt input',
  'pipilot.chat.response_text': 'assistant output',
  'pipilot.chat.input_delta': 'context delta',
  'pipilot.compaction.summary_text': 'compaction summary',
}

export function searchAuditGraph(graph: AuditGraph, query: string, caseSensitive: boolean): AuditSearchMatch[] {
  const q = query.trim()
  if (!q) return []

  const needle = caseSensitive ? q : q.toLowerCase()
  const matches: AuditSearchMatch[] = []
  for (const entry of buildEntries(graph)) {
    const hay = caseSensitive ? entry.text : entry.text.toLowerCase()
    let from = 0
    while (from <= hay.length - needle.length) {
      const idx = hay.indexOf(needle, from)
      if (idx === -1) break
      const excerpt = makeExcerpt(entry.text, idx, q.length)
      matches.push({
        id: `${entry.node.id}:${entry.field}:${entry.eventName ?? 'attr'}:${idx}:${matches.length}`,
        nodeId: entry.node.id,
        nodeLabel: entry.node.label,
        nodeKind: entry.node.kind,
        field: entry.field,
        eventName: entry.eventName,
        ...excerpt,
      })
      from = idx + Math.max(needle.length, 1)
    }
  }
  return matches
}
