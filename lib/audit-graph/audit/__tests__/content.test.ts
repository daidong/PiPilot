import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { stripBlobTokens, isGibberish, distillForExtraction } from '../content.js'

test('stripBlobTokens removes sha256 digests and contentHash envelopes', () => {
  const s = 'mean was {"contentHash":"sha256:62963d4a4830220a9da8559909675c598c0"} and 4.2'
  const out = stripBlobTokens(s)
  assert.ok(!/sha256:/.test(out))
  assert.ok(!/62963d4a/.test(out))
  assert.ok(out.includes('4.2'), 'real numbers survive')
})

test('isGibberish flags mojibake/binary but passes prose', () => {
  assert.equal(isGibberish('I read all 6 files and computed the mean.'), false)
  assert.equal(isGibberish('��\x00\x01�\x02 garble �\x03�\x04�'), true)
})

test('distillForExtraction drops blacklisted verbose fields, keeps identifiers', async () => {
  const result = JSON.stringify({
    provider: 'arxiv',
    query: '"X-ray time profile" "burst-1"',
    count: 10,
    results: [{ title: 'The Low Frequency Perspective', url: 'http://arxiv.org/abs/2203.04890v1', snippet: 'Fast radio bursts represent...'.repeat(50) }],
  })
  const out = await distillForExtraction(result)
  assert.ok(out.includes('X-ray time profile'), 'query kept')
  assert.ok(out.includes('arxiv.org/abs/2203.04890v1'), 'url kept')
  assert.ok(out.includes('Low Frequency Perspective'), 'title kept')
  assert.ok(!out.includes('Fast radio bursts represent'), 'snippet dropped')
})

test('distillForExtraction keeps response_text thinking/text prose (not field-filtered)', async () => {
  const body = JSON.stringify([
    { type: 'thinking', thinking: 'I will read all 6 files in the Frozen section.' },
    { type: 'text', text: 'FINAL ANSWER: 86' },
  ])
  const out = await distillForExtraction(body)
  assert.ok(out.includes('read all 6 files in the Frozen section'))
  assert.ok(out.includes('FINAL ANSWER: 86'))
})

test('distillForExtraction returns empty for gibberish (PDF-as-text)', async () => {
  const garbage = '%PDF-1.4��\x00\x01stream��\x02\x03��� endstream\x00�'.repeat(4)
  assert.equal(await distillForExtraction(garbage), '')
})
