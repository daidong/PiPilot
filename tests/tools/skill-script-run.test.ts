import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { createTempDir, cleanupTempDir } from '../test-utils.js'
import { RuntimeIO } from '../../src/core/runtime-io.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { SkillManager } from '../../src/skills/skill-manager.js'
import { defineSkill } from '../../src/skills/define-skill.js'
import { skillScriptRunTool } from '../../src/tools/skill-script-run.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { ToolContext } from '../../src/types/tool.js'

function defineScriptSkill(skillId: string, scriptPath: string) {
  return defineSkill({
    id: skillId,
    name: `Skill ${skillId}`,
    shortDescription: 'Runs quick local checks',
    instructions: {
      summary: 'Run audit script when requested.'
    },
    tools: ['skill-script-run'],
    meta: {
      scripts: [{
        name: 'audit',
        fileName: 'audit.sh',
        filePath: scriptPath,
        relativePath: 'scripts/audit.sh',
        runner: 'bash'
      }]
    }
  })
}

describe('skill-script-run tool', () => {
  let tempDir: string
  let context: ToolContext

  beforeEach(async () => {
    tempDir = await createTempDir('skill-script-run-')
    const eventBus = new EventBus()
    const trace = new TraceCollector('skill-script-run-session')
    const policyEngine = new PolicyEngine({ trace, eventBus })
    const runtimeIO = new RuntimeIO({
      projectPath: tempDir,
      policyEngine,
      trace,
      eventBus,
      agentId: 'agent-test',
      sessionId: 'session-test',
      getCurrentStep: () => 1
    })

    const sessionMap = new Map<string, unknown>()
    const skillManager = new SkillManager({
      trace,
      skillTelemetry: { enabled: false }
    })

    const runtime: Runtime = {
      projectPath: tempDir,
      sessionId: 'session-test',
      agentId: 'agent-test',
      step: 1,
      io: runtimeIO,
      eventBus,
      trace,
      tokenBudget: {} as any,
      toolRegistry: {} as any,
      policyEngine,
      contextManager: {} as any,
      sessionState: {
        get: <T>(key: string) => sessionMap.get(key) as T | undefined,
        set: <T>(key: string, value: T) => { sessionMap.set(key, value) },
        delete: (key: string) => { sessionMap.delete(key) },
        has: (key: string) => sessionMap.has(key)
      },
      skillManager
    }

    const scriptPath = path.join(tempDir, '.agentfoundry', 'skills', 'quick-audit', 'scripts', 'audit.sh')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(scriptPath, 'echo "audit:$1"\n', 'utf-8')

    skillManager.register(defineScriptSkill('quick-audit', scriptPath))

    context = {
      runtime,
      sessionId: runtime.sessionId,
      step: runtime.step,
      agentId: runtime.agentId
    }
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  it('runs script by basename', async () => {
    expect(context.runtime.skillManager?.getState('quick-audit')).toBe('summary-loaded')

    const result = await skillScriptRunTool.execute({
      skillId: 'quick-audit',
      script: 'audit',
      args: ['ok']
    }, context)

    expect(result.success).toBe(true)
    expect(result.data?.exitCode).toBe(0)
    expect(result.data?.stdout.trim()).toBe('audit:ok')
    expect(context.runtime.skillManager?.getState('quick-audit')).toBe('fully-loaded')
  })

  it('injects AF_* runtime anchor env vars for skill scripts', async () => {
    context.runtime.sessionState.set('yolo.workspaceRoot', tempDir)
    context.runtime.sessionState.set('yolo.turnId', 'turn-0042')
    context.runtime.sessionState.set('yolo.turnArtifactsDir', 'runs/turn-0042/artifacts')
    context.runtime.sessionState.set('yolo.turnArtifactsAbsDir', `${tempDir}/runs/turn-0042/artifacts`)

    const scriptPath = path.join(tempDir, '.agentfoundry', 'skills', 'env-check', 'scripts', 'audit.sh')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(
      scriptPath,
      [
        'echo "AF_WORKSPACE_ROOT=$AF_WORKSPACE_ROOT"',
        'echo "AF_TURN_ID=$AF_TURN_ID"',
        'echo "AF_TURN_ARTIFACTS_REL=$AF_TURN_ARTIFACTS_REL"',
        'echo "AF_TURN_ARTIFACTS_ABS=$AF_TURN_ARTIFACTS_ABS"'
      ].join('\n'),
      'utf-8'
    )
    context.runtime.skillManager?.register(defineScriptSkill('env-check', scriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'env-check',
      script: 'audit',
      args: []
    }, context)

    expect(result.success).toBe(true)
    const stdout = result.data?.stdout || ''
    expect(stdout).toContain(`AF_WORKSPACE_ROOT=${tempDir}`)
    expect(stdout).toContain('AF_TURN_ID=turn-0042')
    expect(stdout).toContain('AF_TURN_ARTIFACTS_REL=runs/turn-0042/artifacts')
    expect(stdout).toContain(`AF_TURN_ARTIFACTS_ABS=${tempDir}/runs/turn-0042/artifacts`)
  })

  it('prefers app.asar.unpacked script path when available', async () => {
    const asarScriptPath = path.join(
      tempDir,
      'release',
      'app.asar',
      'dist',
      'skills',
      'community-builtin',
      'mock',
      'scripts',
      'audit.sh'
    )
    const unpackedScriptPath = asarScriptPath.replace('.asar', '.asar.unpacked')
    await fs.mkdir(path.dirname(unpackedScriptPath), { recursive: true })
    await fs.writeFile(unpackedScriptPath, 'echo "unpacked:$1"\n', 'utf-8')

    context.runtime.skillManager?.register(defineScriptSkill('asar-unpacked', asarScriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'asar-unpacked',
      script: 'audit',
      args: ['ok']
    }, context)

    expect(result.success).toBe(true)
    expect(result.data?.stdout.trim()).toBe('unpacked:ok')
    expect(result.data?.command).toContain('.asar.unpacked')
  })

  it('materializes app.asar scripts to temp cache when unpacked path is unavailable', async () => {
    const asarScriptPath = path.join(
      tempDir,
      'release',
      'app.asar',
      'dist',
      'skills',
      'community-builtin',
      'mock',
      'scripts',
      'audit.sh'
    )
    await fs.mkdir(path.dirname(asarScriptPath), { recursive: true })
    await fs.writeFile(asarScriptPath, 'echo "materialized:$1"\n', 'utf-8')

    context.runtime.skillManager?.register(defineScriptSkill('asar-materialized', asarScriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'asar-materialized',
      script: 'audit',
      args: ['ok']
    }, context)

    expect(result.success).toBe(true)
    expect(result.data?.stdout.trim()).toBe('materialized:ok')
    expect(result.data?.command).toContain('skill-scripts')
    expect(result.data?.command).not.toContain('app.asar/dist/skills')
  })

  it('extracts AF_RESULT_JSON payload into structuredResult', async () => {
    const scriptPath = path.join(tempDir, '.agentfoundry', 'skills', 'structured', 'scripts', 'audit.sh')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(
      scriptPath,
      [
        'echo "provider: codex"',
        'echo "AF_RESULT_JSON: {\\"schema\\":\\"coding-large-repo.result.v1\\",\\"script\\":\\"delegate-coding-agent\\",\\"provider\\":\\"codex\\",\\"status\\":\\"completed\\",\\"exit_code\\":0}"'
      ].join('\n'),
      'utf-8'
    )

    context.runtime.skillManager?.register(defineScriptSkill('structured', scriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'structured',
      script: 'audit',
      args: []
    }, context)

    expect(result.success).toBe(true)
    expect(result.data?.structuredResult).toBeDefined()
    expect(result.data?.structuredResult?.schema).toBe('coding-large-repo.result.v1')
    expect(result.data?.structuredResult?.provider).toBe('codex')
    expect(result.data?.structuredResult?.status).toBe('completed')
  })

  it('extracts AF_RESULT_JSON payload on non-zero exits for machine-readable failures', async () => {
    const scriptPath = path.join(tempDir, '.agentfoundry', 'skills', 'structured-failure', 'scripts', 'audit.sh')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(
      scriptPath,
      [
        'echo "error: blocked"',
        'echo "AF_RESULT_JSON: {\\"schema\\":\\"coding-large-repo.result.v1\\",\\"script\\":\\"verify-targets\\",\\"status\\":\\"error\\",\\"exit_code\\":2,\\"error\\":\\"blocked\\"}"',
        'exit 2'
      ].join('\n'),
      'utf-8'
    )

    context.runtime.skillManager?.register(defineScriptSkill('structured-failure', scriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'structured-failure',
      script: 'audit',
      args: []
    }, context)

    expect(result.success).toBe(false)
    expect(result.data?.exitCode).toBe(2)
    expect(result.data?.structuredResult).toBeDefined()
    expect(result.data?.structuredResult?.script).toBe('verify-targets')
    expect(result.data?.structuredResult?.status).toBe('error')
  })

  it('extracts AF_RESULT_JSON payload from stderr when stdout lacks marker', async () => {
    const scriptPath = path.join(tempDir, '.agentfoundry', 'skills', 'structured-stderr', 'scripts', 'audit.sh')
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(
      scriptPath,
      [
        'echo "error: provider unavailable" >&2',
        'echo "AF_RESULT_JSON: {\\"schema\\":\\"coding-large-repo.result.v1\\",\\"script\\":\\"delegate-coding-agent\\",\\"status\\":\\"error\\",\\"exit_code\\":143,\\"error\\":\\"signal_terminated\\"}" >&2',
        'exit 143'
      ].join('\n'),
      'utf-8'
    )

    context.runtime.skillManager?.register(defineScriptSkill('structured-stderr', scriptPath))

    const result = await skillScriptRunTool.execute({
      skillId: 'structured-stderr',
      script: 'audit',
      args: []
    }, context)

    expect(result.success).toBe(false)
    expect(result.data?.exitCode).toBe(143)
    expect(result.data?.structuredResult).toBeDefined()
    expect(result.data?.structuredResult?.script).toBe('delegate-coding-agent')
    expect(result.data?.structuredResult?.status).toBe('error')
  })
})
