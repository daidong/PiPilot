/**
 * Mention Parser
 *
 * Parses @-mentions from user messages.
 * Syntax: @type:value or @type:"quoted value"
 */

export type MentionType = 'note' | 'paper' | 'data' | 'file' | 'url'

export interface MentionRef {
  type: MentionType
  key: string
  raw: string // original matched string, e.g. @paper:smith2024
}

export interface ParseResult {
  cleanMessage: string
  mentions: MentionRef[]
}

const MENTION_RE = /@(note|paper|data|file|url):(?:"((?:[^"\\]|\\.)*)"|(\S+))/g

/**
 * Parse @-mentions from a message string.
 * Returns the cleaned message (mentions replaced with readable labels)
 * and an array of parsed mention references.
 */
export function parseMentions(message: string): ParseResult {
  const mentions: MentionRef[] = []

  const cleanMessage = message.replace(MENTION_RE, (_match, type: string, quoted: string, unquoted: string) => {
    const key = (quoted || unquoted).replace(/\\"/g, '"')
    const raw = _match
    mentions.push({ type: type as MentionType, key, raw })
    return `[${type}: ${key}]`
  })

  return { cleanMessage, mentions }
}
