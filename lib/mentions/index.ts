/**
 * Mentions module - @-mention parsing and resolution
 */

export { parseMentions } from './parser.js'
export type { MentionType, MentionRef, ParseResult } from './parser.js'

export { resolveMentions } from './resolver.js'
export type { ResolvedMention } from './resolver.js'

export { getCandidates } from './candidates.js'
export type { MentionCandidate } from './candidates.js'
