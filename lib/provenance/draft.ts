/**
 * Draft save hook.
 *
 * Per axiom A2 + RFC §3.7: on every draft save we *record drift* on the
 * most-recent draft node for that path — we do NOT create new nodes or write
 * new blobs. Snapshotting drafts is the job of Phase 2's audit runner, which
 * captures the as-audited version permanently when an audit is requested.
 *
 * If no draft node exists for the path yet (typical until the first audit
 * has been run), this is a no-op. The first audit creates the initial node;
 * subsequent saves accumulate drift observations against it; the next audit
 * sees drift and creates a new node + snapshot.
 *
 * The hook is non-fatal: any failure (graph corruption, FS error) is
 * swallowed with a console warning. Drift recording is observability, never
 * load-bearing.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { appendEvent, sha256 } from './store.js'
import { ProvenanceGraph } from './graph.js'

/**
 * Should this path be treated as a draft? Currently: any markdown file under
 * the project root that is NOT inside `.research-pilot/` (those are managed
 * stores, not user-edited drafts).
 */
export function isDraftPath(projectPath: string, absPath: string): boolean {
  const rel = relative(projectPath, absPath)
  if (!rel || rel.startsWith('..')) return false              // outside project
  if (rel.startsWith('.research-pilot')) return false         // internal store
  if (rel.startsWith('node_modules')) return false            // dep tree
  const lower = absPath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

/**
 * Record drift on the most-recent draft node for the given path, if any.
 * Returns:
 *   - 'no-node'   if no draft node exists for this path (first save before any audit)
 *   - 'no-change' if the latest draft node already matches the new content hash
 *   - 'drift'     if drift was recorded
 *   - 'error'     if something went wrong (logged, swallowed)
 *
 * The path argument can be absolute or project-relative; resolution happens
 * inside.
 */
export async function recordDraftDrift(
  projectPath: string,
  path: string
): Promise<'no-node' | 'no-change' | 'drift' | 'error'> {
  try {
    const abs = isAbsolute(path) ? path : join(projectPath, path)
    if (!existsSync(abs)) return 'error'

    const buf = await readFile(abs)
    const newHash = sha256(buf)

    // The graph's draft node ref uses the path *as it was captured*. Drafts
    // are conventionally captured by relative path; we look up by relative
    // path first, then fall back to absolute as a safety net.
    const graph = await ProvenanceGraph.load(projectPath)
    const rel = relative(projectPath, abs)
    const latest = graph.latestDraft(rel) ?? graph.latestDraft(abs)
    if (!latest) return 'no-node'
    if (latest.snapshot?.contentHash === newHash) return 'no-change'

    await appendEvent(projectPath, {
      type: 'node-update',
      id: latest.id,
      patch: { drift: { observedHash: newHash, observedAt: new Date().toISOString() } }
    })
    return 'drift'
  } catch (err) {
    console.warn('[Provenance] recordDraftDrift failed:', err)
    return 'error'
  }
}
