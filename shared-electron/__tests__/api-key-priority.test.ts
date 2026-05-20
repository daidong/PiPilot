/**
 * Tests for the API-key loading priority rule: **config wins over env**.
 *
 * Background: shipping v1 with "env wins over config" caused a silent
 * footgun — a user who explicitly saved fresh keys in the Settings UI
 * would still get stale shell-exported keys on the next launch, because
 * the loader skipped loading from disk when env was non-empty. Symptom
 * for AWS Phase 1: Test connection green, but RunInstances reported
 * the IAM instance profile as "Invalid" because RP was talking to a
 * different AWS account than the user's CLI.
 *
 * The fix flips priority so a UI save is the user's authoritative
 * intent. Env stays as fallback for unconfigured keys / CI launches.
 *
 * These tests pin the contract so the priority can't be reverted
 * without a deliberate code change + a failing test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
// Import from the pure-logic module so the test doesn't transitively
// load `electron` (whose `shell` export is unavailable under plain Node).
import { applyApiKeysToEnv } from '../api-key-loader.js'

const KEY = 'AWS_ACCESS_KEY_ID'

test('apiKeys loading: config wins when both env and config are set (the bug fix)', () => {
  const env: Record<string, string | undefined> = { [KEY]: 'env-stale' }
  applyApiKeysToEnv({ [KEY]: 'config-fresh' }, env)
  assert.equal(env[KEY], 'config-fresh',
    'config-saved value must overwrite a non-empty env var — Settings UI is the authoritative signal')
})

test('apiKeys loading: env retained when config is empty (env-as-fallback)', () => {
  const env: Record<string, string | undefined> = { [KEY]: 'env-only' }
  applyApiKeysToEnv({ [KEY]: '' }, env)
  assert.equal(env[KEY], 'env-only',
    'empty/unset config must NOT clobber a real env value — env is the fallback path')
})

test('apiKeys loading: env retained when config is whitespace-only', () => {
  const env: Record<string, string | undefined> = { [KEY]: 'env-only' }
  applyApiKeysToEnv({ [KEY]: '   ' }, env)
  assert.equal(env[KEY], 'env-only',
    'whitespace-only config must be treated as empty')
})

test('apiKeys loading: config loaded into env when env was empty', () => {
  const env: Record<string, string | undefined> = {}
  applyApiKeysToEnv({ [KEY]: 'config-only' }, env)
  assert.equal(env[KEY], 'config-only')
})

test('apiKeys loading: both empty leaves env untouched (no spurious set)', () => {
  const env: Record<string, string | undefined> = {}
  applyApiKeysToEnv({ [KEY]: '' }, env)
  assert.equal(env[KEY], undefined,
    'no key should be created from a blank config value')
})

test('apiKeys loading: undefined apiKeys (no config block) is a no-op', () => {
  const env: Record<string, string | undefined> = { [KEY]: 'env-untouched' }
  applyApiKeysToEnv(undefined, env)
  assert.equal(env[KEY], 'env-untouched')
})

test('apiKeys loading: unknown keys in config are ignored (only API_KEY_NAMES whitelist applies)', () => {
  // A future contributor adding a new key in config.json shouldn't see
  // it silently flow into process.env unless they also add it to
  // API_KEY_NAMES — that's the surface where save/load is policy-gated.
  const env: Record<string, string | undefined> = {}
  applyApiKeysToEnv({ NOT_AN_API_KEY: 'should-not-leak' }, env)
  assert.equal(env.NOT_AN_API_KEY, undefined)
})

test('apiKeys loading: all 12 keys handled — happy path covers each API_KEY_NAMES entry', () => {
  // Smoke test that the loop iterates the whole list. If someone adds a
  // new key but forgets to test it, this still gives confidence that
  // the mechanism applies uniformly.
  const env: Record<string, string | undefined> = {}
  const config = {
    OPENAI_API_KEY: 'o',
    ANTHROPIC_API_KEY: 'a',
    BRAVE_API_KEY: 'b',
    OPENROUTER_API_KEY: 'or',
    PAPERCLIP_API_KEY: 'p',
    DEEPSEEK_API_KEY: 'd',
    SEMANTIC_SCHOLAR_API_KEY: 's',
    MODAL_TOKEN_ID: 'mid',
    MODAL_TOKEN_SECRET: 'msec',
    AWS_ACCESS_KEY_ID: 'aki',
    AWS_SECRET_ACCESS_KEY: 'asak',
    AWS_SESSION_TOKEN: 'ast',
  }
  applyApiKeysToEnv(config, env)
  for (const [k, v] of Object.entries(config)) {
    assert.equal(env[k], v, `key ${k} should have been loaded`)
  }
})

test('apiKeys loading: AWS account-mismatch scenario reproduces with new priority', () => {
  // The exact bug we hit: shell has stale AWS_ACCESS_KEY_ID from account X,
  // user saves account Y's key in the UI. After loadApiKeysFromConfig,
  // env must reflect account Y (the saved value), not account X.
  const env: Record<string, string | undefined> = {
    AWS_ACCESS_KEY_ID: 'AKIA-ACCOUNT-X-STALE',
    AWS_SECRET_ACCESS_KEY: 'secret-X-stale',
  }
  applyApiKeysToEnv({
    AWS_ACCESS_KEY_ID: 'AKIA-ACCOUNT-Y-FRESH',
    AWS_SECRET_ACCESS_KEY: 'secret-Y-fresh',
  }, env)
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIA-ACCOUNT-Y-FRESH',
    'saved AWS key (account Y) must beat stale shell env (account X)')
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'secret-Y-fresh')
})
