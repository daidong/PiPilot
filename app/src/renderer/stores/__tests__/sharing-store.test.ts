/**
 * Tests for the renderer-side sharing-store — specifically the SyncPill state
 * machine, where a displayed state must never contradict reality.
 *
 * Stubs `window.api` (set BEFORE importing the store, which captures `api` at
 * module load) so we can drive sync/poll/refresh without a real preload bridge.
 *
 * Guarantees under test:
 *   - reset() clears sticky cross-project flags (conflict/accessRevoked/updates)
 *   - a successful sync clears a prior conflict (no stuck "Conflict")
 *   - a conflicting sync raises the conflict flag with the clashing files
 *   - poll() folds the fresh LOCAL ahead/uncommitted snapshot into status.sync
 *   - accessRevoked is sticky: set on refusal, kept through a network blip,
 *     cleared only when the remote is reachable again
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let pendingStatus: any
let pendingSync: any
let pendingPoll: any

const fakeApi = {
  sharingStatus: async () => pendingStatus,
  sharingSync: async () => pendingSync,
  sharingPoll: async () => pendingPoll,
}

;(globalThis as { window?: unknown }).window = { api: fakeApi }

import { useSharingStore } from '../sharing-store.ts'

const store = useSharingStore

beforeEach(() => {
  store.getState().reset()
  pendingStatus = {
    shared: true,
    members: [],
    me: null,
    sync: { ahead: 0, behind: 0, hasUpstream: true, uncommitted: false },
  }
  pendingSync = { ok: true, pushed: true, pulled: false, ahead: 0, behind: 0, conflict: false, conflictedFiles: [] }
  pendingPoll = { updatesAvailable: false, reachable: true }
})

test('reset() clears sticky cross-project flags and status', () => {
  store.setState({
    status: { shared: true, members: [], me: null } as any,
    conflict: { files: ['paper.tex'] },
    accessRevoked: true,
    updatesAvailable: true,
    lastError: 'boom',
  })
  store.getState().reset()
  const s = store.getState()
  assert.equal(s.status, null)
  assert.equal(s.conflict, null)
  assert.equal(s.accessRevoked, false)
  assert.equal(s.updatesAvailable, false)
  assert.equal(s.lastError, null)
})

test('a successful sync clears a prior conflict (no stuck "Conflict")', async () => {
  store.setState({ status: pendingStatus, conflict: { files: ['x.tex'] }, updatesAvailable: true })
  pendingSync = { ok: true, pushed: true, pulled: true, ahead: 0, behind: 0, conflict: false, conflictedFiles: [] }
  await store.getState().sync()
  const s = store.getState()
  assert.equal(s.conflict, null)
  assert.equal(s.updatesAvailable, false)
})

test('a conflicting sync raises the conflict flag with the clashing files', async () => {
  store.setState({ status: pendingStatus })
  pendingSync = { ok: false, pushed: false, pulled: false, ahead: 0, behind: 0, conflict: true, conflictedFiles: ['intro.tex', 'refs.bib'] }
  await store.getState().sync()
  assert.deepEqual(store.getState().conflict, { files: ['intro.tex', 'refs.bib'] })
})

test('poll() folds the fresh local snapshot into status.sync', async () => {
  store.setState({ status: { shared: true, members: [], me: null } as any })
  pendingPoll = { updatesAvailable: false, reachable: true, sync: { ahead: 3, behind: 0, hasUpstream: true, uncommitted: true } }
  await store.getState().poll()
  const sync = store.getState().status?.sync
  assert.equal(sync?.ahead, 3)
  assert.equal(sync?.uncommitted, true)
})

test('poll() is a no-op when the project is not shared', async () => {
  store.setState({ status: { shared: false, members: [], me: null } as any })
  pendingPoll = { updatesAvailable: true, reachable: true }
  await store.getState().poll()
  assert.equal(store.getState().updatesAvailable, false)
})

test('accessRevoked is sticky: refusal sets, network blip keeps, reachable clears', async () => {
  store.setState({ status: { shared: true, members: [], me: null } as any })

  pendingPoll = { updatesAvailable: false, reachable: false, accessRevoked: true }
  await store.getState().poll()
  assert.equal(store.getState().accessRevoked, true, 'real refusal sets it')

  pendingPoll = { updatesAvailable: false, reachable: false }
  await store.getState().poll()
  assert.equal(store.getState().accessRevoked, true, 'a transient network failure must not clear it')

  pendingPoll = { updatesAvailable: false, reachable: true }
  await store.getState().poll()
  assert.equal(store.getState().accessRevoked, false, 'a reachable remote clears it')
})
