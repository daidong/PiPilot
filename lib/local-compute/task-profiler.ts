/**
 * Task Profiler — LLM-based multi-axis task profiling.
 *
 * Reads script content and produces a multi-dimensional TaskProfile.
 * Falls back to conservative defaults when LLM is unavailable.
 *
 * v1.2: LLM-enhanced. v1.0-1.1: uses defaults only.
 */

import type { ResearchToolContext } from '../tools/types.js'
import { parseJsonObjectFromText } from '../utils/llm-json.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskProfile {
  cpuDensity: 'low' | 'medium' | 'high'
  gpuDensity: 'none' | 'light' | 'heavy'
  memoryPattern: 'constant' | 'growing' | 'spike'
  ioPattern: 'read_heavy' | 'write_heavy' | 'balanced' | 'minimal'
  chunkable: boolean
  resumable: boolean
  idempotent: boolean
  hasExternalSideEffects: boolean
  networkRequired: boolean
  smokeSupported: boolean
  expectedDurationClass: 'seconds' | 'minutes' | 'hours'
  reasoning: string
}

// ---------------------------------------------------------------------------
// System prompt for task profiling
// ---------------------------------------------------------------------------

const PROFILER_SYSTEM_PROMPT = `You are a compute task profiler. Analyze the given script and command, then output a JSON object with these fields:

{
  "cpuDensity": "low" | "medium" | "high",
  "gpuDensity": "none" | "light" | "heavy",
  "memoryPattern": "constant" | "growing" | "spike",
  "ioPattern": "read_heavy" | "write_heavy" | "balanced" | "minimal",
  "chunkable": boolean,     // Can be split into smaller data pieces
  "resumable": boolean,     // Produces checkpoints, can restart
  "idempotent": boolean,    // Safe to re-run without side effects
  "hasExternalSideEffects": boolean,  // API calls, DB writes, emails
  "networkRequired": boolean,
  "smokeSupported": boolean,  // Has --smoke or similar quick-validation flag
  "expectedDurationClass": "seconds" | "minutes" | "hours",
  "reasoning": "Brief explanation of your analysis"
}

Guidelines:
- cpuDensity: "high" for training loops, simulations, heavy computation
- gpuDensity: "heavy" if torch/tensorflow/mlx with .fit() or training loops; "light" for inference; "none" for CPU-only
- memoryPattern: "spike" if large dataset loaded at once; "growing" if accumulating; "constant" if streaming/fixed
- ioPattern: "read_heavy" if large data loads; "write_heavy" if many output files; "balanced" if both
- chunkable: true if data can be split (pandas, numpy batch processing)
- resumable: true if checkpointing detected (torch.save, callbacks)
- smokeSupported: true ONLY if --smoke, --dry-run, or --validate flag is in argparse/click

Output ONLY the JSON object, no explanation outside it.`

// ---------------------------------------------------------------------------
// Profile function
// ---------------------------------------------------------------------------

/**
 * Profile a task using LLM analysis of the script content.
 * Falls back to conservative defaults if LLM is unavailable.
 */
export async function profileTask(
  command: string,
  scriptContent: string | undefined,
  callLlm?: ResearchToolContext['callLlm'],
): Promise<TaskProfile> {
  // Without LLM or script content, return conservative defaults
  if (!callLlm || !scriptContent) return defaultProfile(command)

  try {
    const response = await callLlm(
      PROFILER_SYSTEM_PROMPT,
      `Command: ${command}\n\nScript content:\n${scriptContent.slice(0, 8000)}`,
      { tier: 'light', purpose: 'task-profile' },
    )

    // Parse JSON from response — handle code blocks and preamble text
    const parsed = parseJsonFromLlm(response) as Partial<TaskProfile>
    if (!parsed) return defaultProfile(command)
    return mergeWithDefaults(parsed, command)
  } catch {
    // LLM failed — fall back to defaults
    return defaultProfile(command)
  }
}

// ---------------------------------------------------------------------------
// Defaults & merging
// ---------------------------------------------------------------------------

function defaultProfile(command: string): TaskProfile {
  const cmd = command.toLowerCase()
  const isTrain = /train|fit|epoch/i.test(cmd)
  const isViz = /plot|chart|viz|figure|graph/i.test(cmd)

  return {
    cpuDensity: isTrain ? 'high' : isViz ? 'low' : 'medium',
    gpuDensity: 'none',
    memoryPattern: 'constant',
    ioPattern: 'balanced',
    chunkable: false,
    resumable: false,
    idempotent: true,
    hasExternalSideEffects: false,
    networkRequired: false,
    smokeSupported: false,
    expectedDurationClass: isViz ? 'seconds' : isTrain ? 'hours' : 'minutes',
    reasoning: 'Default profile (LLM unavailable or no script content).',
  }
}

function mergeWithDefaults(partial: Partial<TaskProfile>, command: string): TaskProfile {
  const defaults = defaultProfile(command)
  return {
    cpuDensity: partial.cpuDensity ?? defaults.cpuDensity,
    gpuDensity: partial.gpuDensity ?? defaults.gpuDensity,
    memoryPattern: partial.memoryPattern ?? defaults.memoryPattern,
    ioPattern: partial.ioPattern ?? defaults.ioPattern,
    chunkable: partial.chunkable ?? defaults.chunkable,
    resumable: partial.resumable ?? defaults.resumable,
    idempotent: partial.idempotent ?? defaults.idempotent,
    hasExternalSideEffects: partial.hasExternalSideEffects ?? defaults.hasExternalSideEffects,
    networkRequired: partial.networkRequired ?? defaults.networkRequired,
    smokeSupported: partial.smokeSupported ?? defaults.smokeSupported,
    expectedDurationClass: partial.expectedDurationClass ?? defaults.expectedDurationClass,
    reasoning: partial.reasoning ?? defaults.reasoning,
  }
}

/**
 * Robustly extract a JSON object from LLM response text.
 * Handles code blocks, preamble text, and trailing commentary.
 */
export function parseJsonFromLlm(response: string): Record<string, unknown> | null {
  return parseJsonObjectFromText(response)
}
