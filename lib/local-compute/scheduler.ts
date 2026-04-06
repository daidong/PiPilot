/**
 * Scheduler — "One heavy at a time" admission control.
 *
 * Rules:
 * - Max 1 heavy run concurrent
 * - Max 3 total runs concurrent (heavy + light)
 * - Resource checks: memory (500MB min), disk (500MB min)
 *
 * Light tasks: timeout <= 2 min or viz/plot commands.
 * Heavy tasks: everything else.
 */

import type { RunWeight, PreRunSnapshot, SchedulerDecision } from './types.js'

const MAX_HEAVY_CONCURRENT = 1
const MAX_TOTAL_CONCURRENT = 3
const MIN_FREE_MEMORY_MB = 500
const MIN_FREE_DISK_MB = 500

/**
 * Classify a run as heavy or light based on timeout and command.
 */
export function classifyWeight(timeoutMinutes: number, command: string): RunWeight {
  if (timeoutMinutes <= 2) return 'light'
  // Only classify as light if timeout is moderate AND command looks like a viz task
  if (timeoutMinutes <= 10 && /\b(plot|viz|chart|figure|draw|render)\b/i.test(command)) return 'light'
  return 'heavy'
}

/**
 * Check if a new run can start given current system state.
 */
export function canAdmit(snapshot: PreRunSnapshot, weight: RunWeight): SchedulerDecision {
  const activeHeavy = snapshot.activeRuns.filter(r => r.weight === 'heavy').length
  const totalActive = snapshot.activeRuns.length

  // Rule 1: max 1 heavy run
  if (weight === 'heavy' && activeHeavy >= MAX_HEAVY_CONCURRENT) {
    const heavyRun = snapshot.activeRuns.find(r => r.weight === 'heavy')
    return {
      allowed: false,
      reason: `A heavy compute run is already active${heavyRun ? ` (${heavyRun.runId})` : ''}. Wait for it to finish, or stop it first.`,
    }
  }

  // Rule 2: max 3 concurrent total
  if (totalActive >= MAX_TOTAL_CONCURRENT) {
    return {
      allowed: false,
      reason: `Too many concurrent runs (${totalActive}/${MAX_TOTAL_CONCURRENT}). Wait for one to finish, or stop one.`,
    }
  }

  // Rule 3: memory check
  if (snapshot.freeMemoryMb < MIN_FREE_MEMORY_MB) {
    return {
      allowed: false,
      reason: `Low memory (${Math.round(snapshot.freeMemoryMb)}MB free, need ${MIN_FREE_MEMORY_MB}MB). Close applications to free resources.`,
    }
  }

  // Rule 4: disk check
  if (snapshot.freeDiskMb < MIN_FREE_DISK_MB) {
    return {
      allowed: false,
      reason: `Low disk space (${Math.round(snapshot.freeDiskMb)}MB free, need ${MIN_FREE_DISK_MB}MB).`,
    }
  }

  return { allowed: true, reason: 'Resources available' }
}
