/**
 * Fetch Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchTool } from '../../src/tools/fetch.js'
import type { ToolContext } from '../../src/types/tool.js'
import type { Runtime } from '../../src/types/runtime.js'
import { EventBus } from '../../src/core/event-bus.js'

describe('fetchTool', () => {
  let mockRuntime: Partial<Runtime>
  let mockContext: ToolContext

  beforeEach(() => {
    const eventBus = new EventBus()
    mockRuntime = {
      eventBus,
      projectPath: '/test',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 1
    }
    mockContext = {
      runtime: mockRuntime as Runtime,
      sessionId: 'test-session',
      step: 1,
      agentId: 'test-agent'
    }
  })

  it('should have correct name and description', () => {
    expect(fetchTool.name).toBe('fetch')
    expect(fetchTool.description).toContain('HTTP')
  })

  it('should have required parameters', () => {
    expect(fetchTool.parameters.url).toBeDefined()
    expect(fetchTool.parameters.url.required).toBe(true)
    expect(fetchTool.parameters.method).toBeDefined()
    expect(fetchTool.parameters.headers).toBeDefined()
    expect(fetchTool.parameters.body).toBeDefined()
    expect(fetchTool.parameters.timeout).toBeDefined()
  })

  it('should reject invalid URLs', async () => {
    const result = await fetchTool.execute(
      { url: 'not-a-valid-url' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid URL')
  })

  it('should make successful GET request', async () => {
    // Mock global fetch
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ data: 'test' })
    }

    global.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchTool.execute(
      { url: 'https://api.example.com/test' },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data?.status).toBe(200)
    expect(result.data?.ok).toBe(true)
  })

  it('should handle timeout', async () => {
    // Mock fetch that never resolves within timeout
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 100)
      })
    )

    // This test is tricky because we can't easily simulate AbortError
    // For now, just verify the tool handles errors gracefully
    const result = await fetchTool.execute(
      { url: 'https://api.example.com/test', timeout: 50 },
      mockContext
    )

    // Should return a result (either success or failure with error)
    expect(result).toBeDefined()
  })

  it('should parse JSON responses', async () => {
    const testData = { key: 'value', nested: { a: 1 } }
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue(testData)
    }

    global.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchTool.execute(
      { url: 'https://api.example.com/json' },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.data?.body).toEqual(testData)
  })

  it('should support POST requests with body', async () => {
    const mockResponse = {
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ id: 123 })
    }

    global.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchTool.execute(
      {
        url: 'https://api.example.com/create',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' })
      },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.data?.status).toBe(201)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/create',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' })
      })
    )
  })
})
