import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AwsCredentialProvider } from '../credentials.js'

function withEnv<T>(patch: Record<string, string | undefined>, body: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k]
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  try { return body() } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('AwsCredentialProvider: settings take priority over env', () => {
  withEnv({
    AWS_ACCESS_KEY_ID: 'env-key',
    AWS_SECRET_ACCESS_KEY: 'env-secret',
    AWS_REGION: 'eu-west-1',
  }, () => {
    const provider = new AwsCredentialProvider({
      getSettings: () => ({
        accessKeyId: 'settings-key',
        secretAccessKey: 'settings-secret',
        region: 'us-west-2',
      }),
    })
    const r = provider.resolve()
    assert.equal(r.source, 'settings')
    assert.equal(r.credentials.accessKeyId, 'settings-key')
    assert.equal(r.credentials.region, 'us-west-2')
  })
})

test('AwsCredentialProvider: env keys + settings region compose (decoupled sources)', () => {
  // When settings has only a region and env has only keys, the provider
  // composes them. This is the saveApiKey flow: sensitive bits in env,
  // region in plain settings JSON. Settings region wins over env region
  // because the user typed it explicitly.
  withEnv({
    AWS_ACCESS_KEY_ID: 'env-key',
    AWS_SECRET_ACCESS_KEY: 'env-secret',
    AWS_REGION: 'eu-west-1',
  }, () => {
    const provider = new AwsCredentialProvider({
      getSettings: () => ({ region: 'us-west-2' }), // no keys, just region
    })
    const r = provider.resolve()
    assert.equal(r.source, 'env')
    assert.equal(r.credentials.accessKeyId, 'env-key')
    assert.equal(r.credentials.region, 'us-west-2')
  })
})

test('AwsCredentialProvider: env keys + env region work when settings is empty', () => {
  withEnv({
    AWS_ACCESS_KEY_ID: 'env-key',
    AWS_SECRET_ACCESS_KEY: 'env-secret',
    AWS_REGION: 'eu-west-1',
  }, () => {
    const provider = new AwsCredentialProvider({ getSettings: () => ({}) })
    const r = provider.resolve()
    assert.equal(r.source, 'env')
    assert.equal(r.credentials.region, 'eu-west-1')
  })
})

test('AwsCredentialProvider: throws when no source supplies a complete triple', () => {
  withEnv({
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_REGION: undefined,
    AWS_DEFAULT_REGION: undefined,
    AWS_PROFILE: 'this-profile-does-not-exist-9999',
    AWS_SHARED_CREDENTIALS_FILE: '/tmp/research-pilot-aws-creds-does-not-exist',
    AWS_CONFIG_FILE: '/tmp/research-pilot-aws-config-does-not-exist',
  }, () => {
    const provider = new AwsCredentialProvider({ getSettings: () => ({}) })
    assert.throws(() => provider.resolve(), /No AWS credentials available/)
  })
})

test('AwsCredentialProvider: per-call region override beats settings default', () => {
  const provider = new AwsCredentialProvider({
    getSettings: () => ({
      accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1',
    }),
  })
  const r = provider.resolve({ region: 'ap-northeast-1' })
  assert.equal(r.credentials.region, 'ap-northeast-1')
})

test('AwsCredentialProvider: settings region pairs with env keys (saveApiKey flow)', () => {
  // Mirrors the Settings UI flow: user types access/secret into the
  // "AWS credentials" inputs (which go through saveApiKey → process.env)
  // AND types a region into the settings JSON (which lives in
  // compute.backends["aws-ec2"].region). The two sources must compose.
  withEnv({
    AWS_ACCESS_KEY_ID: 'env-key',
    AWS_SECRET_ACCESS_KEY: 'env-secret',
    AWS_REGION: undefined,
    AWS_DEFAULT_REGION: undefined,
  }, () => {
    const provider = new AwsCredentialProvider({
      getSettings: () => ({ region: 'eu-west-2' }), // region only, no keys
    })
    const r = provider.resolve()
    assert.equal(r.source, 'env')
    assert.equal(r.credentials.accessKeyId, 'env-key')
    assert.equal(r.credentials.region, 'eu-west-2')
  })
})
