import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModalBackend, MODAL_BACKEND_DATA_VERSION } from '../modal-backend.js'
import type { ComputeContext } from '../../../context.js'
import type { ComputeEvent } from '../../../events.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-modal-backend-'))
  mkdirSync(join(dir, '.research-pilot/compute-runs'), { recursive: true })
  return dir
}

function buildContext(opts: {
  projectPath: string
  workspacePath?: string
  tokenId?: string
  tokenSecret?: string
  costThresholdUsd?: number
  events?: ComputeEvent[]
}): ComputeContext {
  const events = opts.events ?? []
  return {
    projectPath: opts.projectPath,
    workspacePath: opts.workspacePath ?? opts.projectPath,
    getCredentials: () => ({ tokenId: opts.tokenId, tokenSecret: opts.tokenSecret }),
    getCostThresholdUsd: () => opts.costThresholdUsd ?? 5,
    emit: e => events.push(e),
    // createSubAgent omitted — these tests don't exercise plan() (which needs an LLM)
  }
}

// ─── identity / capabilities (RFC §7.3) ──────────────────────────────────

test('ModalBackend: identity matches RFC-008 §7.3', () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    assert.equal(backend.identity.id, 'modal')
    assert.equal(backend.identity.toolPrefix, 'modal')
    assert.equal(backend.identity.displayName, 'Modal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModalBackend: capabilities — requiresApproval=true, hasCost=true, supportsGpu=true', () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    assert.equal(backend.capabilities.requiresApproval, true)
    assert.equal(backend.capabilities.hasCost, true)
    assert.equal(backend.capabilities.supportsGpu, true)
    assert.equal(backend.capabilities.supportsStop, true)
    assert.equal(backend.capabilities.supportsStreaming, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── probeAvailability — without modal CLI / without credentials ─────────

test('ModalBackend.probeAvailability: missing credentials → available=false with hint', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    const avail = await backend.probeAvailability()
    // Either the CLI is genuinely missing (most CI runners) or
    // credentials are; either way, available should be false.
    assert.equal(avail.available, false)
    assert.ok(avail.missingRequirements.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModalBackend.probeAvailability: with both creds + CLI → available=true (when modal CLI happens to be installed)', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({
      projectPath: dir,
      tokenId: 'ak-test',
      tokenSecret: 'as-test',
    }))
    const avail = await backend.probeAvailability()
    // Don't assert true — runners without modal CLI installed will
    // still return false even with creds set. Assert the credentials
    // requirement is NOT in the missing list (the CLI requirement
    // may still be).
    assert.ok(!avail.missingRequirements.some(r => r.includes('credentials')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── plan() — without scriptPath should error ───────────────────────────

test('ModalBackend.plan: throws when scriptPath is missing (Modal needs the script)', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    await assert.rejects(
      () => backend.plan({ command: 'modal run foo.py' }),
      /script_path is required/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModalBackend.plan: throws when createSubAgent is unavailable', async () => {
  const dir = tempProject()
  try {
    // Default buildContext omits createSubAgent
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    await assert.rejects(
      () => backend.plan({ command: 'modal run foo.py', scriptPath: '/tmp/foo.py' }),
      /createSubAgent is not available/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── hydrate ─────────────────────────────────────────────────────────────

test('ModalBackend.hydrate: returns empty when no persisted runs', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    const result = await backend.hydrate()
    assert.deepEqual(result, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── getStatus on unknown ────────────────────────────────────────────────

test('ModalBackend.getStatus: returns undefined for unknown runId', () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    assert.equal(backend.getStatus('mr-missing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── destroy is safe ─────────────────────────────────────────────────────

test('ModalBackend.destroy: no-throw with no runs', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    await backend.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── stop on unknown runId is harmless ───────────────────────────────────

test('ModalBackend.stop: no-throw on unknown runId (runner handles gracefully)', async () => {
  const dir = tempProject()
  try {
    const backend = new ModalBackend(buildContext({ projectPath: dir }))
    await backend.stop('mr-unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── data version constant is exposed ────────────────────────────────────

test('ModalBackend: MODAL_BACKEND_DATA_VERSION is exported (renderer guard contract per A5)', () => {
  assert.equal(typeof MODAL_BACKEND_DATA_VERSION, 'number')
  assert.ok(MODAL_BACKEND_DATA_VERSION >= 1)
})
