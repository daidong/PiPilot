/**
 * RuntimeIO 测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RuntimeIO } from '../../src/core/runtime-io.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTempDir, cleanupTempDir, normalizePath } from '../test-utils.js'

describe('RuntimeIO', () => {
  let runtimeIO: RuntimeIO
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus
  let tempDir: string

  beforeEach(async () => {
    // 创建临时目录
    tempDir = await createTempDir('runtime-io-test-')

    // 创建测试组件
    eventBus = new EventBus()
    trace = new TraceCollector('test-session')
    policyEngine = new PolicyEngine({ trace, eventBus })

    runtimeIO = new RuntimeIO({
      projectPath: tempDir,
      policyEngine,
      trace,
      eventBus,
      agentId: 'test-agent',
      sessionId: 'test-session',
      getCurrentStep: () => 1
    })
  })

  afterEach(async () => {
    // 清理临时目录
    await cleanupTempDir(tempDir)
  })

  describe('readFile', () => {
    it('should read file successfully', async () => {
      const testFile = path.join(tempDir, 'test.txt')
      await fs.writeFile(testFile, 'Hello, World!')

      const result = await runtimeIO.readFile(testFile)

      expect(result.success).toBe(true)
      expect(result.data).toBe('Hello, World!')
    })

    it('should return error for non-existent file', async () => {
      const result = await runtimeIO.readFile(path.join(tempDir, 'non-existent.txt'))

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should handle policy denial', async () => {
      // 注册阻止策略 - 使用正确的 Policy 结构
      policyEngine.register({
        id: 'block-read',
        phase: 'guard',
        priority: 10,
        match: (ctx) => ctx.tool === 'runtime.io' && ctx.operation === 'readFile',
        decide: async () => ({ action: 'deny', reason: 'Blocked by policy' })
      })

      const testFile = path.join(tempDir, 'test.txt')
      await fs.writeFile(testFile, 'Hello')

      const result = await runtimeIO.readFile(testFile)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Blocked by policy')
    })
  })

  describe('writeFile', () => {
    it('should write file successfully', async () => {
      const testFile = path.join(tempDir, 'output.txt')

      const result = await runtimeIO.writeFile(testFile, 'New content')

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('New content')
    })

    it('should create parent directories', async () => {
      const testFile = path.join(tempDir, 'nested', 'dir', 'file.txt')

      const result = await runtimeIO.writeFile(testFile, 'Nested content')

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('Nested content')
    })
  })

  describe('exec', () => {
    it('should execute command successfully', async () => {
      const result = await runtimeIO.exec('echo "Hello"')

      expect(result.success).toBe(true)
      expect(result.data?.stdout.trim()).toBe('Hello')
      expect(result.data?.exitCode).toBe(0)
    })

    it('should handle command failure', async () => {
      const result = await runtimeIO.exec('exit 1')

      // RuntimeIO.exec returns success: false for non-zero exit codes
      expect(result.success).toBe(false)
      expect(result.data?.exitCode).toBe(1)
    })

    it('should respect timeout', async () => {
      const result = await runtimeIO.exec('sleep 10', { timeout: 100 })

      expect(result.success).toBe(false)
      // Timeout results in the command being killed with non-zero exit
      expect(result.data?.exitCode).not.toBe(0)
    })
  })

  describe('glob', () => {
    it('should find files with pattern', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.ts'), '')
      await fs.writeFile(path.join(tempDir, 'file2.ts'), '')
      await fs.writeFile(path.join(tempDir, 'file3.js'), '')

      const result = await runtimeIO.glob('*.ts', { cwd: tempDir })

      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data).toContain('file1.ts')
      expect(result.data).toContain('file2.ts')
    })

    it('should respect ignore option', async () => {
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(tempDir, `file${i}.ts`), '')
      }
      // Create files to be ignored
      await fs.mkdir(path.join(tempDir, 'ignored'))
      await fs.writeFile(path.join(tempDir, 'ignored', 'skip.ts'), '')

      const result = await runtimeIO.glob('**/*.ts', { cwd: tempDir, ignore: ['**/ignored/**'] })

      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(5) // Should not include the ignored file
    })
  })

  describe('grep', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(tempDir, 'test1.ts'), 'const foo = 1;\nconst bar = 2;')
      await fs.writeFile(path.join(tempDir, 'test2.ts'), 'function foo() {}\nfunction baz() {}')
    })

    it('should find matches with pattern', async () => {
      const result = await runtimeIO.grep('foo', { cwd: tempDir })

      expect(result.success).toBe(true)
      expect(result.data?.length).toBeGreaterThan(0)
    })

    it('should respect type option', async () => {
      await fs.writeFile(path.join(tempDir, 'other.js'), 'const foo = 1;')

      const result = await runtimeIO.grep('foo', { cwd: tempDir, type: 'ts' })

      expect(result.success).toBe(true)
      // 应该只匹配 .ts 文件
      for (const match of result.data ?? []) {
        expect(match.file).toMatch(/\.ts$/)
      }
    })
  })
})
