/**
 * Drift guard for the model registry.
 *
 * Two pure copies of the model-migration table still exist by necessity:
 *   - lib/models.ts        — the framework-independent core (cannot depend on
 *                            the UI layer, so it keeps its own table)
 *   - shared-ui/constants  — imported by the renderer AND (now) shared-electron
 *
 * shared-electron used to keep a THIRD inline copy; it now imports from
 * shared-ui, so it can't drift. These two remaining copies must stay equal —
 * a user mid-upgrade is migrated by whichever layer sees their stale id first,
 * and divergence means one layer silently fails to migrate (this is exactly
 * how `openai:gpt-5.4-pro` went missing from lib). This test fails CI loudly
 * if the tables drift again.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RETIRED_MODEL_MIGRATIONS as LIB_MIGRATIONS,
  DEFAULT_MODEL_ID,
  inferProviderFromModelId as libInfer,
} from '../models.js'
import {
  RETIRED_MODEL_MIGRATIONS as UI_MIGRATIONS,
  DEFAULT_MODEL as UI_DEFAULT_MODEL,
} from '../../shared-ui/constants.js'
import { inferProviderFromModelId as uiInfer } from '../../shared-ui/utils.js'

test('retired-model migration tables are identical across lib and shared-ui', () => {
  assert.deepEqual(
    LIB_MIGRATIONS,
    UI_MIGRATIONS,
    'lib/models.ts and shared-ui/constants.ts RETIRED_MODEL_MIGRATIONS have drifted — sync both.',
  )
})

test('default model id agrees across lib and shared-ui', () => {
  assert.equal(DEFAULT_MODEL_ID, UI_DEFAULT_MODEL)
})

test('inferProviderFromModelId agrees across lib and shared-ui', () => {
  const samples = [
    'claude-opus-4-7',
    'gpt-5.5',
    'o3-mini',
    'o4',
    'gemini-2.0-flash-lite',
    'deepseek-v4-pro',
    'totally-unknown-model',
  ]
  for (const id of samples) {
    assert.equal(libInfer(id), uiInfer(id), `provider inference diverged for "${id}"`)
  }
})
