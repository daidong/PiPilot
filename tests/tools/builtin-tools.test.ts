/**
 * 内置工具测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTempDir, cleanupTempDir, normalizePath } from '../test-utils.js'
import { read } from '../../src/tools/read.js'
import { write } from '../../src/tools/write.js'
import { edit } from '../../src/tools/edit.js'
import { glob } from '../../src/tools/glob.js'
import { grep } from '../../src/tools/grep.js'
import { bash } from '../../src/tools/bash.js'
import type { ToolContext } from '../../src/types/tool.js'
import type { Runtime } from '../../src/types/runtime.js'
import { RuntimeIO } from '../../src/core/runtime-io.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'

describe('Built-in Tools', () => {
  let tempDir: string
  let context: ToolContext
  let runtimeIO: RuntimeIO
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus

  beforeEach(async () => {
    tempDir = await createTempDir('tools-test-')

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

    const mockRuntime: Runtime = {
      projectPath: tempDir,
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 1,
      io: runtimeIO,
      eventBus,
      trace,
      tokenBudget: {} as any,
      toolRegistry: {} as any,
      policyEngine,
      contextManager: {} as any,
      sessionState: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        has: () => false
      }
    }

    context = {
      runtime: mockRuntime,
      abortSignal: new AbortController().signal
    }
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  describe('read', () => {
    it('should read file content', async () => {
      const testFile = path.join(tempDir, 'test.txt')
      await fs.writeFile(testFile, 'Hello, World!')

      const result = await read.execute({ path: testFile }, context)

      expect(result.success).toBe(true)
      expect(result.data?.content).toBe('Hello, World!')
    })

    it('should handle non-existent file', async () => {
      const result = await read.execute({
        path: path.join(tempDir, 'non-existent.txt')
      }, context)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should respect offset and limit', async () => {
      const testFile = path.join(tempDir, 'multiline.txt')
      await fs.writeFile(testFile, 'line1\nline2\nline3\nline4\nline5')

      // offset is 0-based, so offset 2 means skip first 2 lines (line1, line2)
      const result = await read.execute({
        path: testFile,
        offset: 2,
        limit: 2
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('line3')
      expect(result.data?.content).toContain('line4')
    })
  })

  describe('write', () => {
    it('should write file content', async () => {
      const testFile = path.join(tempDir, 'output.txt')

      const result = await write.execute({
        path: testFile,
        content: 'New content'
      }, context)

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('New content')
    })

    it('should create parent directories', async () => {
      const testFile = path.join(tempDir, 'nested', 'dir', 'file.txt')

      const result = await write.execute({
        path: testFile,
        content: 'Nested content'
      }, context)

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('Nested content')
    })
  })

  describe('edit', () => {
    it('should replace text in file', async () => {
      const testFile = path.join(tempDir, 'edit.txt')
      await fs.writeFile(testFile, 'Hello, World!')

      const result = await edit.execute({
        path: testFile,
        old_string: 'World',
        new_string: 'Universe'
      }, context)

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('Hello, Universe!')
    })

    it('should fail when old_string is not found', async () => {
      const testFile = path.join(tempDir, 'edit.txt')
      await fs.writeFile(testFile, 'Hello, World!')

      const result = await edit.execute({
        path: testFile,
        old_string: 'NotFound',
        new_string: 'Something'
      }, context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should handle replace_all option', async () => {
      const testFile = path.join(tempDir, 'edit.txt')
      await fs.writeFile(testFile, 'foo bar foo baz foo')

      const result = await edit.execute({
        path: testFile,
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true
      }, context)

      expect(result.success).toBe(true)

      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('qux bar qux baz qux')
    })
  })

  describe('glob', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(tempDir, 'file1.ts'), '')
      await fs.writeFile(path.join(tempDir, 'file2.ts'), '')
      await fs.writeFile(path.join(tempDir, 'file3.js'), '')
      await fs.mkdir(path.join(tempDir, 'subdir'))
      await fs.writeFile(path.join(tempDir, 'subdir', 'nested.ts'), '')
    })

    it('should find files matching pattern', async () => {
      const result = await glob.execute({
        pattern: '*.ts',
        cwd: tempDir
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.files).toHaveLength(2)
    })

    it('should find files recursively with **', async () => {
      const result = await glob.execute({
        pattern: '**/*.ts',
        cwd: tempDir
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.files).toHaveLength(3)
    })

    it('should respect ignore option', async () => {
      // Create a file in a subdirectory to ignore
      await fs.mkdir(path.join(tempDir, 'ignored'))
      await fs.writeFile(path.join(tempDir, 'ignored', 'skip.ts'), '')

      const result = await glob.execute({
        pattern: '**/*.ts',
        cwd: tempDir,
        ignore: ['**/ignored/**']
      }, context)

      expect(result.success).toBe(true)
      // Should find 3 ts files but not the one in ignored/
      expect(result.data?.files).toHaveLength(3)
    })
  })

  describe('grep', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(tempDir, 'search1.ts'), 'function foo() {}\nconst bar = 1;')
      await fs.writeFile(path.join(tempDir, 'search2.ts'), 'function baz() {}\nconst foo = 2;')
      await fs.writeFile(path.join(tempDir, 'search3.js'), 'const foo = 3;')
    })

    it('should find matches in files', async () => {
      const result = await grep.execute({
        pattern: 'foo',
        cwd: tempDir
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.matches.length).toBeGreaterThan(0)
    })

    it('should respect type filter', async () => {
      const result = await grep.execute({
        pattern: 'foo',
        cwd: tempDir,
        type: 'ts'
      }, context)

      expect(result.success).toBe(true)
      // 只应匹配 .ts 文件
      for (const match of result.data?.matches ?? []) {
        expect(match.file).toMatch(/\.ts$/)
      }
    })

    it('should include context lines', async () => {
      const result = await grep.execute({
        pattern: 'foo',
        cwd: tempDir,
        context: 1
      }, context)

      expect(result.success).toBe(true)
    })
  })

  describe('bash', () => {
    it('should execute command', async () => {
      const result = await bash.execute({
        command: 'echo "Hello, World!"'
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.stdout.trim()).toBe('Hello, World!')
      expect(result.data?.exitCode).toBe(0)
    })

    it('should capture stderr', async () => {
      const result = await bash.execute({
        command: 'echo "Error" >&2'
      }, context)

      expect(result.success).toBe(true)
      expect(result.data?.stderr.trim()).toBe('Error')
    })

    it('should handle command failure', async () => {
      const result = await bash.execute({
        command: 'exit 1'
      }, context)

      expect(result.success).toBe(false) // bash returns failure for non-zero exit code
      expect(result.data?.exitCode).toBe(1)
      expect(result.error).toBe('Command exited with code 1')
    })

    it('should include stderr snippet when command fails with stderr output', async () => {
      const result = await bash.execute({
        command: 'echo "boom" >&2; exit 2'
      }, context)

      expect(result.success).toBe(false)
      expect(result.data?.exitCode).toBe(2)
      expect(result.error).toContain('Command exited with code 2')
      expect(result.error).toContain('boom')
    })

    it('should respect cwd option', async () => {
      const subdir = path.join(tempDir, 'subdir')
      await fs.mkdir(subdir)

      const result = await bash.execute({
        command: 'pwd',
        cwd: subdir
      }, context)

      expect(result.success).toBe(true)
      // pwd 返回的是规范化后的路径，在 macOS 上可能是 /private/var/...
      expect(normalizePath(result.data?.stdout.trim() ?? '')).toBe(normalizePath(subdir))
    })
  })
})
