import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { extractClaimsLlm, normalizeExtractedClaims } from '../extract-claims.js'

test('normalizeExtractedClaims coerces shapes and assigns stable ids', () => {
  const claims = normalizeExtractedClaims([
    { text: 'I read 10 files.', quantities: [{ value: 10, unit: 'files' }], entities: ['data/'], scope: 'all' },
    { text: 'mean was 4.2', quantities: [{ value: 4.2 }], entities: [], scope: null },
    { text: '   ', quantities: [], entities: [], scope: null }, // dropped: empty
    { quantities: [], entities: [], scope: null }, // dropped: no text
  ], 'span:step2')

  assert.equal(claims.length, 2)
  assert.equal(claims[0].id, 'claim_span:step2_1')
  assert.equal(claims[0].sourceNodeId, 'span:step2')
  assert.equal(claims[0].scope, 'ALL')
  assert.deepEqual(claims[0].quantities, [{ value: 10, unit: 'files' }])
  assert.equal(claims[1].scope, null)
})

test('normalizeExtractedClaims drops malformed quantities and non-string entities', () => {
  const claims = normalizeExtractedClaims([
    { text: 'x', quantities: [{ value: 'NaN' }, { value: 3 }, { unit: 'files' }], entities: ['a', 5, 'a'], scope: 'EACH' },
  ], 'n')
  assert.deepEqual(claims[0].quantities, [{ value: 3 }])
  assert.deepEqual(claims[0].entities, ['a'])
  assert.equal(claims[0].scope, 'EACH')
})

test('extractClaimsLlm parses a fenced/noisy JSON array and skips empty output', async () => {
  const noisy = 'Here are the claims:\n[{"text":"I analyzed 3 datasets","quantities":[{"value":3,"unit":"datasets"}],"entities":[],"scope":"ALL"}]\nDone.'
  const claims = await extractClaimsLlm({ sourceNodeId: 'n1', outputText: 'I analyzed 3 datasets', callLlm: async () => noisy })
  assert.equal(claims.length, 1)
  assert.equal(claims[0].text, 'I analyzed 3 datasets')

  const none = await extractClaimsLlm({ sourceNodeId: 'n1', outputText: '   ', callLlm: async () => '[]' })
  assert.deepEqual(none, [])

  const garbage = await extractClaimsLlm({ sourceNodeId: 'n1', outputText: 'x', callLlm: async () => 'not json' })
  assert.deepEqual(garbage, [])
})
