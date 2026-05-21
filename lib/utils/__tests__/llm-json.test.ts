import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonObjectFromText } from '../llm-json.js'

test('parseJsonObjectFromText: parses fenced json block', () => {
  assert.deepEqual(parseJsonObjectFromText('```json\n{"ok":true}\n```'), { ok: true })
})

test('parseJsonObjectFromText: parses prose-wrapped object', () => {
  assert.deepEqual(parseJsonObjectFromText('Here is the result:\n{"a":1}\nThanks.'), { a: 1 })
})

test('parseJsonObjectFromText: handles braces inside strings', () => {
  assert.deepEqual(parseJsonObjectFromText('{"text":"literal { brace } content","n":2} trailing'), {
    text: 'literal { brace } content',
    n: 2
  })
})

test('parseJsonObjectFromText: skips invalid early objects and keeps scanning', () => {
  assert.deepEqual(parseJsonObjectFromText('bad {nope} then {"valid":true}'), { valid: true })
})

test('parseJsonObjectFromText: returns null when no object parses', () => {
  assert.equal(parseJsonObjectFromText('No structured data here.'), null)
})
