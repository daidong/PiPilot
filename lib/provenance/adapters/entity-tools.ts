/**
 * artifact-create / artifact-update provenance adapters.
 *
 * Both tools return `{ id, type, title, filePath }` in their success payload.
 * That is exactly what we need to construct a memory-artifact NodeRef.
 *
 * artifact-create → one new memory-artifact node.
 * artifact-update → one new memory-artifact node + `derived-from` edge to the
 * prior version. Old node remains in the graph (history preserved).
 *
 * Inputs / cited: the v1 spec mentions resolving @-mentions from args. The
 * artifact-create/update tool args don't currently surface a structured mention
 * list — they accept free-text content/title/etc. Resolving mentions from
 * arbitrary strings here would duplicate logic that lives in the chat layer.
 * Defer to a follow-up: when the renderer resolves mentions before invoking
 * the tool, attach a `_resolvedMentions: ArtifactRef[]` field to args.
 */

import type { ArtifactType } from '../../types.js'
import type { ProvenanceAdapter, ProvenanceFacts, NodeRef } from '../types.js'
import { parseResultJson } from './index.js'

export const artifactCreateAdapter: ProvenanceAdapter = (_args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const id = typeof data.id === 'string' ? data.id : null
  const type = typeof data.type === 'string' ? (data.type as ArtifactType) : null
  const title = typeof data.title === 'string' ? data.title : '(untitled)'
  if (!id || !type) return null

  return {
    outputs: [{
      kind: 'memory-artifact',
      ref: { kind: 'memory-artifact', artifactType: type, artifactId: id },
      label: `${type}: ${title}`
      // Default snapshotPolicy 'always' for memory-artifact; capture.ts will
      // need readContent to read the JSON from disk. We defer that to a
      // memory-v2 helper in a later slice (Phase 2 needs it for auditor too).
    }],
    inputs: []
  }
}

export const artifactUpdateAdapter: ProvenanceAdapter = (_args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const id = typeof data.id === 'string' ? data.id : null
  const type = typeof data.type === 'string' ? (data.type as ArtifactType) : null
  const title = typeof data.title === 'string' ? data.title : '(untitled)'
  if (!id || !type) return null

  // The output is a *new version* of the same memory-artifact ref. Find-or-
  // create in capture.ts uses (refKey + contentHash) for identity, so a new
  // contentHash produces a fresh node; emitNodeWithVersionLink automatically
  // adds a `derived-from` edge from the prior version to the new one.
  const ref: NodeRef = { kind: 'memory-artifact', artifactType: type, artifactId: id }

  return {
    outputs: [{
      kind: 'memory-artifact',
      ref,
      label: `${type}: ${title} (updated)`
    }],
    inputs: []
  }
}
