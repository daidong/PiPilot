/**
 * Tests for isRetryableSshHandshakeError.
 *
 * Why: the SSH handshake retry loop in startSshWorkflow distinguishes
 * "instance is still booting, try again in 10 s" from "this will never
 * succeed, fail fast" purely by inspecting the error object. Getting
 * this classification wrong has user-visible consequences:
 *
 *   • Misclassify as retryable when it's not → user waits 3 minutes
 *     for a "wrong private key" failure to surface.
 *   • Misclassify as fatal when it's transient → user sees the
 *     ECONNREFUSED bug they hit on first green smoke test return.
 *
 * Pure function, no I/O — these tests pin the lookup table.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRetryableSshHandshakeError } from '../ec2-runner.js'

function netError(code: string, message?: string): Error & { code: string } {
  const err = new Error(message ?? `connect ${code} 1.2.3.4:22`) as Error & { code: string }
  err.code = code
  return err
}

test('retryable: ECONNREFUSED (the exact bug we shipped — sshd not yet bound)', () => {
  assert.equal(isRetryableSshHandshakeError(netError('ECONNREFUSED')), true)
})

test('retryable: ETIMEDOUT (network ACL or security-group propagation delay)', () => {
  assert.equal(isRetryableSshHandshakeError(netError('ETIMEDOUT')), true)
})

test('retryable: ECONNRESET (mid-handshake drop, can happen during sshd config reload)', () => {
  assert.equal(isRetryableSshHandshakeError(netError('ECONNRESET')), true)
})

test('retryable: EHOSTUNREACH / ENETUNREACH (transient routing)', () => {
  assert.equal(isRetryableSshHandshakeError(netError('EHOSTUNREACH')), true)
  assert.equal(isRetryableSshHandshakeError(netError('ENETUNREACH')), true)
})

test('retryable: EAI_AGAIN (DNS resolver flaky for ec2-*.compute-1.amazonaws.com)', () => {
  assert.equal(isRetryableSshHandshakeError(netError('EAI_AGAIN')), true)
})

test('retryable: ssh2 readyTimeout — "Timed out while waiting for handshake"', () => {
  // ssh2 surfaces its own timeout without a .code field — we have to
  // match on the message text.
  const err = new Error('Timed out while waiting for handshake')
  assert.equal(isRetryableSshHandshakeError(err), true)
})

test('retryable: error wraps ECONNREFUSED in the message but no .code field', () => {
  // Some wrapping libraries strip .code. Defense-in-depth: the message
  // text alone is enough.
  const err = new Error('Underlying error: connect ECONNREFUSED 98.88.84.240:22')
  assert.equal(isRetryableSshHandshakeError(err), true)
})

test('NOT retryable: auth-publickey-failed (wrong private key — retrying won\'t help)', () => {
  // ssh2 surfaces auth failures with a distinct error class. The .code
  // field is "ENOENT" or similar from key read, OR a string like
  // "All configured authentication methods failed". None match our
  // retryable list.
  const err: any = new Error('All configured authentication methods failed')
  err.level = 'client-authentication'
  assert.equal(isRetryableSshHandshakeError(err), false)
})

test('NOT retryable: host-key-mismatch (would never resolve via retry)', () => {
  const err: any = new Error('Host fingerprint verification failed')
  assert.equal(isRetryableSshHandshakeError(err), false)
})

test('NOT retryable: arbitrary unrelated error', () => {
  assert.equal(isRetryableSshHandshakeError(new Error('something else entirely')), false)
})

test('NOT retryable: null / undefined / non-object inputs (defensive)', () => {
  assert.equal(isRetryableSshHandshakeError(null), false)
  assert.equal(isRetryableSshHandshakeError(undefined), false)
  assert.equal(isRetryableSshHandshakeError('a string'), false)
  assert.equal(isRetryableSshHandshakeError(42), false)
})
