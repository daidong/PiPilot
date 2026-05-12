/**
 * Tests for the synthesizer's JSON extraction + citation-validation
 * post-processing (RFC-007 PR-B).
 *
 * The LLM call itself is faked. These tests cover the deterministic
 * boundary: what the model said vs. what reaches the renderer.
 *
 * Two layers:
 *   1. `extractJsonFromResponse` — robust parsing of fenced / unfenced JSON
 *   2. `validateAndCleanSynthesis` — strips hallucinated citeKeys, drops
 *      themes/talking-points with zero valid citations
 *   3. `synthesizeThemes` end-to-end with a fake callLlm
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractJsonFromResponse,
  validateAndCleanSynthesis,
  synthesizeThemes,
} from '../synthesize.js'
import type { ReportInput, ReportPaperEntry } from '../types.js'
import type { PaperArtifact } from '../../types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

function paper(citeKey: string): PaperArtifact {
  return {
    id: `art-${citeKey}`,
    type: 'paper',
    title: `Title ${citeKey}`,
    citeKey,
    bibtex: '',
    doi: `10.1/${citeKey}`,
    authors: ['Author'],
    abstract: 'abstract',
    tags: [],
    provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as PaperArtifact
}

function entry(citeKey: string): ReportPaperEntry {
  return { paper: paper(citeKey), wiki: null }
}

function inputOf(citeKeys: string[]): ReportInput {
  return {
    projectPath: '/tmp/test',
    projectName: 'TestProject',
    papers: citeKeys.map(entry),
    capturedAt: '2026-05-12T00:00:00Z',
  }
}

// ─── extractJsonFromResponse ─────────────────────────────────────────────

test('extractJsonFromResponse: fenced ```json block', () => {
  const raw = 'Some preamble.\n\n```json\n{"themes": [], "talking_points": []}\n```\n\nDone.'
  const parsed = extractJsonFromResponse(raw)
  assert.ok(parsed, 'parses')
  assert.deepEqual(parsed!.themes, [])
})

test('extractJsonFromResponse: fenced ``` block without json tag', () => {
  const raw = '```\n{"themes": []}\n```'
  const parsed = extractJsonFromResponse(raw)
  assert.ok(parsed)
})

test('extractJsonFromResponse: raw JSON without fence', () => {
  const raw = '{"themes": [], "talking_points": [{"point": "X [a]", "cite_keys": ["a"]}]}'
  const parsed = extractJsonFromResponse(raw)
  assert.ok(parsed)
  assert.equal(parsed!.talking_points?.length, 1)
})

test('extractJsonFromResponse: greedy first-brace to last-brace with trailing prose', () => {
  const raw = '{"themes": [{"name": "T", "papers": [], "synthesis": "S [a]"}]}\n\nNotes follow here.'
  const parsed = extractJsonFromResponse(raw)
  assert.ok(parsed)
  assert.equal(parsed!.themes?.length, 1)
})

test('extractJsonFromResponse: returns null on unparseable garbage', () => {
  assert.equal(extractJsonFromResponse('No JSON anywhere here, just prose.'), null)
})

test('extractJsonFromResponse: returns null on JSON with truly broken syntax', () => {
  // Curly braces but invalid — broken structure that can't parse.
  assert.equal(extractJsonFromResponse('{ themes: "this is not valid JSON" : not }'), null)
})

// ─── validateAndCleanSynthesis ───────────────────────────────────────────

test('validateAndClean: keeps themes whose synthesis cites valid papers', () => {
  const raw = {
    themes: [
      { name: 'Good Theme', papers: ['a', 'b'], synthesis: 'Some claim [a] and another [b].' },
    ],
    talking_points: [
      { point: 'Surprise: X [a].', cite_keys: ['a'] },
    ],
  }
  const valid = new Set(['a', 'b'])
  const out = validateAndCleanSynthesis(raw, valid)
  assert.equal(out.themes.length, 1)
  assert.equal(out.talkingPoints.length, 1)
})

test('validateAndClean: strips hallucinated citeKeys from synthesis', () => {
  const raw = {
    themes: [
      {
        name: 'Mixed',
        papers: ['a', 'phantom1'],
        synthesis: 'Real cite [a]. Hallucinated cite [phantom1, phantom2]. Another real [a].',
      },
    ],
    talking_points: [],
  }
  const valid = new Set(['a'])
  const out = validateAndCleanSynthesis(raw, valid)
  assert.equal(out.themes.length, 1)
  assert.deepEqual(out.themes[0].papers, ['a'])  // phantom1 stripped from list
  assert.ok(!out.themes[0].synthesis.includes('phantom1'), 'phantom1 stripped from text')
  assert.ok(!out.themes[0].synthesis.includes('phantom2'), 'phantom2 stripped from text')
  assert.ok(out.themes[0].synthesis.includes('[a]'), 'valid cite kept')
})

test('validateAndClean: drops themes with ZERO valid citations after cleaning', () => {
  const raw = {
    themes: [
      { name: 'Fully Fake', papers: ['fake'], synthesis: 'All hallucinated [fake1, fake2].' },
    ],
    talking_points: [],
  }
  const out = validateAndCleanSynthesis(raw, new Set(['a']))
  assert.equal(out.themes.length, 0, 'theme dropped because no valid citations remain')
})

test('validateAndClean: drops empty / missing name + synthesis', () => {
  const raw = {
    themes: [
      { name: '', papers: ['a'], synthesis: 'Has citation [a].' },
      { name: 'Name', papers: ['a'], synthesis: '' },
    ],
    talking_points: [],
  }
  const out = validateAndCleanSynthesis(raw, new Set(['a']))
  assert.equal(out.themes.length, 0)
})

test('validateAndClean: drops talking points with no valid citations', () => {
  const raw = {
    themes: [],
    talking_points: [
      { point: 'Valid [a].', cite_keys: ['a'] },
      { point: 'Hallucinated [fake].', cite_keys: ['fake'] },
    ],
  }
  const out = validateAndCleanSynthesis(raw, new Set(['a']))
  assert.equal(out.talkingPoints.length, 1)
  assert.equal(out.talkingPoints[0].citeKeys[0], 'a')
})

test('validateAndClean: handles cite-key syntax [a, b] (multi-key)', () => {
  const raw = {
    themes: [{ name: 'T', papers: ['a', 'b'], synthesis: 'Both [a, b] claim X.' }],
    talking_points: [],
  }
  const out = validateAndCleanSynthesis(raw, new Set(['a', 'b']))
  assert.ok(out.themes[0].synthesis.includes('[a, b]') || out.themes[0].synthesis.includes('[a], [b]'))
})

// ─── synthesizeThemes end-to-end with fake LLM ──────────────────────────

test('synthesizeThemes: passes input + system prompt to callLlm, returns parsed themes', async () => {
  const captured: { system: string; user: string }[] = []
  const fakeLlm = async (system: string, user: string): Promise<string> => {
    captured.push({ system, user })
    return JSON.stringify({
      themes: [
        { name: 'Test Theme', papers: ['a'], synthesis: 'Synth claim [a].' },
      ],
      talking_points: [
        { point: 'TP [a].', cite_keys: ['a'] },
      ],
    })
  }
  const result = await synthesizeThemes(inputOf(['a']), fakeLlm)
  assert.equal(captured.length, 1)
  assert.match(captured[0].system, /research analyst/i)
  assert.match(captured[0].user, /Paper pack/)
  assert.match(captured[0].user, /## a:/)
  assert.equal(result.themes.length, 1)
  assert.equal(result.themes[0].name, 'Test Theme')
  assert.equal(result.talkingPoints.length, 1)
})

test('synthesizeThemes: LLM returns garbage → empty arrays, no throw', async () => {
  const result = await synthesizeThemes(inputOf(['a']), async () => 'Not JSON anywhere.')
  assert.deepEqual(result.themes, [])
  assert.deepEqual(result.talkingPoints, [])
  assert.equal(result.rawResponse, 'Not JSON anywhere.')
})

test('synthesizeThemes: hallucinated citeKeys get stripped from output', async () => {
  const fakeLlm = async (): Promise<string> => JSON.stringify({
    themes: [
      { name: 'T', papers: ['a', 'phantom'], synthesis: 'A real [a]. A fake [phantom].' },
    ],
    talking_points: [],
  })
  const result = await synthesizeThemes(inputOf(['a']), fakeLlm)
  assert.equal(result.themes[0].papers.length, 1)
  assert.equal(result.themes[0].papers[0], 'a')
  assert.ok(!result.themes[0].synthesis.includes('phantom'))
})
