/**
 * Tests for context-builder pure functions.
 *
 * These were extracted out of coordinator.ts; the tests lock in their
 * behavior so the coordinator split (and any future regex tweaks) can't
 * silently change classification results.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectIntentsByRules,
  classifyPersistenceDecision,
  buildMentionContext,
  buildSessionSummaryContext,
  buildRecentConversationContext,
  buildSkillSummariesPrompt
} from '../context-builder.js'
import type { SessionSummary } from '../../types.js'
import type { OrphanMessage } from '../../memory-v2/store.js'
import type { SkillEntry } from '../../skills/loader.js'

// ---------------------------------------------------------------------------
// detectIntentsByRules
// ---------------------------------------------------------------------------

test('detectIntents: literature keywords trigger literature intent', () => {
  const intents = detectIntentsByRules('Find arxiv papers on transformers')
  assert.ok(intents.has('literature'))
})

test('detectIntents: data analysis keywords trigger data intent', () => {
  const intents = detectIntentsByRules('Analyze this CSV and plot the regression')
  assert.ok(intents.has('data'))
})

test('detectIntents: Chinese keywords are recognized', () => {
  const intents = detectIntentsByRules('帮我润色这段摘要')
  assert.ok(intents.has('writing'))
})

test('detectIntents: empty message yields empty set', () => {
  const intents = detectIntentsByRules('')
  assert.equal(intents.size, 0)
})

test('detectIntents: orthogonal keywords yield multiple intents', () => {
  const intents = detectIntentsByRules('Find papers and analyze the dataset')
  assert.ok(intents.has('literature'))
  assert.ok(intents.has('data'))
})

test('detectIntents: completely off-topic message yields empty set', () => {
  const intents = detectIntentsByRules('hello there friend')
  assert.equal(intents.size, 0)
})

// ---------------------------------------------------------------------------
// classifyPersistenceDecision
// ---------------------------------------------------------------------------

test('classifyPersistence: explicit "do not save" → ephemeral', () => {
  const r = classifyPersistenceDecision('please do not save anything')
  assert.equal(r.decision, 'ephemeral')
})

test('classifyPersistence: explicit Chinese "不要保存" → ephemeral', () => {
  const r = classifyPersistenceDecision('这次不要保存这些笔记')
  assert.equal(r.decision, 'ephemeral')
})

test('classifyPersistence: "save this" → persist-requested', () => {
  const r = classifyPersistenceDecision('save this finding to my notes')
  assert.equal(r.decision, 'persist-requested')
})

test('classifyPersistence: "what is X?" → ephemeral (Q&A)', () => {
  const r = classifyPersistenceDecision('what is the difference between A and B?')
  assert.equal(r.decision, 'ephemeral')
})

test('classifyPersistence: ambiguous → conditional', () => {
  const r = classifyPersistenceDecision('please draft an introduction paragraph')
  assert.equal(r.decision, 'conditional')
})

test('classifyPersistence: explicit "do not save" beats "save" mention', () => {
  // The "do not save" branch must be checked first; this message contains both.
  const r = classifyPersistenceDecision('do not save the draft, just answer')
  assert.equal(r.decision, 'ephemeral')
})

// ---------------------------------------------------------------------------
// buildMentionContext
// ---------------------------------------------------------------------------

test('buildMentionContext: empty input returns empty string', () => {
  assert.equal(buildMentionContext(undefined), '')
  assert.equal(buildMentionContext([]), '')
})

test('buildMentionContext: filters out errored mentions', () => {
  const stubRef = { kind: 'artifact', token: 'x' } as unknown as never
  const out = buildMentionContext([
    { ref: stubRef, label: 'note A', content: 'A content' },
    { ref: stubRef, label: 'note B', content: '', error: 'load failed' },
    { ref: stubRef, label: 'note C', content: 'C content' }
  ])
  assert.ok(out.includes('note A'))
  assert.ok(out.includes('A content'))
  assert.ok(!out.includes('note B'))
  assert.ok(out.includes('note C'))
})

test('buildMentionContext: header format is "### label" + content', () => {
  const stubRef = { kind: 'artifact', token: 'x' } as unknown as never
  const out = buildMentionContext([
    { ref: stubRef, label: 'mylabel', content: 'mycontent' }
  ])
  assert.equal(out, '### mylabel\n\nmycontent')
})

// ---------------------------------------------------------------------------
// buildSessionSummaryContext
// ---------------------------------------------------------------------------

test('buildSessionSummaryContext: includes turn range, summary, topics', () => {
  const summary: SessionSummary = {
    sessionId: 'sess-A',
    turnRange: [5, 10],
    summary: 'Discussed transformer attention.',
    topicsDiscussed: ['attention', 'transformers'],
    openQuestions: ['What about RWKV?'],
    createdAt: new Date().toISOString()
  }
  const out = buildSessionSummaryContext(summary)
  assert.ok(out.includes('Turns 5-10'))
  assert.ok(out.includes('Discussed transformer attention.'))
  assert.ok(out.includes('attention, transformers'))
  assert.ok(out.includes('What about RWKV?'))
})

test('buildSessionSummaryContext: omits open-questions section when empty', () => {
  const summary: SessionSummary = {
    sessionId: 'sess-A',
    turnRange: [1, 3],
    summary: 'Brief chat.',
    topicsDiscussed: ['greetings'],
    openQuestions: [],
    createdAt: new Date().toISOString()
  }
  const out = buildSessionSummaryContext(summary)
  assert.ok(!out.includes('Open questions'))
})

// ---------------------------------------------------------------------------
// buildRecentConversationContext
// ---------------------------------------------------------------------------

test('buildRecentConversationContext: alternating user/assistant prefixes', () => {
  const msgs: OrphanMessage[] = [
    { role: 'user', content: 'Hi', timestamp: 100 },
    { role: 'assistant', content: 'Hello', timestamp: 200 }
  ]
  const out = buildRecentConversationContext(msgs)
  assert.ok(out.includes('**User:** Hi'))
  assert.ok(out.includes('**Assistant:** Hello'))
  assert.ok(out.startsWith('## Recent Conversation'))
})

test('buildRecentConversationContext: no trailing whitespace', () => {
  const msgs: OrphanMessage[] = [{ role: 'user', content: 'x', timestamp: 1 }]
  const out = buildRecentConversationContext(msgs)
  assert.equal(out, out.trimEnd())
})

// ---------------------------------------------------------------------------
// buildSkillSummariesPrompt
// ---------------------------------------------------------------------------

test('buildSkillSummariesPrompt: empty skill list returns empty string', () => {
  assert.equal(buildSkillSummariesPrompt([]), '')
})

test('buildSkillSummariesPrompt: includes load_skill rule and per-skill section', () => {
  const skills: SkillEntry[] = [{
    name: 'paper-writing',
    description: 'Strategic paper drafting',
    category: 'Writing',
    depends: [],
    tags: [],
    triggers: [],
    path: 'mock/path',
    dir: '/mock',
    source: 'builtin' as const,
    content: '---\nname: paper-writing\ndescription: x\n---\n\nOverview content.'
  }]
  const out = buildSkillSummariesPrompt(skills)
  assert.ok(out.includes('Matched Skill Summaries'))
  assert.ok(out.includes('load_skill'))
  assert.ok(out.includes('Pre-loaded: paper-writing'))
})
