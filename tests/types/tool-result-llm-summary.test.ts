/**
 * Tests for ToolResult.llmSummary — LLM/UI content separation
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolResult } from '../../src/types/tool.js'

describe('ToolResult.llmSummary', () => {
  it('is optional — existing code with only data still type-checks', () => {
    const r: ToolResult<string[]> = {
      success: true,
      data: ['file1.ts', 'file2.ts']
    }
    expect(r.llmSummary).toBeUndefined()
  })

  it('can carry a compact string alongside rich data', () => {
    const fullDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,5 @@\n ...'
    const r: ToolResult<string> = {
      success: true,
      data: fullDiff,
      llmSummary: 'Changed 3 lines in foo.ts'
    }
    expect(r.llmSummary).toBe('Changed 3 lines in foo.ts')
    expect(r.data).toBe(fullDiff)
  })

  it('works on error results too (unusual but valid)', () => {
    const r: ToolResult = {
      success: false,
      error: 'ENOENT: file not found',
      llmSummary: 'File foo.ts not found'
    }
    expect(r.llmSummary).toBe('File foo.ts not found')
  })
})

describe('agent-loop resultContent selection', () => {
  /**
   * We test the selection logic in isolation — no need to spin up a full loop.
   * The logic being tested is:
   *   resultContent = result.llmSummary ?? (result.data ? JSON.stringify(result.data) : '{"success":true}')
   */
  function buildResultContent(result: ToolResult): string {
    return result.llmSummary
      ?? (result.data !== undefined ? JSON.stringify(result.data, null, 2) : '{"success": true}')
  }

  it('uses llmSummary when present, even if data is also set', () => {
    const result: ToolResult = {
      success: true,
      data: { lines: 100, files: ['a.ts', 'b.ts'] },
      llmSummary: 'Found 100 lines across 2 files'
    }
    expect(buildResultContent(result)).toBe('Found 100 lines across 2 files')
  })

  it('falls back to serialized data when no llmSummary', () => {
    const result: ToolResult = {
      success: true,
      data: { count: 3 }
    }
    expect(buildResultContent(result)).toContain('"count": 3')
  })

  it('falls back to {"success": true} when neither llmSummary nor data', () => {
    const result: ToolResult = { success: true }
    expect(buildResultContent(result)).toBe('{"success": true}')
  })

  it('UI onToolResult callback still receives full result including data', () => {
    // Verify that the callback path receives the rich object, not just the summary
    const captured: ToolResult[] = []
    const onToolResult = (_name: string, result: ToolResult) => { captured.push(result) }

    const result: ToolResult = {
      success: true,
      data: { unified_diff: '--- a\n+++ b\n...', changed_files: 5 },
      llmSummary: '5 files changed'
    }
    onToolResult('edit', result)

    expect(captured[0]?.data).toEqual({ unified_diff: '--- a\n+++ b\n...', changed_files: 5 })
    expect(captured[0]?.llmSummary).toBe('5 files changed')
  })
})
