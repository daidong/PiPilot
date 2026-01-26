/**
 * Tokenizer - Token estimation utilities
 *
 * Provides token counting with calibration support per model family.
 * Uses heuristic-based estimation with optional scaling factors.
 */

/**
 * Model family for calibration
 */
export type ModelFamily = 'openai' | 'anthropic' | 'google' | 'custom'

/**
 * Calibration config for a model family
 */
export interface CalibrationConfig {
  /** Global scaling factor applied to all estimates (default: 1.0) */
  scalingFactor: number
  /** Characters per token for non-CJK text (default: 4) */
  charsPerToken: number
  /** Token multiplier for CJK characters (default: 1.5) */
  cjkTokenRatio: number
}

/**
 * Default calibration configs per model family
 */
const DEFAULT_CALIBRATIONS: Record<ModelFamily, CalibrationConfig> = {
  openai: {
    scalingFactor: 1.0,
    charsPerToken: 4,
    cjkTokenRatio: 1.5
  },
  anthropic: {
    scalingFactor: 1.05, // Slightly higher estimate for safety
    charsPerToken: 4,
    cjkTokenRatio: 1.5
  },
  google: {
    scalingFactor: 1.0,
    charsPerToken: 4,
    cjkTokenRatio: 1.5
  },
  custom: {
    scalingFactor: 1.0,
    charsPerToken: 4,
    cjkTokenRatio: 1.5
  }
}

/**
 * Token calculator interface
 */
export interface Tokenizer {
  /** Count tokens in text */
  count(text: string): number
  /** Encode text to token array */
  encode(text: string): number[]
  /** Decode token array to text */
  decode(tokens: number[]): string
  /** Truncate text to specified token count */
  truncate(text: string, maxTokens: number, strategy: 'head' | 'tail' | 'middle'): string
  /** Set calibration for a model family */
  setCalibration(family: ModelFamily, config: Partial<CalibrationConfig>): void
  /** Get current calibration */
  getCalibration(): CalibrationConfig
  /** Set active model family */
  setModelFamily(family: ModelFamily): void
}

/**
 * Simple heuristic-based token calculator with calibration support
 */
export class SimpleTokenizer implements Tokenizer {
  private calibrations: Map<ModelFamily, CalibrationConfig>
  private activeFamily: ModelFamily = 'openai'

  constructor() {
    // Initialize with default calibrations
    this.calibrations = new Map()
    for (const [family, config] of Object.entries(DEFAULT_CALIBRATIONS)) {
      this.calibrations.set(family as ModelFamily, { ...config })
    }
  }

  /**
   * Set calibration for a model family
   */
  setCalibration(family: ModelFamily, config: Partial<CalibrationConfig>): void {
    const existing = this.calibrations.get(family) ?? { ...DEFAULT_CALIBRATIONS.custom }
    this.calibrations.set(family, { ...existing, ...config })
  }

  /**
   * Get current calibration
   */
  getCalibration(): CalibrationConfig {
    return { ...(this.calibrations.get(this.activeFamily) ?? DEFAULT_CALIBRATIONS.openai) }
  }

  /**
   * Set active model family
   */
  setModelFamily(family: ModelFamily): void {
    this.activeFamily = family
  }

  count(text: string): number {
    if (!text) return 0

    const config = this.getCalibration()

    // Count CJK characters (Chinese, Japanese, Korean)
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
    const nonCjkChars = text.length - cjkChars

    const cjkTokens = Math.ceil(cjkChars * config.cjkTokenRatio)
    const nonCjkTokens = Math.ceil(nonCjkChars / config.charsPerToken)

    // Apply scaling factor
    return Math.ceil((cjkTokens + nonCjkTokens) * config.scalingFactor)
  }

  encode(text: string): number[] {
    // 简化实现：每个字符映射到其 charCode
    const tokens: number[] = []
    for (let i = 0; i < text.length; i++) {
      tokens.push(text.charCodeAt(i))
    }
    return tokens
  }

  decode(tokens: number[]): string {
    return String.fromCharCode(...tokens)
  }

  truncate(text: string, maxTokens: number, strategy: 'head' | 'tail' | 'middle'): string {
    const currentTokens = this.count(text)
    if (currentTokens <= maxTokens) {
      return text
    }

    // 估算需要保留的字符数
    const ratio = maxTokens / currentTokens
    const targetLength = Math.floor(text.length * ratio)

    switch (strategy) {
      case 'head':
        return text.slice(0, targetLength) + '\n... [truncated]'
      case 'tail':
        return '[truncated] ...\n' + text.slice(-targetLength)
      case 'middle': {
        const halfLength = Math.floor(targetLength / 2)
        return text.slice(0, halfLength) + '\n... [truncated] ...\n' + text.slice(-halfLength)
      }
      default:
        return text.slice(0, targetLength)
    }
  }
}

// 默认 tokenizer 实例
let defaultTokenizer: Tokenizer = new SimpleTokenizer()

/**
 * 获取默认 tokenizer
 */
export function getTokenizer(): Tokenizer {
  return defaultTokenizer
}

/**
 * 设置默认 tokenizer
 */
export function setTokenizer(tokenizer: Tokenizer): void {
  defaultTokenizer = tokenizer
}

/**
 * 计算 token 数量
 */
export function countTokens(text: string): number {
  return defaultTokenizer.count(text)
}

/**
 * Truncate text to token limit
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  strategy: 'head' | 'tail' | 'middle' = 'tail'
): string {
  return defaultTokenizer.truncate(text, maxTokens, strategy)
}

/**
 * Set calibration for a model family
 */
export function setCalibration(family: ModelFamily, config: Partial<CalibrationConfig>): void {
  defaultTokenizer.setCalibration(family, config)
}

/**
 * Set active model family for token estimation
 */
export function setModelFamily(family: ModelFamily): void {
  defaultTokenizer.setModelFamily(family)
}

/**
 * Get current calibration config
 */
export function getCalibration(): CalibrationConfig {
  return defaultTokenizer.getCalibration()
}

/**
 * Configure tokenizer based on model ID
 */
export function configureForModel(modelId: string): void {
  let family: ModelFamily = 'openai'

  if (modelId.startsWith('claude') || modelId.includes('anthropic')) {
    family = 'anthropic'
  } else if (modelId.startsWith('gemini') || modelId.includes('google')) {
    family = 'google'
  } else if (modelId.startsWith('gpt') || modelId.includes('openai') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) {
    family = 'openai'
  }

  setModelFamily(family)
}
