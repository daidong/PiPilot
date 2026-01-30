import { describe, it, expect, beforeEach } from 'vitest'
import { createActivityFormatter } from '../../src/trace/activity-formatter.js'
import { read } from '../../src/tools/read.js'
import { write } from '../../src/tools/write.js'
import { edit } from '../../src/tools/edit.js'
import { bash } from '../../src/tools/bash.js'
import { glob } from '../../src/tools/glob.js'
import { grep } from '../../src/tools/grep.js'
import { fetchTool } from '../../src/tools/fetch.js'
import type { Tool } from '../../src/types/tool.js'

/**
 * Minimal mock ToolRegistry that holds a map of tools.
 */
function createMockRegistry(tools: Tool[]): any {
  const map = new Map(tools.map(t => [t.name, t]))
  return { get: (name: string) => map.get(name) }
}

describe('createActivityFormatter', () => {
  describe('with built-in tool activity labels', () => {
    const registry = createMockRegistry([read, write, edit, bash, glob, grep, fetchTool])
    const fmt = createActivityFormatter({ toolRegistry: registry })

    it('formats read call', () => {
      const s = fmt.formatToolCall('read', { path: '/src/foo/bar.ts' })
      expect(s.label).toBe('Read bar.ts')
      expect(s.icon).toBe('file')
    })

    it('formats read result', () => {
      const s = fmt.formatToolResult('read', { success: true, data: { content: 'a\nb\nc', lines: 3 } }, { path: '/x/y.ts' })
      expect(s.label).toContain('y.ts')
      expect(s.label).toContain('3 lines')
    })

    it('formats write call', () => {
      const s = fmt.formatToolCall('write', { path: '/tmp/out.json' })
      expect(s.label).toBe('Write out.json')
    })

    it('formats edit call', () => {
      const s = fmt.formatToolCall('edit', { path: '/src/index.ts' })
      expect(s.label).toBe('Edit index.ts')
      expect(s.icon).toBe('edit')
    })

    it('formats bash call', () => {
      const s = fmt.formatToolCall('bash', { command: 'npm run build' })
      expect(s.label).toContain('Run:')
      expect(s.label).toContain('npm run build')
      expect(s.icon).toBe('run')
    })

    it('formats bash result with output lines', () => {
      const s = fmt.formatToolResult('bash', { success: true, data: { stdout: 'line1\nline2\nline3\n' } }, { command: 'ls -la' })
      expect(s.label).toContain('3 lines')
    })

    it('formats glob call', () => {
      const s = fmt.formatToolCall('glob', { pattern: '**/*.ts' })
      expect(s.label).toBe('Glob **/*.ts')
      expect(s.icon).toBe('search')
    })

    it('formats glob result', () => {
      const s = fmt.formatToolResult('glob', { success: true, data: { files: ['a.ts', 'b.ts'] } }, { pattern: '*.ts' })
      expect(s.label).toContain('2 files')
    })

    it('formats grep call', () => {
      const s = fmt.formatToolCall('grep', { pattern: 'TODO' })
      expect(s.label).toBe('Grep "TODO"')
    })

    it('formats grep result', () => {
      const s = fmt.formatToolResult('grep', { success: true, data: { matches: [1, 2, 3] } }, { pattern: 'TODO' })
      expect(s.label).toContain('3 matches')
    })

    it('formats fetch call with URL', () => {
      const s = fmt.formatToolCall('fetch', { url: 'https://api.example.com/data' })
      expect(s.label).toBe('Fetch: api.example.com')
      expect(s.icon).toBe('network')
    })
  })

  describe('custom rules override', () => {
    const registry = createMockRegistry([read])
    const fmt = createActivityFormatter({
      toolRegistry: registry,
      customRules: [
        {
          match: 'read',
          formatCall: (_tool, args) => ({ label: `Custom read: ${args.path}`, icon: 'file' }),
        },
        {
          match: /^my-/,
          formatCall: (tool) => ({ label: `App: ${tool}`, icon: 'default' }),
        }
      ]
    })

    it('custom rule takes priority over built-in', () => {
      const s = fmt.formatToolCall('read', { path: 'test.ts' })
      expect(s.label).toBe('Custom read: test.ts')
    })

    it('regex rule matches', () => {
      const s = fmt.formatToolCall('my-special-tool', {})
      expect(s.label).toBe('App: my-special-tool')
    })
  })

  describe('lazy registry getter', () => {
    it('resolves registry on each call', () => {
      let registry: any = undefined
      const fmt = createActivityFormatter({
        toolRegistry: () => registry,
      })

      // Before registry is set, falls back to tool name
      expect(fmt.formatToolCall('read', { path: 'a.ts' }).label).toBe('read')

      // After registry is set, uses built-in formatter
      registry = createMockRegistry([read])
      const s = fmt.formatToolCall('read', { path: '/foo/a.ts' })
      expect(s.label).toBe('Read a.ts')
    })
  })

  describe('fallback for unknown tools', () => {
    const fmt = createActivityFormatter()

    it('returns tool name for unknown call', () => {
      const s = fmt.formatToolCall('unknown-tool', {})
      expect(s.label).toBe('unknown-tool')
    })

    it('returns "tool: done" for unknown result', () => {
      const s = fmt.formatToolResult('unknown-tool', { success: true })
      expect(s.label).toBe('unknown-tool: done')
    })
  })

  describe('failed result formatting', () => {
    const registry = createMockRegistry([read])
    const fmt = createActivityFormatter({ toolRegistry: registry })

    it('returns "Failed: error" for failed result', () => {
      const s = fmt.formatToolResult('read', { success: false, error: 'File not found' })
      expect(s.label).toBe('Failed: File not found')
    })

    it('truncates long error messages', () => {
      const longError = 'x'.repeat(100)
      const s = fmt.formatToolResult('read', { success: false, error: longError })
      expect(s.label.length).toBeLessThanOrEqual(60)
    })

    it('failed check happens before custom rules', () => {
      const fmt2 = createActivityFormatter({
        customRules: [{
          match: 'my-tool',
          formatResult: () => ({ label: 'Custom result' })
        }]
      })
      const s = fmt2.formatToolResult('my-tool', { success: false, error: 'boom' })
      expect(s.label).toBe('Failed: boom')
    })
  })
})
