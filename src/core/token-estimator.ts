/**
 * TokenEstimator - Block-level token estimation with calibration
 *
 * Provides per-block token estimation with:
 * - Different estimation strategies per block type
 * - Runtime calibration (compare estimated vs actual)
 * - Confidence levels for estimates
 */

import { countTokens, type ModelFamily } from '../utils/tokenizer.js'

/**
 * Block types for estimation
 */
export type BlockType = 'system' | 'tools' | 'messages' | 'output'

/**
 * Confidence level for estimates
 */
export type EstimateConfidence = 'high' | 'medium' | 'low'

/**
 * Block estimate result
 */
export interface BlockEstimate {
  /** Block type */
  block: BlockType
  /** Raw estimated tokens */
  estimated: number
  /** Calibrated tokens (after scaling) */
  calibrated: number
  /** Confidence level */
  confidence: EstimateConfidence
  /** Source of estimation */
  source: 'heuristic' | 'calibrated' | 'measured'
}

/**
 * Calibration data for a block type
 */
interface CalibrationData {
  /** Number of samples collected */
  sampleCount: number
  /** Total estimated tokens across samples */
  totalEstimated: number
  /** Total actual tokens across samples */
  totalActual: number
  /** Computed scaling factor */
  scalingFactor: number
  /** Last calibration timestamp */
  lastCalibrated: number
}

/**
 * Estimator configuration
 */
export interface TokenEstimatorConfig {
  /** Model family for base estimation */
  modelFamily?: ModelFamily
  /** Minimum samples before using calibration */
  minSamplesForCalibration?: number
  /** Maximum age for calibration data (ms) */
  calibrationMaxAge?: number
}

/**
 * Default configuration
 */
const DEFAULTS = {
  minSamplesForCalibration: 5,
  calibrationMaxAge: 24 * 60 * 60 * 1000  // 24 hours
}

/**
 * Default scaling factors per block type (based on observation)
 */
const DEFAULT_SCALING: Record<BlockType, number> = {
  system: 1.0,     // Text-based, fairly accurate
  tools: 1.15,    // JSON schemas tend to be underestimated
  messages: 1.05, // Mixed content
  output: 1.0     // Reserved space, no scaling
}

/**
 * TokenEstimator - Provides calibrated token estimates
 */
export class TokenEstimator {
  private config: Required<TokenEstimatorConfig>
  private calibration: Map<BlockType, CalibrationData> = new Map()

  constructor(config: TokenEstimatorConfig = {}) {
    this.config = {
      modelFamily: config.modelFamily ?? 'openai',
      minSamplesForCalibration: config.minSamplesForCalibration ?? DEFAULTS.minSamplesForCalibration,
      calibrationMaxAge: config.calibrationMaxAge ?? DEFAULTS.calibrationMaxAge
    }

    // Initialize calibration data for each block type
    for (const blockType of ['system', 'tools', 'messages', 'output'] as BlockType[]) {
      this.calibration.set(blockType, {
        sampleCount: 0,
        totalEstimated: 0,
        totalActual: 0,
        scalingFactor: DEFAULT_SCALING[blockType],
        lastCalibrated: 0
      })
    }
  }

  /**
   * Estimate tokens for system prompt
   */
  estimateSystem(prompt: string): BlockEstimate {
    const estimated = countTokens(prompt)
    return this.createEstimate('system', estimated)
  }

  /**
   * Estimate tokens for tool schemas
   */
  estimateTools(schemas: unknown[]): BlockEstimate {
    // JSON schemas are typically underestimated by simple char counting
    let estimated = 0

    for (const schema of schemas) {
      const schemaStr = JSON.stringify(schema)
      estimated += countTokens(schemaStr)
    }

    return this.createEstimate('tools', estimated)
  }

  /**
   * Estimate tokens for a single tool schema
   */
  estimateToolSchema(schema: unknown): number {
    const schemaStr = JSON.stringify(schema)
    const estimated = countTokens(schemaStr)
    const calibration = this.getCalibration('tools')
    return Math.ceil(estimated * calibration.scalingFactor)
  }

  /**
   * Estimate tokens for messages
   */
  estimateMessages(messages: Array<{ content: string; role?: string }>): BlockEstimate {
    let estimated = 0

    for (const msg of messages) {
      // Add role overhead (approximately 3-5 tokens per message for role markers)
      estimated += 4

      // Add content tokens
      estimated += countTokens(msg.content)
    }

    return this.createEstimate('messages', estimated)
  }

  /**
   * Estimate tokens for arbitrary text
   */
  estimateText(text: string, blockType: BlockType = 'system'): BlockEstimate {
    const estimated = countTokens(text)
    return this.createEstimate(blockType, estimated)
  }

  /**
   * Create a block estimate with calibration applied
   */
  private createEstimate(block: BlockType, estimated: number): BlockEstimate {
    const calibration = this.getCalibration(block)
    const calibrated = Math.ceil(estimated * calibration.scalingFactor)

    // Determine confidence based on calibration quality
    let confidence: EstimateConfidence
    let source: BlockEstimate['source']

    if (calibration.sampleCount >= this.config.minSamplesForCalibration) {
      // We have enough samples for calibration
      const age = Date.now() - calibration.lastCalibrated
      if (age < this.config.calibrationMaxAge) {
        confidence = 'high'
        source = 'calibrated'
      } else {
        confidence = 'medium'
        source = 'calibrated'
      }
    } else {
      confidence = 'low'
      source = 'heuristic'
    }

    return {
      block,
      estimated,
      calibrated,
      confidence,
      source
    }
  }

  /**
   * Get calibration data for a block type
   */
  private getCalibration(block: BlockType): CalibrationData {
    return this.calibration.get(block) ?? {
      sampleCount: 0,
      totalEstimated: 0,
      totalActual: 0,
      scalingFactor: DEFAULT_SCALING[block],
      lastCalibrated: 0
    }
  }

  /**
   * Calibrate based on actual token usage
   *
   * Call this when you know the actual token count (e.g., from LLM API response)
   */
  calibrate(block: BlockType, estimated: number, actual: number): void {
    const data = this.calibration.get(block)!

    data.sampleCount++
    data.totalEstimated += estimated
    data.totalActual += actual

    // Compute new scaling factor (avoid division by zero)
    if (data.totalEstimated > 0) {
      data.scalingFactor = data.totalActual / data.totalEstimated
      // Clamp to reasonable range
      data.scalingFactor = Math.max(0.5, Math.min(2.0, data.scalingFactor))
    }

    data.lastCalibrated = Date.now()
  }

  /**
   * Get current scaling factor for a block type
   */
  getScalingFactor(block: BlockType): number {
    return this.getCalibration(block).scalingFactor
  }

  /**
   * Set scaling factor manually
   */
  setScalingFactor(block: BlockType, factor: number): void {
    const data = this.calibration.get(block)!
    data.scalingFactor = Math.max(0.5, Math.min(2.0, factor))
    data.lastCalibrated = Date.now()
  }

  /**
   * Get calibration statistics
   */
  getCalibrationStats(): Record<BlockType, {
    sampleCount: number
    scalingFactor: number
    lastCalibrated: number
  }> {
    const stats: Record<string, {
      sampleCount: number
      scalingFactor: number
      lastCalibrated: number
    }> = {}

    for (const [block, data] of this.calibration.entries()) {
      stats[block] = {
        sampleCount: data.sampleCount,
        scalingFactor: data.scalingFactor,
        lastCalibrated: data.lastCalibrated
      }
    }

    return stats as Record<BlockType, {
      sampleCount: number
      scalingFactor: number
      lastCalibrated: number
    }>
  }

  /**
   * Reset calibration data
   */
  resetCalibration(block?: BlockType): void {
    if (block) {
      this.calibration.set(block, {
        sampleCount: 0,
        totalEstimated: 0,
        totalActual: 0,
        scalingFactor: DEFAULT_SCALING[block],
        lastCalibrated: 0
      })
    } else {
      for (const blockType of ['system', 'tools', 'messages', 'output'] as BlockType[]) {
        this.calibration.set(blockType, {
          sampleCount: 0,
          totalEstimated: 0,
          totalActual: 0,
          scalingFactor: DEFAULT_SCALING[blockType],
          lastCalibrated: 0
        })
      }
    }
  }

  /**
   * Export calibration data (for persistence)
   */
  exportCalibration(): Record<BlockType, CalibrationData> {
    const data: Record<string, CalibrationData> = {}
    for (const [block, calibration] of this.calibration.entries()) {
      data[block] = { ...calibration }
    }
    return data as Record<BlockType, CalibrationData>
  }

  /**
   * Import calibration data (from persistence)
   */
  importCalibration(data: Record<BlockType, Partial<CalibrationData>>): void {
    for (const [block, calibration] of Object.entries(data)) {
      const existing = this.calibration.get(block as BlockType)!
      this.calibration.set(block as BlockType, {
        ...existing,
        ...calibration
      })
    }
  }
}

/**
 * Create a token estimator with model-specific defaults
 */
export function createTokenEstimator(modelId?: string): TokenEstimator {
  let modelFamily: ModelFamily = 'openai'

  if (modelId) {
    if (modelId.startsWith('claude') || modelId.includes('anthropic')) {
      modelFamily = 'anthropic'
    } else if (modelId.startsWith('gemini') || modelId.includes('google')) {
      modelFamily = 'google'
    }
  }

  return new TokenEstimator({ modelFamily })
}
