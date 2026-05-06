/**
 * Tool name → `pipilot.tool.category` enum mapping.
 * Stable across releases — used as a span attribute (telemetry spec §6.4).
 *
 * When adding a new tool:
 * - exact name → add to TOOL_CATEGORIES
 * - family of names (e.g. all `wiki-*`) → add to TOOL_CATEGORY_PREFIXES
 *
 * Fallback is 'code', the broadest non-domain category. Inventing new
 * categories here without updating the enum will fail dev-mode validation.
 */

export type ToolCategory =
  | 'file'
  | 'shell'
  | 'code'
  | 'data-analysis'
  | 'literature'
  | 'web'
  | 'memory'
  | 'artifact'
  | 'document'
  | 'diagram'
  | 'wiki'
  | 'citation'
  | 'compute'

const TOOL_CATEGORIES: ReadonlyMap<string, ToolCategory> = new Map([
  // File / shell / coding (pi-coding-agent built-ins)
  ['read', 'file'],
  ['write', 'file'],
  ['edit', 'file'],
  ['multi-edit', 'file'],
  ['bash', 'shell'],
  ['shell', 'shell'],
  ['grep', 'code'],
  ['find', 'code'],
  ['ls', 'code'],
  ['load_skill', 'code'],
  ['load-skill', 'code'],
  // Research tools
  ['data-analyze', 'data-analysis'],
  ['data_analyze', 'data-analysis'],
  ['literature-search', 'literature'],
  ['literature_search', 'literature'],
  ['web-search', 'web'],
  ['web_search', 'web'],
  ['web-fetch', 'web'],
  ['web_fetch', 'web'],
  ['save-memory', 'memory'],
  ['recall-memory', 'memory'],
  ['artifact_create', 'artifact'],
  ['artifact_update', 'artifact'],
  ['artifact_search', 'artifact'],
  ['convert-document', 'document'],
  ['convert_document', 'document'],
  ['generate-diagram', 'diagram'],
  ['wiki-query', 'wiki'],
  ['enrich-paper', 'citation'],
  ['local-compute-execute', 'compute'],
])

const TOOL_CATEGORY_PREFIXES: ReadonlyArray<readonly [string, ToolCategory]> = [
  ['memory-', 'memory'],
  ['artifact-', 'artifact'],
  ['diagram', 'diagram'],
  ['wiki', 'wiki'],
  ['citation', 'citation'],
  ['local-compute', 'compute'],
  ['compute-', 'compute'],
]

export function categorizeTool(toolName: string): ToolCategory {
  const exact = TOOL_CATEGORIES.get(toolName)
  if (exact) return exact
  for (const [prefix, category] of TOOL_CATEGORY_PREFIXES) {
    if (toolName.startsWith(prefix)) return category
  }
  return 'code'
}
