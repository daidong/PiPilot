/**
 * Tokenizer - Token 计算工具
 */

// 简化的 token 计算实现
// 在生产环境中应使用 tiktoken 等库进行精确计算

/**
 * Token 计算器接口
 */
export interface Tokenizer {
  /** 计算 token 数量 */
  count(text: string): number
  /** 编码文本为 token 数组 */
  encode(text: string): number[]
  /** 解码 token 数组为文本 */
  decode(tokens: number[]): string
  /** 截断文本到指定 token 数 */
  truncate(text: string, maxTokens: number, strategy: 'head' | 'tail' | 'middle'): string
}

/**
 * 简化的 token 计算器
 * 使用简单的字符/单词估算方法
 */
export class SimpleTokenizer implements Tokenizer {
  // 平均每个 token 约等于 4 个字符（英文）
  // 中文每个字符约等于 1-2 个 token
  private readonly charsPerToken = 4
  private readonly chineseTokenRatio = 1.5

  count(text: string): number {
    if (!text) return 0

    // 统计中文字符
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
    const nonChineseChars = text.length - chineseChars

    const chineseTokens = Math.ceil(chineseChars * this.chineseTokenRatio)
    const nonChineseTokens = Math.ceil(nonChineseChars / this.charsPerToken)

    return chineseTokens + nonChineseTokens
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
 * 截断文本
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  strategy: 'head' | 'tail' | 'middle' = 'tail'
): string {
  return defaultTokenizer.truncate(text, maxTokens, strategy)
}
