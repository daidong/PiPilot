/**
 * web_fetch provenance adapter.
 *
 * web_fetch (lib/tools/web-tools.ts) either returns content inline (small
 * pages) or persists to {projectPath}/web-content/{hash}.{ext} (large pages).
 * We only track the persisted case — inline fetches are ephemeral; if the
 * agent wants them durable, it will save them via artifact-create, which has
 * its own adapter.
 *
 * Output: one workspace-file node at the persisted path.
 * Inputs: none (fetches are always fresh).
 */

import type { ProvenanceAdapter, ProvenanceFacts } from '../types.js'
import { parseResultJson } from './index.js'

export const webFetchAdapter: ProvenanceAdapter = (args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const persistedPath = typeof data.content_path === 'string' ? data.content_path : null
  if (!persistedPath) return null // inline-only fetch: don't track

  const url = typeof args.url === 'string' ? args.url : '(unknown url)'

  return {
    outputs: [{
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: persistedPath },
      label: `web-fetch ${url}`
      // snapshotPolicy defaults to 'always' for workspace-file outputs;
      // capture.ts will read the persisted file and snapshot it (subject to 10MB cap).
    }],
    inputs: []
  }
}
