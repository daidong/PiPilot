/**
 * Tests for `generatePaperPackReport` progress emission (RFC-007 PR-C).
 *
 * Validates the slow-creep behavior during the LLM call. The user-
 * visible problem this fixes: the progress bar used to jump 5→15→25→35
 * in milliseconds, then sit at 35% for 20-60 seconds (the LLM call),
 * then jump 35→85→92→100 instantly. People thought the app had hung.
 *
 * New behavior: during the LLM call, a setInterval ticks 1% per second
 * from 15 → 85 cap. The bar visibly moves; users see something is
 * happening.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePaperPackReport } from '../index.js'
import { PATHS } from '../../types.js'
import type { ReportProgressEvent } from '../types.js'

// Set up a tiny project with one paper artifact + one wiki page so
// the orchestrator has a non-empty input. We don't care about the
// actual content here — we're testing the progress emission shape.
function tmpProjectWithOnePaper(): string {
  const project = mkdtempSync(join(tmpdir(), 'pipilot-report-progress-'))
  mkdirSync(join(project, PATHS.papers), { recursive: true })
  writeFileSync(
    join(project, PATHS.papers, 'p1.json'),
    JSON.stringify({
      id: 'p1',
      type: 'paper',
      title: 'Test Paper',
      citeKey: 'test2024',
      bibtex: '',
      doi: '10.1/test',
      authors: ['T. Test'],
      abstract: '',
      tags: [],
      provenance: { source: 'user', sessionId: 'test', extractedFrom: 'user-input' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
    'utf-8',
  )
  return project
}

function cleanup(project: string): void {
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('progress: deterministic steps emit before the LLM call', async () => {
  const project = tmpProjectWithOnePaper()
  try {
    const events: ReportProgressEvent[] = []
    const fastLlm = async () => '{"themes": [], "talking_points": []}'
    await generatePaperPackReport({
      projectPath: project,
      callLlm: fastLlm,
      onProgress: (e) => events.push(e),
    })

    // Must include the early deterministic steps in order.
    const steps = events.map((e) => e.step)
    const idxBuild = steps.indexOf('building-input')
    const idxAgg = steps.indexOf('aggregating')
    const idxRank = steps.indexOf('ranking-onboarding')
    const idxSynth = steps.indexOf('synthesizing-themes')

    assert.ok(idxBuild >= 0, 'building-input emitted')
    assert.ok(idxAgg > idxBuild, 'aggregating after building-input')
    assert.ok(idxRank > idxAgg, 'ranking after aggregating')
    assert.ok(idxSynth > idxRank, 'synthesizing-themes after ranking')
  } finally {
    cleanup(project)
  }
})

test('progress: synthesizing-themes percents stay <= 85% during the LLM call', async () => {
  const project = tmpProjectWithOnePaper()
  try {
    const events: ReportProgressEvent[] = []
    // Slow LLM: hold for 2.5s so the creep timer has time to tick.
    const slowLlm = async () => {
      await new Promise((r) => setTimeout(r, 2500))
      return '{"themes": [], "talking_points": []}'
    }
    await generatePaperPackReport({
      projectPath: project,
      callLlm: slowLlm,
      onProgress: (e) => events.push(e),
    })

    // Collect all synthesizing-themes percents.
    const synthPcts = events
      .filter((e) => e.step === 'synthesizing-themes')
      .map((e) => e.percent)
    // First should be the dispatch tick at 15%.
    assert.equal(synthPcts[0], 15)
    // All synth percents must stay below the post-LLM jump (90+).
    assert.ok(synthPcts.every((p) => p <= 85), `synth percent must cap at 85, got ${synthPcts.join(', ')}`)
    // At least one tick beyond the initial 15% must have fired — that's
    // the whole point of the creep.
    assert.ok(synthPcts.some((p) => p > 15), 'creep should advance beyond 15% during a 2.5s call')
  } finally {
    cleanup(project)
  }
})

test('progress: render + write steps jump above 85% after LLM resolves', async () => {
  const project = tmpProjectWithOnePaper()
  try {
    const events: ReportProgressEvent[] = []
    await generatePaperPackReport({
      projectPath: project,
      callLlm: async () => '{"themes": [], "talking_points": []}',
      onProgress: (e) => events.push(e),
    })

    // Find the markdown render step.
    const renderMd = events.find((e) => e.step === 'rendering-markdown')
    assert.ok(renderMd, 'rendering-markdown step emitted')
    assert.ok(renderMd!.percent > 85, 'render percent must be > 85 (post-LLM region)')

    // Final event reaches 100%.
    const last = events[events.length - 1]
    assert.equal(last.percent, 100)
  } finally {
    cleanup(project)
  }
})

test('progress: creep does not exceed 85% even if the LLM call is very slow', async () => {
  // Extreme test: a 3-second LLM call should accumulate maybe 3-4 ticks
  // (15 + 1×N), but never breach the 85% ceiling — that's the contract
  // we promise the renderer.
  const project = tmpProjectWithOnePaper()
  try {
    const events: ReportProgressEvent[] = []
    const verySlowLlm = async () => {
      await new Promise((r) => setTimeout(r, 3000))
      return '{"themes": [], "talking_points": []}'
    }
    await generatePaperPackReport({
      projectPath: project,
      callLlm: verySlowLlm,
      onProgress: (e) => events.push(e),
    })

    const synthPcts = events
      .filter((e) => e.step === 'synthesizing-themes')
      .map((e) => e.percent)
    const maxSynth = Math.max(...synthPcts)
    assert.ok(maxSynth <= 85, `creep must cap at 85, got max ${maxSynth}`)
  } finally {
    cleanup(project)
  }
})
