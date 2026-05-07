/**
 * Context-builder helpers for the coordinator.
 *
 * Pure functions extracted from `coordinator.ts` so the coordinator stays
 * focused on agent + LLM lifecycle. Each function takes a small input
 * shape and returns a string ready to be concatenated into the user
 * message context block, plus a couple of classifiers used by the
 * explain-snapshot path.
 *
 * No I/O, no LLM calls, no telemetry — keeps these trivially testable.
 */

import type { ResolvedMention } from '../mentions/index.js'
import type { SessionSummary } from '../types.js'
import type { OrphanMessage } from '../memory-v2/store.js'
import { buildSkillSummary, type SkillEntry } from '../skills/loader.js'

// ---------------------------------------------------------------------------
// Intent detection (rule-based)
// ---------------------------------------------------------------------------

export type IntentLabel =
  | 'literature'
  | 'data'
  | 'writing'
  | 'critique'
  | 'web'
  | 'citation'
  | 'grants'
  | 'docx'
  | 'general'

export function detectIntentsByRules(message: string): Set<IntentLabel> {
  const text = message.toLowerCase()
  const intents = new Set<IntentLabel>()

  if (/(paper|papers|literature|related work|citation|survey|systematic review|find papers|arxiv|doi|bibtex|scholar)/.test(text)) intents.add('literature')
  if (/(data|dataset|csv|tsv|xlsx|xls|json|parquet|statistics|statistical|analysis|analyze|visualize|plot|chart|graph|matplotlib|seaborn|regression|modeling|correlation|distribution|outlier)/.test(text)) intents.add('data')
  if (/(rewrite|draft|write|outline|abstract|introduction|section|manuscript|proposal|review article|写作|改写|润色|摘要|大纲)/.test(text)) intents.add('writing')
  if (/(citation|cite|bibtex|endnote|zotero|doi|reference list|references|参考文献|引文|引证)/.test(text)) intents.add('citation')
  if (/(grant|grants|proposal|specific aims|broader impacts|nih|nsf|doe|darpa|funding|资助|基金|申报书)/.test(text)) intents.add('grants')
  if (/(docx|word document|tracked changes|track changes|ooxml|comment thread|批注|修订)/.test(text)) intents.add('docx')
  if (/(critique|review|evaluate|assessment|assess|weakness|limitation|pros|cons|flaw|评审|评价|批评|缺陷|可行性)/.test(text)) intents.add('critique')
  if (/(latest|today|news|deadline|release|price|官网|新闻|截止|版本)/.test(text)) intents.add('web')

  return intents
}

// ---------------------------------------------------------------------------
// Persistence classification
// ---------------------------------------------------------------------------

export type PersistenceDecision = 'ephemeral' | 'conditional' | 'persist-requested'

export function classifyPersistenceDecision(message: string): { decision: PersistenceDecision; reason: string } {
  const text = message.toLowerCase()

  if (/(do not save|don't save|no artifact|just answer|不要保存|别保存|不用保存)/.test(text)) {
    return { decision: 'ephemeral', reason: 'User explicitly requested no persistence.' }
  }

  if (/(save|persist|remember|track|record|store|archive|保存|记住|记录|跟踪|持久化)/.test(text)) {
    return { decision: 'persist-requested', reason: 'User requested durable tracking or saving.' }
  }

  if (/(^|\s)(why|what|how|status|clarify|explain|check)(\s|$)|为什么|怎么|是否|有无|确认/.test(text)) {
    return { decision: 'ephemeral', reason: 'Message appears to be clarification/status Q&A.' }
  }

  return { decision: 'conditional', reason: 'Persist only if reuse/traceability triggers are met during execution.' }
}

// ---------------------------------------------------------------------------
// User-message context blocks
// ---------------------------------------------------------------------------

export function buildMentionContext(mentions?: ResolvedMention[]): string {
  if (!mentions || mentions.length === 0) return ''

  return mentions
    .filter(m => !m.error)
    .map(m => `### ${m.label}\n\n${m.content}`)
    .join('\n\n')
}

export function buildSessionSummaryContext(summary: SessionSummary): string {
  const lines = [
    '## Session Summary',
    `Turns ${summary.turnRange[0]}-${summary.turnRange[1]}:`,
    summary.summary,
    '',
    `Topics: ${summary.topicsDiscussed.join(', ')}`,
    ...(summary.openQuestions.length > 0
      ? ['Open questions:', ...summary.openQuestions.map(q => `- ${q}`)]
      : [])
  ]
  return lines.join('\n')
}

export function buildRecentConversationContext(messages: OrphanMessage[]): string {
  const lines = ['## Recent Conversation (resumed from prior session)', '']
  for (const msg of messages) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant'
    lines.push(`**${speaker}:** ${msg.content}`, '')
  }
  return lines.join('\n').trimEnd()
}

export function buildSkillSummariesPrompt(matchedSkills: SkillEntry[]): string {
  if (matchedSkills.length === 0) return ''
  const sections = matchedSkills.map(s => {
    const summary = buildSkillSummary(s)
    return `### Pre-loaded: ${s.name}\n\n${summary}`
  })
  return [
    '## Matched Skill Summaries',
    'The following skills have been pre-matched to this request. The summaries below are overviews only — they do NOT contain the full procedures, scripts, or parameters.',
    '**Rule: Always call `load_skill(name)` before executing any skill procedure.** The summary is for deciding whether a skill is relevant; the full content is required before acting on it.',
    '',
    ...sections
  ].join('\n\n')
}
