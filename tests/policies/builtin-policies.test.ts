/**
 * 内置策略测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import {
  noDestructive,
  noSecretFilesRead,
  noSecretFilesWrite,
  autoLimitGrep,
  autoLimitGlob,
  normalizeReadPaths,
  normalizeWritePaths,
  auditAllCalls
} from '../../src/policies/index.js'
import type { PolicyContext } from '../../src/types/policy.js'

describe('Built-in Policies', () => {
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
    trace = new TraceCollector('test-session')
    policyEngine = new PolicyEngine({ trace, eventBus })
  })

  describe('noDestructive', () => {
    beforeEach(() => {
      policyEngine.register(noDestructive)
    })

    it('should block rm -rf', async () => {
      const context: PolicyContext = {
        tool: 'bash',
        input: { command: 'rm -rf /' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('危险命令被阻止')
    })

    it('should block rm -rf with path', async () => {
      const context: PolicyContext = {
        tool: 'bash',
        input: { command: 'rm -rf /home/user/important' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })

    it('should allow non-destructive commands', async () => {
      const context: PolicyContext = {
        tool: 'bash',
        input: { command: 'ls -la' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
    })

    it('should block DROP TABLE', async () => {
      const context: PolicyContext = {
        tool: 'bash',
        input: { command: 'mysql -e "DROP TABLE users"' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })

    it('should block format commands', async () => {
      const context: PolicyContext = {
        tool: 'bash',
        input: { command: 'mkfs.ext4 /dev/sda1' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })
  })

  describe('noSecretFiles', () => {
    beforeEach(() => {
      policyEngine.register(noSecretFilesRead)
      policyEngine.register(noSecretFilesWrite)
    })

    it('should block reading .env files', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/project/.env' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('禁止读取敏感文件')
    })

    it('should block reading .env.local', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/project/.env.local' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })

    it('should block id_rsa', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/home/user/.ssh/id_rsa' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })

    it('should block credentials.json', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/project/credentials.json' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })

    it('should allow reading normal files', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/project/src/index.ts' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
    })

    it('should block writing to secret files', async () => {
      const context: PolicyContext = {
        tool: 'write',
        input: { path: '/project/.env', content: 'SECRET=value' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
    })
  })

  describe('autoLimitGrep', () => {
    beforeEach(() => {
      policyEngine.register(autoLimitGrep)
    })

    it('should add limit to grep without limit', async () => {
      const context: PolicyContext = {
        tool: 'grep',
        input: { pattern: 'foo' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
      expect(result.transforms?.some(t => t.op === 'set' && t.path === 'limit')).toBe(true)
      expect((result.input as any)?.limit).toBe(100)
    })

    it('should not modify grep with existing limit', async () => {
      const context: PolicyContext = {
        tool: 'grep',
        input: { pattern: 'foo', limit: 50 },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
      // Original limit preserved
      expect((result.input as any)?.limit).toBe(50)
    })
  })

  describe('autoLimitGlob', () => {
    beforeEach(() => {
      policyEngine.register(autoLimitGlob)
    })

    it('should add ignore patterns to glob', async () => {
      const context: PolicyContext = {
        tool: 'glob',
        input: { pattern: '**/*.ts' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
      expect((result.input as any)?.ignore).toBeDefined()
      expect((result.input as any)?.ignore).toContain('**/node_modules/**')
    })
  })

  describe('normalizePaths', () => {
    beforeEach(() => {
      policyEngine.register(normalizeReadPaths)
      policyEngine.register(normalizeWritePaths)
    })

    it('should normalize paths in write', async () => {
      const context: PolicyContext = {
        tool: 'write',
        input: { path: '/project/foo/../bar/file.ts', content: '' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
      expect((result.input as any)?.path).toBe('/project/bar/file.ts')
    })
  })

  describe('auditAll', () => {
    beforeEach(() => {
      policyEngine.register(auditAllCalls)
    })

    it('should record all tool calls in trace', async () => {
      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      await policyEngine.evaluateAfter(context)

      // Observe phase records to trace
      const events = trace.getEvents()
      expect(events.length).toBeGreaterThan(0)
    })

    it('should allow all operations (observe phase is after execution)', async () => {
      const tools = ['read', 'write', 'bash', 'glob', 'grep']

      for (const tool of tools) {
        const context: PolicyContext = {
          tool,
          input: {},
          agentId: 'test-agent',
          sessionId: 'test-session',
          step: 1
        }

        // evaluateBefore should allow (auditAll is observe phase only)
        const result = await policyEngine.evaluateBefore(context)
        expect(result.allowed).toBe(true)
      }
    })
  })

  describe('policy combinations', () => {
    it('should apply multiple policies correctly', async () => {
      policyEngine.registerAll([
        noDestructive,
        noSecretFilesRead,
        noSecretFilesWrite,
        normalizeReadPaths,
        normalizeWritePaths,
        auditAllCalls
      ])

      // 应该被 noSecretFiles 阻止
      const secretContext: PolicyContext = {
        tool: 'read',
        input: { path: '/project/.env' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const secretResult = await policyEngine.evaluateBefore(secretContext)
      expect(secretResult.allowed).toBe(false)

      // 应该被 noDestructive 阻止
      const destructiveContext: PolicyContext = {
        tool: 'bash',
        input: { command: 'rm -rf /' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const destructiveResult = await policyEngine.evaluateBefore(destructiveContext)
      expect(destructiveResult.allowed).toBe(false)

      // 正常操作应该被允许
      const normalContext: PolicyContext = {
        tool: 'read',
        input: { path: '/project/src/index.ts' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const normalResult = await policyEngine.evaluateBefore(normalContext)
      expect(normalResult.allowed).toBe(true)
    })
  })
})
