/**
 * Tests for B-class sub-task model-tier resolution.
 *
 * Locks two things the feature depends on:
 *  1. resolveSubTaskModel() picks light ONLY when the call opted in AND the
 *     global setting permits it AND a light model exists — otherwise the main
 *     model. This is the guard that keeps non-sinkable calls (and the A/B
 *     control group) on the flagship.
 *  2. The Settings plumbing defaults subTaskModelTier to 'light' and passes it
 *     through resolveSettings() unchanged.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSubTaskModel } from '../sub-task-tier.js'
import { resolveSettings, DEFAULT_SETTINGS } from '../../../shared-ui/settings-types.js'

// String sentinels stand in for pi-ai Model instances — resolveSubTaskModel is
// generic and only does identity selection, so it never inspects the value.
const MAIN = 'main-model'
const LIGHT = 'light-model'

test('sinks to light when opted in and setting permits and light exists', () => {
  const m = resolveSubTaskModel('light', { mainModel: MAIN, lightModel: LIGHT, setting: 'light' })
  assert.equal(m, LIGHT)
})

test('flagship setting overrides a light opt-in (A/B control group)', () => {
  const m = resolveSubTaskModel('light', { mainModel: MAIN, lightModel: LIGHT, setting: 'flagship' })
  assert.equal(m, MAIN)
})

test('falls back to main when provider has no light model', () => {
  const m = resolveSubTaskModel('light', { mainModel: MAIN, lightModel: null, setting: 'light' })
  assert.equal(m, MAIN)
})

test('non-sinkable call (flagship tier) stays on main even when setting is light', () => {
  const m = resolveSubTaskModel('flagship', { mainModel: MAIN, lightModel: LIGHT, setting: 'light' })
  assert.equal(m, MAIN)
})

test('default callers (no tier opt-in) stay on main — backward compatible', () => {
  const m = resolveSubTaskModel(undefined, { mainModel: MAIN, lightModel: LIGHT, setting: 'light' })
  assert.equal(m, MAIN)
})

test('resolveSettings defaults subTaskModelTier to light', () => {
  assert.equal(DEFAULT_SETTINGS.research.subTaskModelTier, 'light')
  assert.equal(resolveSettings(DEFAULT_SETTINGS).subTaskModelTier, 'light')
})

test('resolveSettings passes a flagship choice through unchanged', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    research: { ...DEFAULT_SETTINGS.research, subTaskModelTier: 'flagship' as const },
  }
  assert.equal(resolveSettings(settings).subTaskModelTier, 'flagship')
})
