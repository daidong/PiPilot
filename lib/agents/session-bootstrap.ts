/**
 * Session bootstrap — orphan-message recovery on coordinator startup.
 *
 * On the first chat() after coordinator creation, recover any
 * user/assistant messages persisted to the session JSONL that postdate
 * the latest SessionSummary's createdAt. These are turns that happened
 * in a previous process and were never folded into a summary; we inject
 * them as a "Recent Conversation" block so the LLM resumes with the
 * same context the user sees in the UI — no extra LLM call, no
 * compression, lossless.
 *
 * Once-only: subsequent consume() calls return empty regardless of
 * input. After the first call, `agent.state.messages` accumulates
 * naturally, so re-injecting orphans would double-count.
 */

import type { SessionSummary } from '../types.js'
import { readOrphanMessages } from '../memory-v2/store.js'
import { buildRecentConversationContext } from './context-builder.js'

export interface BootstrapResult {
  /**
   * Ready-to-inject markdown block (empty when no orphans recovered or
   * when consume() has already fired once).
   */
  context: string
  /** Number of orphan messages that were folded in. */
  orphanCount: number
}

export interface SessionBootstrap {
  /**
   * Consume the bootstrap budget. Idempotent after the first call:
   * second and later calls always return `{ context: '', orphanCount: 0 }`.
   *
   * Pass the latest persisted SessionSummary (or null) so we can compute
   * the cutoff timestamp — orphans are messages with `timestamp > cutoff`.
   */
  consume(latestSummary: SessionSummary | null): BootstrapResult
}

export function createSessionBootstrap(opts: {
  projectPath: string
  sessionId: string
  debug?: boolean
}): SessionBootstrap {
  let done = false
  return {
    consume(latestSummary) {
      if (done) return { context: '', orphanCount: 0 }
      done = true
      try {
        const cutoffMs = latestSummary ? Date.parse(latestSummary.createdAt) || 0 : 0
        const orphans = readOrphanMessages(opts.projectPath, opts.sessionId, cutoffMs)
        if (orphans.length === 0) return { context: '', orphanCount: 0 }
        const context = buildRecentConversationContext(orphans)
        if (opts.debug) {
          console.log(`[Bootstrap] Recovered ${orphans.length} orphan message(s) from prior session`)
        }
        return { context, orphanCount: orphans.length }
      } catch (err) {
        if (opts.debug) console.warn('[Bootstrap] Failed to read orphan messages:', err)
        return { context: '', orphanCount: 0 }
      }
    }
  }
}
