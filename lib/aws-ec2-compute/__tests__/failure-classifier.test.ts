/**
 * Tests for classifyEc2FailureSuggestions — the function that turns
 * AWS / SSH error strings into actionable agent suggestions.
 *
 * Why: AWS's encoded-authorization-failure messages are opaque
 * (400+ char base64 blob hiding the keyword). Without classification
 * the agent sees a giant error string and can only "try again" or
 * give up. With it, the run's `failure.suggestions` array points
 * straight at the docs section that fixes the problem.
 *
 * These tests pin each branch so a future "let me clean up" pass
 * doesn't accidentally delete the keyword match that makes the
 * encoded-auth-failure case useful.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEc2FailureSuggestions } from '../ec2-runner.js'

function suggestionsContain(suggestions: string[], needle: string): boolean {
  return suggestions.some((s) => s.toLowerCase().includes(needle.toLowerCase()))
}

test('classifier: iam:PassRole error → docs-pointer + managed-policy warning', () => {
  // Exact error string the user hit on their first green smoke-test run.
  const error =
    'Launch failed: You are not authorized to perform this operation. ' +
    'User: arn:aws:iam::248189936221:user/research-copilot is not authorized to perform: ' +
    'iam:PassRole on resource: arn:aws:iam::248189936221:role/research-ec2-s3-writer'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'iam:PassRole'), 'should mention the missing action explicitly')
  assert.ok(suggestionsContain(s, 'docs/spec/aws-setup.md'), 'should point at the setup doc')
  assert.ok(suggestionsContain(s, 'AmazonEC2FullAccess'), 'should warn that managed policies omit PassRole')
})

test('classifier: generic UnauthorizedOperation → recommend decoding the auth-failure message', () => {
  const error = 'UnauthorizedOperation: Encoded authorization failure message: AAAA...'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'decode-authorization-message'), 'should suggest decoding')
})

test('classifier: InvalidAMIID.NotFound → region scoping hint', () => {
  const error = 'InvalidAMIID.NotFound: The image id [ami-deadbeef] does not exist'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'region-scoped'))
  assert.ok(suggestionsContain(s, 'ssm get-parameter'), 'should give the SSM lookup recipe')
})

test('classifier: InvalidKeyPair.NotFound → region-scoping hint', () => {
  const error = 'InvalidKeyPair.NotFound: The key pair "research-key" does not exist'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'region-scoped'))
})

test('classifier: InvalidGroup.NotFound → use id not name + region hint', () => {
  const error = 'InvalidGroup.NotFound: The security group "research-ssh" does not exist'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'security group'))
  assert.ok(suggestionsContain(s, 'region'))
})

test('classifier: invalid instance profile name → account-mismatch hint included', () => {
  const error = 'Invalid IAM Instance Profile name'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'list-instance-profiles'))
  assert.ok(suggestionsContain(s, 'account mismatch'), 'should warn this can be cross-account, not just missing')
})

test('classifier: Permission denied (publickey) → check key path + sshUser', () => {
  const error = 'SSH workflow failed: Permission denied (publickey)'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'privateKeyPath'))
  assert.ok(suggestionsContain(s, 'sshUser'))
  assert.ok(suggestionsContain(s, 'chmod 400'))
})

test('classifier: SSH timeout → security-group source-IP hint', () => {
  const error = 'SSH workflow failed: Error: connect ETIMEDOUT'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'security group'))
  assert.ok(suggestionsContain(s, 'port 22'))
})

test('classifier: InsufficientInstanceCapacity → retry / switch type / region', () => {
  const error = 'InsufficientInstanceCapacity: We currently do not have sufficient g5.xlarge capacity'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'capacity'))
})

test('classifier: vCPU quota → quota-increase pointer', () => {
  const error = 'You have requested more vCPU capacity than your current vCPU quota'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'quota'))
})

test('classifier: unknown error → falls back to generic output-tail advice', () => {
  const error = 'Some completely novel failure mode that has no specific match'
  const s = classifyEc2FailureSuggestions(error)
  assert.ok(suggestionsContain(s, 'output tail'))
  assert.ok(suggestionsContain(s, 's3 cp'))
})

test('classifier: undefined / empty error → generic fallback (no crash)', () => {
  const a = classifyEc2FailureSuggestions(undefined)
  const b = classifyEc2FailureSuggestions('')
  assert.ok(a.length > 0, 'undefined input yields default suggestions')
  assert.ok(b.length > 0, 'empty input yields default suggestions')
})
