import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { createTempDir, cleanupTempDir } from '../test-utils.js'
import { RuntimeIO } from '../../src/core/runtime-io.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { SkillManager } from '../../src/skills/skill-manager.js'
import { SkillRegistry } from '../../src/skills/skill-registry.js'
import { renderExternalSkillMarkdown, parseExternalSkill } from '../../src/skills/skill-file.js'
import { skillCreateTool } from '../../src/tools/skill-create.js'
import { skillApproveTool } from '../../src/tools/skill-approve.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { ToolContext } from '../../src/types/tool.js'

describe('skill-create & skill-approve tools', () => {
  let tempDir: string
  let context: ToolContext

  beforeEach(async () => {
    tempDir = await createTempDir('skill-tools-')
    const eventBus = new EventBus()
    const trace = new TraceCollector('skill-tools-session')
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
      skillManager: new SkillManager({
        trace,
        skillTelemetry: { enabled: false }
      }),
      skillRegistry: new SkillRegistry()
    }

    runtime.sessionState.set('externalSkillsDir', '.agentfoundry/skills')
    runtime.sessionState.set('recentSuccessfulTools', ['read', 'grep'])

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

  it('skill-create writes SKILL.md and registers lazy skill', async () => {
    const result = await skillCreateTool.execute({
      id: 'project-api-auth',
      name: 'Project API Auth',
      shortDescription: 'Auth conventions in this project',
      summary: 'Use bearer auth for all internal APIs.',
      procedures: '1. Retrieve token\n2. Attach Authorization header'
    }, context)

    expect(result.success).toBe(true)
    expect(result.data?.loadingStrategy).toBe('lazy')
    expect(result.data?.tools).toEqual(['read', 'grep'])
    expect(result.data?.skillDir).toBe(path.join('.agentfoundry', 'skills', 'project-api-auth'))

    const filePath = path.join(tempDir, '.agentfoundry', 'skills', 'project-api-auth', 'SKILL.md')
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = parseExternalSkill(content)

    expect(parsed.skill.id).toBe('project-api-auth')
    expect(parsed.approvedByUser).toBe(true)
    expect(parsed.skill.loadingStrategy).toBe('lazy')
    expect(context.runtime.skillManager?.has('project-api-auth')).toBe(true)
  })

  it('skill-approve updates approvedByUser and registers approved skill', async () => {
    const filePath = path.join(tempDir, '.agentfoundry', 'skills', 'manual-skill', 'SKILL.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, renderExternalSkillMarkdown(
      {
        id: 'manual-skill',
        name: 'Manual Skill',
        shortDescription: 'Needs approval',
        loadingStrategy: 'lazy',
        tools: ['read'],
        meta: { approvedByUser: false }
      },
      '# Summary\nManual skill.'
    ), 'utf-8')

    const approveResult = await skillApproveTool.execute({
      id: 'manual-skill',
      setLoadingStrategy: 'lazy'
    }, context)

    expect(approveResult.success).toBe(true)
    expect(approveResult.data?.approvedByUser).toBe(true)

    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = parseExternalSkill(content)
    expect(parsed.approvedByUser).toBe(true)
    expect(context.runtime.skillManager?.isApproved('manual-skill')).toBe(true)
  })
})
