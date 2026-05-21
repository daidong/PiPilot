/**
 * Tests for the `compute_plan` tool's `backend_data` parameter and the
 * `PlanInput.backendData` field it threads through.
 *
 * Why this exists: in RFC-009 Phase 1 v1, the EC2 backend's
 * parsePlanInput required a JSON spec in `scriptContent`, but the
 * compute_plan tool never forwarded scriptContent. Net effect: the
 * EC2 plan path was unreachable through the agent. v2 introduced
 * `backend_data` (JSON string at the tool layer → object at the
 * PlanInput.backendData field) to plumb backend-specific input
 * cleanly. These tests guard that contract so the regression can't
 * recur silently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRegistry } from '../registry.js'
import { createComputeTools } from '../tools.js'
import type { ComputeBackend } from '../backend.js'
import type {
  ComputePlan,
  ComputeRun,
  RunStatus,
  BackendAvailability,
  BackendCapabilities,
  BackendIdentity,
  PlanInput,
  SubmitOpts,
} from '../types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-backend-data-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

/** Minimal capture-only backend so we can assert on what PlanInput reached plan(). */
class CapturingBackend implements ComputeBackend {
  readonly identity: BackendIdentity = { id: 'capture', displayName: 'Capture', toolPrefix: 'capture' }
  readonly capabilities: BackendCapabilities = {
    requiresApproval: false,
    hasCost: false,
    supportsGpu: false,
    supportsStop: true,
    supportsStreaming: false,
  }
  public lastPlanInput: PlanInput | undefined

  async probeAvailability(): Promise<BackendAvailability> {
    return { available: true, missingRequirements: [] }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    this.lastPlanInput = input
    return {
      planId: 'capture-plan-1',
      backend: this.identity.id,
      createdAt: new Date().toISOString(),
      command: input.command,
      taskProfile: {
        cpuDensity: 'low', gpuDensity: 'none', memoryPattern: 'constant',
        ioPattern: 'minimal', chunkable: false, resumable: false,
        idempotent: true, hasExternalSideEffects: false, networkRequired: false,
        expectedDurationClass: 'seconds', reasoning: 'capture',
      },
      backendData: input.backendData ?? null,
      backendDataVersion: 1,
    }
  }

  async submit(_p: ComputePlan, _o: SubmitOpts): Promise<ComputeRun> {
    throw new Error('not used in this test')
  }
  getStatus(_r: string): RunStatus | undefined { return undefined }
  async waitForCompletion(_r: string, _t: number): Promise<RunStatus | undefined> { return undefined }
  async stop(_r: string): Promise<void> { return }
  async destroy(): Promise<void> { return }
  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> { return [] }
}

async function callComputePlan(
  registry: ComputeRegistry,
  workspacePath: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data?: any; error?: string; error_code?: string }> {
  const tools = createComputeTools({ registry, workspacePath })
  const planTool = tools.find((t) => t.name === 'compute_plan')!
  const result = await planTool.execute('call-1', params)
  // tools return AgentToolResult with `details: ToolResult`; assert on that.
  const details = (result as any).details as { success: boolean; data?: any; error?: string; error_code?: string }
  return details
}

test('compute_plan expands ~ in script_path before forwarding to backend', async () => {
  // Regression: a literal `~/foo.sh` was being resolved as
  // `<workspace>/~/foo.sh` by `path.resolve(workspace, '~/foo.sh')`.
  // After centralizing on resolveUserPath, tilde-paths become
  // absolute home-relative paths and bypass workspace-resolution.
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'bash ~/foo.sh',
      script_path: '~/foo.sh',
    })

    assert.equal(result.success, true)
    const observedScriptPath = backend.lastPlanInput?.scriptPath ?? ''
    const expected = join(homedir(), 'foo.sh')
    assert.equal(observedScriptPath, expected,
      `script_path "~/foo.sh" should expand to "${expected}", got "${observedScriptPath}"`)
    assert.ok(!observedScriptPath.includes('~'),
      'expanded script path must not contain literal "~"')
    assert.ok(!observedScriptPath.startsWith(projectPath),
      'expanded script path must not be workspace-relative')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('compute_plan forwards backend_data JSON to PlanInput.backendData', async () => {
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const spec = { instanceSpec: { instanceType: 't3.small' }, taskProfile: { expectedDurationClass: 'minutes' } }
    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'echo hi',
      backend_data: JSON.stringify(spec),
    })

    assert.equal(result.success, true, `compute_plan failed: ${result.error}`)
    assert.deepEqual(backend.lastPlanInput?.backendData, spec, 'backendData was not threaded through to the backend')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('compute_plan omits backendData when backend_data param absent (Local/Modal path)', async () => {
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'echo hi',
    })

    assert.equal(result.success, true)
    assert.equal(backend.lastPlanInput?.backendData, undefined,
      'backendData should be undefined when backend_data param is absent (Local/Modal must keep auto-deriving)')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('compute_plan rejects malformed backend_data JSON with INVALID_PARAMETER', async () => {
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'echo hi',
      backend_data: '{ this is not json',
    })

    assert.equal(result.success, false)
    assert.equal(result.error_code, 'INVALID_PARAMETER')
    assert.match(result.error ?? '', /not valid JSON/i)
    assert.equal(backend.lastPlanInput, undefined,
      'plan() must not be called when backend_data fails to parse')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('compute_plan rejects non-string backend_data with INVALID_PARAMETER', async () => {
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'echo hi',
      backend_data: { not: 'a string' },   // agent must JSON.stringify first
    })

    assert.equal(result.success, false)
    assert.equal(result.error_code, 'INVALID_PARAMETER')
    assert.match(result.error ?? '', /JSON-encoded string/i)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('compute_plan accepts an empty backend_data string as "not provided"', async () => {
  // An agent that always sends backend_data="" (instead of omitting) must
  // not break Local/Modal which don't use the field. Treat empty string
  // as absent — matches how command/script_path handle empty strings.
  const projectPath = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath, forceApproval: false })
    const backend = new CapturingBackend()
    registry.register(backend)

    const result = await callComputePlan(registry, projectPath, {
      backend: 'capture',
      command: 'echo hi',
      backend_data: '   ',  // whitespace-only counts as empty
    })

    assert.equal(result.success, true)
    assert.equal(backend.lastPlanInput?.backendData, undefined)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
