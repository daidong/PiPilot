import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { GraphNode } from '../../types.js'
import { extractResponseTextFromStep } from '../claims.js'

function step(blocks: unknown): GraphNode {
  return { id: 's', kind: 'step', label: 's', rawEvents: [{ name: 'pipilot.chat.response_text', body: JSON.stringify(blocks) }] }
}

test('extractResponseTextFromStep reads thinking blocks (where reasoning lives), not just text', () => {
  const node = step([
    { type: 'thinking', thinking: 'I need to read all 6 data files and sum the totals.' },
    { type: 'tool_use', name: 'read', input: { path: 'a.csv' } },
  ])
  assert.match(extractResponseTextFromStep(node), /read all 6 data files/)
})

test('extractResponseTextFromStep concatenates thinking + final text', () => {
  const node = step([
    { type: 'thinking', thinking: 'Analyzing the table.' },
    { type: 'text', text: 'FINAL ANSWER: 86' },
  ])
  const out = extractResponseTextFromStep(node)
  assert.match(out, /Analyzing the table/)
  assert.match(out, /FINAL ANSWER: 86/)
})

test('extractResponseTextFromStep yields empty for a tool-only step (no narrative)', () => {
  const node = step([{ type: 'tool_use', name: 'read', input: { path: 'a.csv' } }])
  assert.equal(extractResponseTextFromStep(node), '')
})
