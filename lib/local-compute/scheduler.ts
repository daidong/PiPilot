/**
 * Scheduler — admission for local runs (RFC-016 §4.1 / Phase 2).
 *
 * The pre-RFC-016 model was "one heavy at a time": a timeout-based
 * heavy/light classifier + MAX_HEAVY_CONCURRENT=1 + a blanket
 * MIN_FREE_MEMORY_MB gate measured via `os.freemem()`. That guard was
 * mis-tuned (default 60-min timeout ⇒ everything "heavy" ⇒ effectively
 * sequential) and the memory floor badly undercounted available memory on
 * macOS, so trivial I/O-bound probes were needlessly blocked.
 *
 * RFC-016 replaces it with OS-arbitrated concurrency: run concurrently and
 * let the OS handle contention; recover resource safety post-hoc via the
 * OOM failure-signal + stall detection (not pre-admission blocking). The
 * only admission checks that remain are:
 *   - a SOFT, configurable concurrency cap (runaway-loop backstop, not a
 *     heavy/light gate), and
 *   - a disk-space floor (a run that can't write output fails instantly —
 *     blocking it up front gives a clearer error than a cryptic ENOSPC).
 */

import type { RunWeight, PreRunSnapshot, SchedulerDecision } from './types.js'

const MIN_FREE_DISK_MB = 500

/**
 * Classify a run as heavy or light. NOTE: this no longer affects
 * admission (RFC-016 dropped the heavy/light gate). It is retained only to
 * populate RunRecord.weight for display — the Compute tab still surfaces a
 * weight chip. Safe to delete once that chip is gone.
 */
export function classifyWeight(timeoutMinutes: number, command: string): RunWeight {
  if (timeoutMinutes <= 2) return 'light'
  if (timeoutMinutes <= 10 && /\b(plot|viz|chart|figure|draw|render)\b/i.test(command)) return 'light'
  return 'heavy'
}

/**
 * Admit a new local run. OS-arbitrated concurrency means there is no
 * heavy/light reasoning and no memory gate — only the soft total cap and
 * the disk floor.
 */
export function canAdmit(snapshot: PreRunSnapshot, maxConcurrent: number): SchedulerDecision {
  const totalActive = snapshot.activeRuns.length

  if (totalActive >= maxConcurrent) {
    return {
      allowed: false,
      reason:
        `Local concurrency cap reached (${totalActive}/${maxConcurrent} runs active). ` +
        `Wait for one to finish, stop one, or raise the cap in Settings → Compute.`,
    }
  }

  if (snapshot.freeDiskMb < MIN_FREE_DISK_MB) {
    return {
      allowed: false,
      reason: `Low disk space (${Math.round(snapshot.freeDiskMb)}MB free, need ${MIN_FREE_DISK_MB}MB).`,
    }
  }

  return { allowed: true, reason: 'Resources available' }
}
