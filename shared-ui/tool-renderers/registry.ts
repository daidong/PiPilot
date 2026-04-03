import type { ToolRenderConfig } from './types'

// ─── Utility helpers ──────────────────────────────────

function getFileName(path: string): string {
  if (!path) return ''
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function truncStr(s: string | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max - 3) + '...' : s
}

function safeRecord(obj: unknown): Record<string, unknown> {
  return (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>
}

function extractResultText(result: unknown): string {
  const r = safeRecord(result)
  const content = r.content as any[]
  return (content?.[0]?.text as string) || ''
}

function lastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(Boolean)
  return lines.slice(-n).join('\n')
}

// ─── Tool configs ──────────────────────────────────

const configs: ToolRenderConfig[] = [
  // ── File tools ────────────────────────
  {
    name: 'read',
    displayName: 'Read',
    icon: 'FileText',
    category: 'file',
    formatCallSummary: (a) => {
      const path = (a.path as string) || ''
      const offset = a.offset as number | undefined
      const limit = a.limit as number | undefined
      const suffix = offset ? ` · lines ${offset}-${offset + (limit || 2000)}` : ''
      return `${getFileName(path)}${suffix}`
    },
    formatCallDetail: (a) => ({ path: a.path, offset: a.offset, limit: a.limit }),
    formatResultSummary: (result) => {
      const text = extractResultText(result)
      const lineCount = text ? text.split('\n').length : 0
      return lineCount ? `${lineCount} lines` : 'Read completed'
    },
    formatResultDetail: (result) => {
      const text = extractResultText(result)
      return { lineCount: text ? text.split('\n').length : 0 }
    },
  },
  {
    name: 'write',
    displayName: 'Write',
    icon: 'FileText',
    category: 'file',
    formatCallSummary: (a) => getFileName((a.path as string) || ''),
    formatCallDetail: (a) => ({ path: a.path }),
    formatResultSummary: (_, a) => `Written: ${getFileName((a?.path as string) || '')}`,
    formatResultDetail: (_, a) => ({ path: a?.path }),
  },
  {
    name: 'edit',
    displayName: 'Edit',
    icon: 'FileText',
    category: 'file',
    formatCallSummary: (a) => getFileName((a.path as string) || ''),
    formatCallDetail: (a) => ({ path: a.path }),
    formatResultSummary: (_, a) => `Edited: ${getFileName((a?.path as string) || '')}`,
    formatResultDetail: (_, a) => ({ path: a?.path }),
  },

  // ── Code tools ────────────────────────
  {
    name: 'bash',
    displayName: 'Bash',
    icon: 'Terminal',
    category: 'code',
    formatCallSummary: (a) => {
      const cmd = (a.command as string) || ''
      return cmd.length > 60 ? `$ ${cmd.slice(0, 57)}...` : `$ ${cmd}`
    },
    formatCallDetail: (a) => ({ command: truncStr(a.command as string, 200) }),
    formatResultSummary: () => 'Command completed',
    formatResultDetail: (result) => {
      const text = extractResultText(result)
      const lines = text.split('\n').filter(Boolean)
      return { outputLines: lines.length, outputPreview: truncStr(lastNLines(text, 3), 200) }
    },
    formatProgress: (partial) => {
      const text = (partial as any)?.content?.[0]?.text
      if (typeof text === 'string' && text.length > 0) {
        return lastNLines(text, 5)
      }
      return undefined
    },
  },

  // ── Search tools ────────────────────────
  {
    name: 'grep',
    displayName: 'Search',
    icon: 'Search',
    category: 'search',
    formatCallSummary: (a) => `"${truncStr(a.pattern as string, 30)}"${a.path ? ` in ${a.path}` : ''}`,
    formatCallDetail: (a) => ({ pattern: a.pattern, path: a.path, glob: a.glob }),
    formatResultSummary: (result) => {
      const text = extractResultText(result)
      const count = text.split('\n').filter(Boolean).length
      return `${count} results`
    },
    formatResultDetail: (result) => {
      const text = extractResultText(result)
      return { matchCount: text.split('\n').filter(Boolean).length }
    },
  },
  {
    name: 'glob',
    displayName: 'Find Files',
    icon: 'Search',
    category: 'search',
    formatCallSummary: (a) => (a.pattern as string) || '',
    formatCallDetail: (a) => ({ pattern: a.pattern, path: a.path }),
    formatResultSummary: (result) => {
      const text = extractResultText(result)
      const count = text.split('\n').filter(Boolean).length
      return `${count} files`
    },
    formatResultDetail: (result) => {
      const text = extractResultText(result)
      return { fileCount: text.split('\n').filter(Boolean).length }
    },
  },
  {
    name: 'find',
    displayName: 'Find',
    icon: 'Search',
    category: 'search',
    formatCallSummary: (a) => truncStr(a.pattern as string || a.path as string, 40),
    formatCallDetail: (a) => ({ pattern: a.pattern, path: a.path }),
    formatResultSummary: () => 'Find completed',
    formatResultDetail: () => ({}),
  },
  {
    name: 'ls',
    displayName: 'List',
    icon: 'FileText',
    category: 'file',
    formatCallSummary: (a) => (a.path as string) || '.',
    formatCallDetail: (a) => ({ path: a.path }),
    formatResultSummary: () => 'Listed',
    formatResultDetail: () => ({}),
  },

  // ── Web tools ────────────────────────
  {
    name: 'fetch',
    displayName: 'Fetch',
    icon: 'Globe',
    category: 'web',
    formatCallSummary: (a) => truncStr(a.url as string, 50),
    formatCallDetail: (a) => ({ url: a.url }),
    formatResultSummary: (result) => {
      const text = extractResultText(result)
      const kb = (text.length / 1024).toFixed(1)
      return `${kb}KB received`
    },
    formatResultDetail: (result) => {
      const text = extractResultText(result)
      return { sizeKB: parseFloat((text.length / 1024).toFixed(1)) }
    },
  },
  {
    name: 'web_fetch',
    displayName: 'Web Fetch',
    icon: 'Globe',
    category: 'web',
    formatCallSummary: (a) => truncStr(a.url as string, 50),
    formatCallDetail: (a) => ({ url: a.url }),
    formatResultSummary: (result) => {
      const r = safeRecord(result)
      const data = safeRecord(r.data)
      const charCount = data.charCount as number | undefined
      if (charCount) return `${(charCount / 1024).toFixed(1)}KB received`
      return 'Fetch completed'
    },
    formatResultDetail: (result) => {
      const r = safeRecord(result)
      const data = safeRecord(r.data)
      return { charCount: data.charCount, url: data.url }
    },
  },
  {
    name: 'web_search',
    displayName: 'Web Search',
    icon: 'Globe',
    category: 'web',
    formatCallSummary: (a) => truncStr(a.query as string, 50),
    formatCallDetail: (a) => ({ query: a.query }),
    formatResultSummary: () => 'Search completed',
    formatResultDetail: () => ({}),
  },

  // ── Research tools ────────────────────────
  {
    name: 'literature-search',
    displayName: 'Literature Search',
    icon: 'BookOpen',
    category: 'research',
    formatCallSummary: (a) => truncStr(a.query as string, 40),
    formatCallDetail: (a) => ({ query: a.query, maxResults: a.max_results }),
    formatResultSummary: (result) => {
      const r = safeRecord(result)
      const data = safeRecord(r.data)
      const totalFound = (data.totalPapersFound as number) ?? 0
      const saved = (data.papersAutoSaved as number) ?? 0
      const coverage = data.coverage as { score?: number } | undefined
      if (totalFound > 0) {
        let s = `Found ${totalFound} papers`
        if (coverage?.score != null) s += ` (${Math.round(coverage.score * 100)}%)`
        if (saved > 0) s += `, saved ${saved}`
        return s
      }
      const local = (data.localPapersUsed as number) ?? 0
      const external = (data.externalPapersUsed as number) ?? 0
      return `Found ${local + external} papers`
    },
    formatResultDetail: (result) => {
      const r = safeRecord(result)
      const data = safeRecord(r.data)
      return {
        papersFound: (data.totalPapersFound as number) ?? 0,
        papersSaved: (data.papersAutoSaved as number) ?? 0,
        coverage: (data.coverage as any)?.score,
      }
    },
  },
  {
    name: 'lit-subtopic',
    displayName: 'Sub-topic Search',
    icon: 'BookOpen',
    category: 'research',
    formatCallSummary: (a) => (a._summary as string) || 'Searching sub-topic',
    formatCallDetail: (a) => ({ summary: a._summary }),
    formatResultSummary: (result) => (safeRecord(result).data as string) || 'Search completed',
    formatResultDetail: () => ({}),
  },
  {
    name: 'lit-enrich',
    displayName: 'Enrich Papers',
    icon: 'BookOpen',
    category: 'research',
    formatCallSummary: (a) => (a._summary as string) || 'Enriching paper metadata',
    formatCallDetail: (a) => ({ summary: a._summary }),
    formatResultSummary: (result) => (safeRecord(result).data as string) || 'Enriched metadata',
    formatResultDetail: () => ({}),
  },
  {
    name: 'lit-autosave',
    displayName: 'Save Papers',
    icon: 'BookOpen',
    category: 'research',
    formatCallSummary: (a) => (a._summary as string) || 'Saving papers',
    formatCallDetail: (a) => ({ summary: a._summary }),
    formatResultSummary: (result) => (safeRecord(result).data as string) || 'Saved papers',
    formatResultDetail: () => ({}),
  },
  {
    name: 'data_analyze',
    displayName: 'Data Analysis',
    icon: 'Database',
    category: 'research',
    formatCallSummary: (a) => getFileName((a.file_path as string) || '') || 'data',
    formatCallDetail: (a) => ({ file_path: a.file_path }),
    formatResultSummary: () => 'Analysis completed',
    formatResultDetail: () => ({}),
  },

  // ── Artifact tools ────────────────────────
  {
    name: 'artifact-create',
    displayName: 'Create Artifact',
    icon: 'Sparkles',
    category: 'memory',
    formatCallSummary: (a) => {
      const type = ((a.type as string) || 'artifact').toLowerCase()
      const title = truncStr(a.title as string, 35)
      return `${type}: ${title}`
    },
    formatCallDetail: (a) => ({ type: a.type, title: a.title }),
    formatResultSummary: (result) => {
      const data = safeRecord(safeRecord(result).data)
      const type = (data.type as string) || 'artifact'
      const title = truncStr(data.title as string, 30)
      return title ? `Created ${type}: ${title}` : `Created ${type}`
    },
    formatResultDetail: (result) => {
      const data = safeRecord(safeRecord(result).data)
      return { type: data.type, title: data.title }
    },
  },
  {
    name: 'artifact-update',
    displayName: 'Update Artifact',
    icon: 'Sparkles',
    category: 'memory',
    formatCallSummary: (a) => truncStr(a.id as string, 30),
    formatCallDetail: (a) => ({ id: a.id }),
    formatResultSummary: () => 'Updated',
    formatResultDetail: () => ({}),
  },
  {
    name: 'artifact-search',
    displayName: 'Search Artifacts',
    icon: 'Search',
    category: 'memory',
    formatCallSummary: (a) => truncStr(a.query as string, 40),
    formatCallDetail: (a) => ({ query: a.query, types: a.types }),
    formatResultSummary: () => 'Search completed',
    formatResultDetail: () => ({}),
  },

  // ── System tools ────────────────────────
  {
    name: 'convert_document',
    displayName: 'Convert Document',
    icon: 'FileText',
    category: 'system',
    formatCallSummary: (a) => getFileName((a.source as string) || ''),
    formatCallDetail: (a) => ({ source: a.source }),
    formatResultSummary: (result, a) => {
      const data = safeRecord(safeRecord(result).data)
      const skill = data.converterSkill as string
      const sourceName = getFileName((a?.source as string) || '')
      return skill ? `Converted ${sourceName} via ${skill}` : `Converted ${sourceName}`
    },
    formatResultDetail: (result) => {
      const data = safeRecord(safeRecord(result).data)
      return { converterSkill: data.converterSkill, outputFile: data.outputFile }
    },
  },
  {
    name: 'load_skill',
    displayName: 'Load Skill',
    icon: 'Sparkles',
    category: 'system',
    formatCallSummary: (a) => (a.name as string) || 'skill',
    formatCallDetail: (a) => ({ name: a.name }),
    formatResultSummary: (_, a) => `Loaded: ${(a?.name as string) || 'skill'}`,
    formatResultDetail: () => ({}),
  },
]

// ─── Registry ──────────────────────────────────

const registry = new Map<string, ToolRenderConfig>()
for (const config of configs) {
  registry.set(config.name, config)
}

/** Get the full render config for a tool, or undefined if not registered */
export function getToolRenderConfig(toolName: string): ToolRenderConfig | undefined {
  return registry.get(toolName)
}

/** Get a human-readable display name for a tool */
export function getToolDisplayName(toolName: string): string {
  return registry.get(toolName)?.displayName || toolName
}

/** Get the icon name for a tool */
export function getToolIcon(toolName: string): string {
  return registry.get(toolName)?.icon || 'Wrench'
}

/** Get the category for a tool */
export function getToolCategory(toolName: string): string {
  return registry.get(toolName)?.category || 'system'
}
