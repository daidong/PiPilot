/**
 * StateSummarizer - Two-layer state summary for agent context
 *
 * Layer 1 — Event Log: One-liner per tool call (no LLM required)
 * Layer 2 — Fact Extraction: Heuristic extraction with provenance
 *
 * All entries include provenance (file:lineRange or URL).
 * When maxEntries exceeded, oldest event log entries are dropped (FIFO).
 * Fact entries use a two-tier retention: "sticky" facts with provenance
 * are retained longer than ephemeral event log entries, preventing long
 * loops from rotating out the one critical finding.
 *
 * Reference message awareness: The render output and the REFERENCE_MATERIAL
 * prefix are recognized by history compaction. When summarizing user intent,
 * messages with these tags should be excluded or separately bucketed.
 */

import { countTokens } from '../utils/tokenizer.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Prefix used on injected reference messages so that history compaction
 * can distinguish them from actual user intent.
 */
export const REFERENCE_MESSAGE_PREFIX = '[REFERENCE MATERIAL]'

/**
 * Tag used on accumulated findings messages.
 */
export const ACCUMULATED_FINDINGS_TAG = '<accumulated-findings>'

/**
 * Check whether a message is a reference/findings injection (not user intent).
 * Use this in history compaction to exclude these from intent summarization.
 */
export function isReferenceMessage(content: string): boolean {
  return content.startsWith(REFERENCE_MESSAGE_PREFIX)
    || content.startsWith(ACCUMULATED_FINDINGS_TAG)
}

// ============================================================================
// Types
// ============================================================================

export interface EventLogEntry {
  /** Tool name */
  tool: string
  /** One-line summary */
  summary: string
  /** Timestamp (step number) */
  step: number
}

export interface FactEntry {
  /** Source provenance (e.g., "proposal.md:1-640" or "https://example.com") */
  source: string
  /** Extracted fact */
  fact: string
  /** Step when extracted */
  step: number
  /**
   * Whether this fact is "sticky" — retained longer than event log entries.
   * Facts with provenance (file path or URL) are sticky by default.
   */
  sticky: boolean
}

export interface StateSummarizerConfig {
  /** Maximum event log entries before FIFO eviction (default: 50) */
  maxEventEntries?: number
  /** Maximum fact entries (default: 30) */
  maxFactEntries?: number
  /** Maximum sticky fact entries that survive aggressive eviction (default: 15) */
  maxStickyFacts?: number
  /** Maximum tokens for the rendered summary (default: 2000) */
  maxTokens?: number
}

// ============================================================================
// Per-tool fact extractors
// ============================================================================

function extractReadFacts(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const filePath = (args.file_path ?? args.path ?? 'unknown') as string
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const lineCount = resultStr.split('\n').length

  // Extract first heading if present
  const headingMatch = resultStr.match(/^#{1,3}\s+(.+)$/m)
  const heading = headingMatch?.[1] ?? ''

  const event = `[${toolName}] ${filePath}: ${lineCount} lines${heading ? ` (${heading})` : ''}`
  const fact: FactEntry | undefined = success ? {
    source: filePath,
    fact: `File ${filePath}: ${lineCount} lines${heading ? `, starts with "${heading}"` : ''}`,
    step: 0,
    sticky: true // file reads have provenance
  } : undefined

  return { event, fact }
}

function extractGrepFacts(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const pattern = (args.pattern ?? '') as string
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const lines = resultStr.split('\n').filter(l => l.trim())
  const matchCount = lines.length

  // Extract first 3 matched lines
  const snippets = lines.slice(0, 3).map(l => l.trim()).join('; ')

  const event = `[${toolName}] "${pattern}" → ${matchCount} matches`
  const fact: FactEntry | undefined = success && matchCount > 0 ? {
    source: `grep:${pattern}`,
    fact: `Grep "${pattern}": ${matchCount} matches. First: ${snippets}`,
    step: 0,
    sticky: true // search results have provenance
  } : undefined

  return { event, fact }
}

function extractGlobFacts(toolName: string, args: Record<string, unknown>, result: unknown): { event: string; fact?: FactEntry } {
  const pattern = (args.pattern ?? '') as string
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const files = resultStr.split('\n').filter(l => l.trim())
  const fileCount = files.length

  const event = `[${toolName}] ${pattern} → ${fileCount} files`
  const fact: FactEntry | undefined = fileCount > 0 ? {
    source: `glob:${pattern}`,
    fact: `Glob "${pattern}": ${fileCount} files found`,
    step: 0,
    sticky: false // glob counts are ephemeral
  } : undefined

  return { event, fact }
}

function extractBashFacts(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const command = (args.command ?? '') as string
  const shortCmd = command.length > 60 ? command.slice(0, 60) + '...' : command
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const firstLine = resultStr.split('\n')[0] ?? ''
  const lastLine = resultStr.split('\n').filter(l => l.trim()).pop() ?? ''

  const event = `[${toolName}] ${shortCmd}: ${success ? 'ok' : 'error'}${firstLine ? ` — ${firstLine.slice(0, 80)}` : ''}`
  const fact: FactEntry = {
    source: `bash:${shortCmd}`,
    fact: `Command ${success ? 'succeeded' : 'failed'}: ${shortCmd}${lastLine ? `. Last: ${lastLine.slice(0, 80)}` : ''}`,
    step: 0,
    sticky: !success // failed commands are worth remembering
  }

  return { event, fact }
}

function extractEditWriteFacts(toolName: string, args: Record<string, unknown>, _result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const filePath = (args.file_path ?? args.path ?? 'unknown') as string
  const event = `[${toolName}] ${filePath}: ${success ? 'success' : 'error'}`
  const fact: FactEntry = {
    source: filePath,
    fact: `${toolName === 'edit' ? 'Edited' : 'Wrote'} ${filePath}: ${success ? 'success' : 'failed'}`,
    step: 0,
    sticky: true // file mutations have provenance
  }
  return { event, fact }
}

function extractFetchFacts(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const url = (args.url ?? '') as string
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const titleMatch = resultStr.match(/<title[^>]*>([^<]+)<\/title>/i)
    ?? resultStr.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1]?.trim() ?? ''

  const event = `[${toolName}] ${url}${title ? `: ${title}` : ''}`
  const fact: FactEntry | undefined = success ? {
    source: url,
    fact: `Fetched ${url}${title ? `: "${title}"` : ''}, ${resultStr.length} chars`,
    step: 0,
    sticky: true // URL fetches have provenance
  } : undefined

  return { event, fact }
}

function extractDefaultFacts(toolName: string, _args: Record<string, unknown>, result: unknown, success: boolean): { event: string; fact?: FactEntry } {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const size = resultStr.length
  const event = `[${toolName}] ${success ? 'ok' : 'error'} (${size} chars)`
  return { event }
}

// ============================================================================
// StateSummarizer
// ============================================================================

export class StateSummarizer {
  private eventLog: EventLogEntry[] = []
  private facts: FactEntry[] = []
  private config: Required<StateSummarizerConfig>

  constructor(config: StateSummarizerConfig = {}) {
    this.config = {
      maxEventEntries: config.maxEventEntries ?? 50,
      maxFactEntries: config.maxFactEntries ?? 30,
      maxStickyFacts: config.maxStickyFacts ?? 15,
      maxTokens: config.maxTokens ?? 2000
    }
  }

  /**
   * Update the summary with a new tool result
   */
  update(toolName: string, args: Record<string, unknown>, result: unknown, success: boolean, step: number): void {
    let extraction: { event: string; fact?: FactEntry }

    const baseTool = toolName.toLowerCase()
    if (baseTool === 'read') {
      extraction = extractReadFacts(toolName, args, result, success)
    } else if (baseTool === 'grep') {
      extraction = extractGrepFacts(toolName, args, result, success)
    } else if (baseTool === 'glob') {
      extraction = extractGlobFacts(toolName, args, result)
    } else if (baseTool === 'bash' || baseTool === 'exec') {
      extraction = extractBashFacts(toolName, args, result, success)
    } else if (baseTool === 'edit' || baseTool === 'write') {
      extraction = extractEditWriteFacts(toolName, args, result, success)
    } else if (baseTool === 'fetch' || baseTool === 'web_search') {
      extraction = extractFetchFacts(toolName, args, result, success)
    } else {
      extraction = extractDefaultFacts(toolName, args, result, success)
    }

    // Add event log entry
    this.eventLog.push({
      tool: toolName,
      summary: extraction.event,
      step
    })

    // Evict oldest event log entries if over limit
    if (this.eventLog.length > this.config.maxEventEntries) {
      this.eventLog = this.eventLog.slice(-this.config.maxEventEntries)
    }

    // Add fact entry if extracted
    if (extraction.fact) {
      extraction.fact.step = step
      this.facts.push(extraction.fact)
      this.evictFacts()
    }
  }

  /**
   * Two-tier fact eviction:
   * 1. If total facts exceed maxFactEntries, evict oldest non-sticky first.
   * 2. If sticky facts alone exceed maxStickyFacts, FIFO evict oldest sticky.
   */
  private evictFacts(): void {
    if (this.facts.length <= this.config.maxFactEntries) return

    // Partition into sticky and non-sticky
    const sticky = this.facts.filter(f => f.sticky)
    const nonSticky = this.facts.filter(f => !f.sticky)

    // Evict oldest non-sticky first
    const excessTotal = this.facts.length - this.config.maxFactEntries
    const nonStickyToRemove = Math.min(excessTotal, nonSticky.length)
    const survivingNonSticky = nonSticky.slice(nonStickyToRemove)

    // Cap sticky facts
    const survivingSticky = sticky.length > this.config.maxStickyFacts
      ? sticky.slice(sticky.length - this.config.maxStickyFacts)
      : sticky

    // Rebuild in chronological order
    this.facts = [...survivingSticky, ...survivingNonSticky]
      .sort((a, b) => a.step - b.step)
  }

  /**
   * Render the summary as a string for injection into messages
   */
  render(): string {
    if (this.eventLog.length === 0 && this.facts.length === 0) {
      return ''
    }

    const parts: string[] = []

    // Facts section (more valuable, placed first)
    if (this.facts.length > 0) {
      parts.push('## Accumulated Facts')
      for (const fact of this.facts) {
        const stickyTag = fact.sticky ? ' [sticky]' : ''
        parts.push(`- ${fact.fact} (src: ${fact.source})${stickyTag}`)
      }
    }

    // Event log section
    if (this.eventLog.length > 0) {
      parts.push('## Tool Event Log')
      for (const entry of this.eventLog) {
        parts.push(`- ${entry.summary}`)
      }
    }

    let rendered = parts.join('\n')

    // Trim to token budget — drop oldest event log entries first
    const tokens = countTokens(rendered)
    if (tokens > this.config.maxTokens) {
      while (this.eventLog.length > 5 && countTokens(rendered) > this.config.maxTokens) {
        this.eventLog.shift()
        rendered = this.rebuildRendered()
      }
      // If still over, truncate
      if (countTokens(rendered) > this.config.maxTokens) {
        const charLimit = this.config.maxTokens * 3
        rendered = rendered.slice(0, charLimit) + '\n[...summary truncated]'
      }
    }

    return rendered
  }

  private rebuildRendered(): string {
    const parts: string[] = []
    if (this.facts.length > 0) {
      parts.push('## Accumulated Facts')
      for (const fact of this.facts) {
        const stickyTag = fact.sticky ? ' [sticky]' : ''
        parts.push(`- ${fact.fact} (src: ${fact.source})${stickyTag}`)
      }
    }
    if (this.eventLog.length > 0) {
      parts.push('## Tool Event Log')
      for (const entry of this.eventLog) {
        parts.push(`- ${entry.summary}`)
      }
    }
    return parts.join('\n')
  }

  /**
   * Check if the summarizer has any content
   */
  hasContent(): boolean {
    return this.eventLog.length > 0 || this.facts.length > 0
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.eventLog = []
    this.facts = []
  }

  /**
   * Get event log entry count
   */
  getEventCount(): number {
    return this.eventLog.length
  }

  /**
   * Get fact entry count
   */
  getFactCount(): number {
    return this.facts.length
  }

  /**
   * Get sticky fact count
   */
  getStickyFactCount(): number {
    return this.facts.filter(f => f.sticky).length
  }
}
