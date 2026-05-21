/**
 * Tests for the renderer-side recap-store display/dedup state machine.
 *
 * The store separates GENERATION (a background recap arrives via setLatest while
 * the user is away) from DISPLAY (surfaced on reopen / return-from-idle), and
 * enforces Claude-Code-style dedup:
 *   - never show the same recap twice in a row (`shown`)
 *   - don't regenerate until a fresh turn (`lastGenKey`)
 *   - a feature toggle (`enabled`) gates both display and (via App) generation
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useRecapStore, type Recap } from '../recap-store'

function makeRecap(overrides: Partial<Recap> = {}): Recap {
  return {
    sessionId: 'session-A',
    did: 'You were building the recap feature.',
    next: 'Wire the away trigger.',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

beforeEach(() => {
  useRecapStore.setState({
    enabled: true,
    latest: null,
    visible: false,
    wantShow: false,
    shown: false,
    lastGenKey: null
  })
})

test('setLatest stores the recap but does not surface it', () => {
  useRecapStore.getState().setLatest(makeRecap())
  const s = useRecapStore.getState()
  assert.ok(s.latest)
  assert.equal(s.visible, false)
  assert.equal(s.shown, false)
})

test('hydrate surfaces a present recap once and seeds the dedup key', () => {
  useRecapStore.getState().hydrate(makeRecap(), 'msg-1')
  const s = useRecapStore.getState()
  assert.equal(s.visible, true)
  assert.equal(s.shown, true)
  assert.equal(s.lastGenKey, 'msg-1')
})

test('hydrate(null) clears the card', () => {
  useRecapStore.getState().setLatest(makeRecap())
  useRecapStore.getState().hydrate(null, 'msg-1')
  const s = useRecapStore.getState()
  assert.equal(s.latest, null)
  assert.equal(s.visible, false)
})

test('requestShow surfaces an unshown latest', () => {
  useRecapStore.getState().setLatest(makeRecap())
  useRecapStore.getState().requestShow()
  const s = useRecapStore.getState()
  assert.equal(s.visible, true)
  assert.equal(s.shown, true)
})

test('no consecutive repeat: once shown, hide + requestShow does not re-surface', () => {
  useRecapStore.getState().setLatest(makeRecap())
  useRecapStore.getState().requestShow() // shown
  useRecapStore.getState().hide()
  useRecapStore.getState().requestShow() // same recap → must NOT show again
  assert.equal(useRecapStore.getState().visible, false)
})

test('a new recap (setLatest) re-arms display after a previous one was shown', () => {
  useRecapStore.getState().setLatest(makeRecap({ did: 'first' }))
  useRecapStore.getState().requestShow()
  useRecapStore.getState().hide()
  useRecapStore.getState().setLatest(makeRecap({ did: 'second' })) // fresh → shown=false
  useRecapStore.getState().requestShow()
  const s = useRecapStore.getState()
  assert.equal(s.visible, true)
  assert.equal(s.latest!.did, 'second')
})

test('requestShow defers when latest is not ready, then setLatest honors it', () => {
  useRecapStore.getState().requestShow()
  assert.equal(useRecapStore.getState().wantShow, true)
  useRecapStore.getState().setLatest(makeRecap())
  const s = useRecapStore.getState()
  assert.equal(s.visible, true)
  assert.equal(s.wantShow, false)
})

test('markGenerating records the dedup key', () => {
  useRecapStore.getState().markGenerating('msg-42')
  assert.equal(useRecapStore.getState().lastGenKey, 'msg-42')
})

test('disabled: requestShow does nothing and a present recap is not surfaced', () => {
  useRecapStore.getState().setEnabled(false)
  useRecapStore.getState().setLatest(makeRecap())
  useRecapStore.getState().requestShow()
  assert.equal(useRecapStore.getState().visible, false)
})

test('disabled: hydrate does not surface the persisted recap', () => {
  useRecapStore.getState().setEnabled(false)
  useRecapStore.getState().hydrate(makeRecap(), 'msg-1')
  const s = useRecapStore.getState()
  assert.equal(s.visible, false)
  assert.ok(s.latest) // still stored, just not shown
})

test('setEnabled(false) hides an open card', () => {
  useRecapStore.getState().hydrate(makeRecap(), 'msg-1') // visible
  useRecapStore.getState().setEnabled(false)
  assert.equal(useRecapStore.getState().visible, false)
})

test('hide / dismiss keep the latest recap', () => {
  useRecapStore.getState().hydrate(makeRecap(), 'msg-1')
  useRecapStore.getState().dismiss()
  assert.ok(useRecapStore.getState().latest)
  assert.equal(useRecapStore.getState().visible, false)
})

test('clear forgets per-session state but keeps the enabled pref', () => {
  useRecapStore.getState().hydrate(makeRecap(), 'msg-1')
  useRecapStore.getState().clear()
  const s = useRecapStore.getState()
  assert.equal(s.latest, null)
  assert.equal(s.visible, false)
  assert.equal(s.lastGenKey, null)
  assert.equal(s.enabled, true) // pref survives a project switch
})
