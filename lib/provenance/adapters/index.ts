/**
 * Provenance adapter registry.
 *
 * Each adapter maps `(args, result, ctx)` for one tool name to ProvenanceFacts.
 * Tools whose name is absent from this registry are skipped silently — adding
 * a new tool to provenance is a matter of dropping a file into this directory
 * and registering it here, never modifying the coordinator hooks.
 *
 * See docs/spec/trust-audit.md §3.5 for the v1 inventory.
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ProvenanceAdapter } from '../types.js'
import { webFetchAdapter } from './web-fetch.js'
import { literatureSearchAdapter } from './literature-search.js'
import { convertDocumentAdapter } from './convert-document.js'
import { dataAnalyzeAdapter } from './data-analyze.js'
import { generateDiagramAdapter } from './generate-diagram.js'
import { artifactCreateAdapter, artifactUpdateAdapter } from './entity-tools.js'
import { writeAdapter } from './write.js'
import { editAdapter } from './edit.js'
import { bashAdapter } from './bash.js'
import { readAdapter } from './read.js'

// ---------------------------------------------------------------------------
// Result-parsing helpers (shared across adapters)
// ---------------------------------------------------------------------------

/**
 * Tools that pass an object to `toolSuccess({...})` end up with the JSON
 * stringified into `result.content[0].text`. Adapters reach back through the
 * envelope to get structured data. Capture has already filtered out errored
 * calls, so adapters do not need to re-check success.
 *
 * Returns null when the text isn't valid JSON (typically because the tool
 * returned a plain string — pi-coding-agent's bash/write/edit are like this).
 */
export function parseResultJson(result: unknown): Record<string, unknown> | null {
  const r = result as Partial<AgentToolResult<unknown>> | null
  const first = r?.content?.[0]
  const text = first && 'text' in first ? (first as { text?: unknown }).text : undefined
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Get the plain-text content of a tool result (used by bash/write/edit adapters). */
export function resultText(result: unknown): string | null {
  const r = result as Partial<AgentToolResult<unknown>> | null
  const first = r?.content?.[0]
  const text = first && 'text' in first ? (first as { text?: unknown }).text : undefined
  return typeof text === 'string' ? text : null
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Default adapter registry. Tool names match the registrations in
 * lib/tools/index.ts plus pi-coding-agent's built-in coding tools.
 */
export const defaultAdapters: Record<string, ProvenanceAdapter> = {
  // research tools (createResearchTools)
  web_fetch:           webFetchAdapter,
  'literature-search': literatureSearchAdapter,
  convert_document:    convertDocumentAdapter,
  data_analyze:        dataAnalyzeAdapter,
  generate_diagram:    generateDiagramAdapter,
  'artifact-create':   artifactCreateAdapter,
  'artifact-update':   artifactUpdateAdapter,

  // pi-coding-agent built-in tools
  write: writeAdapter,
  edit:  editAdapter,
  bash:  bashAdapter,
  // Read is captured via the `consumed` channel (wasInformedBy) — it produces
  // no node itself but its file refs are pooled per turn and folded into the
  // next producer's inputs. grep / find / ls are intentionally absent: they
  // surface paths and snippets, not document content (RFC §3.5).
  read:  readAdapter
}
