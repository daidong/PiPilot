/**
 * Progress Extraction — extracts structured progress from raw output.
 *
 * Three layers:
 * 1. Raw: byte/line counting from file stats
 * 2. Structured: regex extraction (tqdm, epoch, metrics)
 * 3. Cooperative: ##PROGRESS## JSON protocol
 *
 * The cooperative protocol takes precedence when detected.
 */

import type { StructuredProgress } from './types.js'

/**
 * Extract structured progress from an output tail string.
 * Checks for cooperative protocol first, then falls back to regex patterns.
 */
export function extractProgress(tail: string): StructuredProgress | undefined {
  // Layer 3: Cooperative ##PROGRESS## protocol (authoritative if present)
  const cooperative = extractCooperativeProgress(tail)
  if (cooperative) return cooperative

  // Layer 2: Regex pattern extraction
  return extractRegexProgress(tail)
}

// ---------------------------------------------------------------------------
// Cooperative Protocol: ##PROGRESS## {"step": 3, "total": 10, ...}
// ---------------------------------------------------------------------------

function extractCooperativeProgress(tail: string): StructuredProgress | undefined {
  // Find the last ##PROGRESS## line (most recent)
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('##PROGRESS##')) continue
    const jsonStr = line.slice('##PROGRESS##'.length).trim()
    try {
      const data = JSON.parse(jsonStr) as Record<string, unknown>
      const progress: StructuredProgress = {}
      if (typeof data.step === 'number') progress.currentStep = data.step
      if (typeof data.total === 'number') progress.totalSteps = data.total
      if (typeof data.percentage === 'number') progress.percentage = data.percentage
      if (typeof data.phase === 'string') progress.phase = data.phase
      if (typeof data.eta === 'number') progress.etaSeconds = data.eta
      if (typeof data.eta_seconds === 'number') progress.etaSeconds = data.eta_seconds
      // Extract metrics (any numeric key not in known fields)
      const knownKeys = new Set(['step', 'total', 'percentage', 'phase', 'eta', 'eta_seconds'])
      const metrics: Record<string, number> = {}
      for (const [k, v] of Object.entries(data)) {
        if (!knownKeys.has(k) && typeof v === 'number') metrics[k] = v
      }
      if (Object.keys(metrics).length > 0) progress.metrics = metrics
      // Compute percentage from step/total if not provided
      if (progress.percentage === undefined && progress.currentStep !== undefined && progress.totalSteps) {
        progress.percentage = Math.round((progress.currentStep / progress.totalSteps) * 100)
      }
      return progress
    } catch {
      // Malformed JSON, skip
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Regex Pattern Extraction
// ---------------------------------------------------------------------------

function extractRegexProgress(tail: string): StructuredProgress | undefined {
  const progress: StructuredProgress = {}
  let found = false

  // Normalize \r lines — tqdm overwrites lines via carriage return.
  // Split on both \r and \n, take the last non-empty segments.
  const normalizedTail = tail.replace(/\r/g, '\n')

  // tqdm pattern: 45%|████████ | 450/1000 [02:15<02:45, ...]
  // ETA handles both mm:ss and hh:mm:ss formats, and <?
  const tqdmMatches = [...normalizedTail.matchAll(/(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[[\d:]+<([\d:?]+)/g)]
  const tqdm = tqdmMatches.length > 0 ? tqdmMatches[tqdmMatches.length - 1] : null
  if (tqdm) {
    progress.percentage = parseInt(tqdm[1], 10)
    progress.currentStep = parseInt(tqdm[2], 10)
    progress.totalSteps = parseInt(tqdm[3], 10)
    progress.etaSeconds = parseTimeStr(tqdm[4])
    found = true
  }

  // Epoch pattern: Epoch 3/10 or epoch 3 of 10
  if (!found) {
    const epoch = normalizedTail.match(/[Ee]pochs?\s+(\d+)\s*[/of]+\s*(\d+)/)
    if (epoch) {
      progress.currentStep = parseInt(epoch[1], 10)
      progress.totalSteps = parseInt(epoch[2], 10)
      progress.percentage = Math.round((progress.currentStep / progress.totalSteps) * 100)
      progress.phase = 'training'
      found = true
    }
  }

  // Step pattern: Step 150/1000 or step 150 of 1000
  if (!found) {
    const step = normalizedTail.match(/[Ss]teps?\s+(\d+)\s*[/of]+\s*(\d+)/)
    if (step) {
      progress.currentStep = parseInt(step[1], 10)
      progress.totalSteps = parseInt(step[2], 10)
      progress.percentage = Math.round((progress.currentStep / progress.totalSteps) * 100)
      found = true
    }
  }

  // Percentage pattern: 45% or Processing: 45% — take the LAST occurrence
  if (!found) {
    const pctMatches = [...normalizedTail.matchAll(/(\d{1,3})%/g)]
    const pct = pctMatches.length > 0 ? pctMatches[pctMatches.length - 1] : null
    if (pct) {
      const val = parseInt(pct[1], 10)
      if (val >= 0 && val <= 100) {
        progress.percentage = val
        found = true
      }
    }
  }

  // Metric extraction (last occurrence of each): loss=0.85, acc=0.92
  const metrics: Record<string, number> = {}
  const metricPattern = /\b(loss|acc(?:uracy)?|f1|auc|mse|mae|rmse|r2|lr|learning_rate|val_loss|val_acc(?:uracy)?)\s*[=:]\s*([\d.]+(?:e[+-]?\d+)?)/gi
  for (const m of normalizedTail.matchAll(metricPattern)) {
    const key = m[1].toLowerCase()
    const val = parseFloat(m[2])
    if (!isNaN(val)) metrics[key] = val
  }
  if (Object.keys(metrics).length > 0) {
    progress.metrics = metrics
    found = true
  }

  // Phase detection from keywords
  const lastLines = normalizedTail.slice(-2048).toLowerCase()
  if (/download|fetching|pulling/i.test(lastLines)) progress.phase = 'downloading'
  else if (/train|fitting|epoch/i.test(lastLines)) progress.phase = 'training'
  else if (/evaluat|validat|testing/i.test(lastLines)) progress.phase = 'evaluating'
  else if (/preprocess|clean|transform/i.test(lastLines)) progress.phase = 'preprocessing'
  else if (/saving|export|writing.*output/i.test(lastLines)) progress.phase = 'saving'

  return found ? progress : undefined
}

/**
 * Parse a time string like "02:15" (mm:ss) or "1:23:45" (h:mm:ss) or "?" into seconds.
 */
function parseTimeStr(s: string): number | undefined {
  if (!s || s.includes('?')) return undefined
  const parts = s.split(':').map(p => parseInt(p, 10))
  if (parts.some(isNaN)) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return undefined
}
