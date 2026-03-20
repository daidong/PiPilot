/**
 * fetch - HTTP request tool
 * Supports GET, POST, PUT, DELETE and other HTTP methods
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface FetchInput {
  /** Request URL */
  url: string
  /** HTTP method, defaults to GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
  /** Request headers */
  headers?: Record<string, string>
  /** Request body (used for POST/PUT/PATCH) */
  body?: string
  /** Timeout in milliseconds, defaults to 30000 */
  timeout?: number
  /** Whether to return raw response body (skip JSON parsing), defaults to false */
  raw?: boolean
}

export interface FetchOutput {
  /** HTTP status code */
  status: number
  /** HTTP status text */
  statusText: string
  /** Response headers */
  headers: Record<string, string>
  /** Response body (auto-parsed as JSON unless raw=true) */
  body: unknown
  /** Whether the request succeeded (2xx status code) */
  ok: boolean
}

export const fetchTool: Tool<FetchInput, FetchOutput> = defineTool({
  name: 'fetch',
  description: `Send HTTP requests to external APIs. Supports GET/POST/PUT/DELETE. Response auto-parsed as JSON.`,
  parameters: {
    url: {
      type: 'string',
      description: 'Request URL (must be a full URL including protocol)',
      required: true
    },
    method: {
      type: 'string',
      description: 'HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
      required: false,
      default: 'GET',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
    },
    headers: {
      type: 'object',
      description: 'Request headers as key-value pairs',
      required: false
    },
    body: {
      type: 'string',
      description: 'Request body (JSON string or other format)',
      required: false
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds, defaults to 30000',
      required: false,
      default: 30000
    },
    raw: {
      type: 'boolean',
      description: 'Whether to return raw response body (skip JSON parsing)',
      required: false,
      default: false
    }
  },
  activity: {
    formatCall: (a) => {
      const url = (a.url as string) || ''
      try {
        const u = new URL(url)
        return { label: `Fetch: ${u.hostname}`, icon: 'network' }
      } catch {
        return { label: `Fetch: ${url.slice(0, 40)}`, icon: 'network' }
      }
    },
    formatResult: (_r, a) => {
      const url = (a?.url as string) || ''
      try {
        const u = new URL(url)
        return { label: `Fetched ${u.hostname}`, icon: 'network' }
      } catch {
        return { label: 'Fetched URL', icon: 'network' }
      }
    }
  },
  execute: async (input, { runtime }) => {
    const { url, method = 'GET', headers = {}, body, timeout = 30000, raw = false } = input

    // Validate URL
    try {
      new URL(url)
    } catch {
      return {
        success: false,
        error: `Invalid URL: ${url}`
      }
    }

    // Create AbortController for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      // Emit event
      runtime.eventBus.emit('tool:fetch:start', {
        url,
        method,
        headers: Object.keys(headers)
      })

      const response = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'AgentFoundry/1.0',
          ...headers
        },
        body: body !== undefined ? body : undefined,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // Parse response headers
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // Parse response body
      let responseBody: unknown
      const contentType = response.headers.get('content-type') || ''

      if (raw || method === 'HEAD') {
        responseBody = method === 'HEAD' ? null : await response.text()
      } else if (contentType.includes('application/json')) {
        try {
          responseBody = await response.json()
        } catch {
          responseBody = await response.text()
        }
      } else if (contentType.includes('application/xml') || contentType.includes('text/xml')) {
        // Return raw text for XML
        responseBody = await response.text()
      } else {
        // Try to parse as JSON, fall back to text
        const text = await response.text()
        try {
          responseBody = JSON.parse(text)
        } catch {
          responseBody = text
        }
      }

      // Emit event
      runtime.eventBus.emit('tool:fetch:complete', {
        url,
        method,
        status: response.status,
        ok: response.ok
      })

      return {
        success: true,
        data: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          ok: response.ok
        }
      }
    } catch (error) {
      clearTimeout(timeoutId)

      // Emit error event
      runtime.eventBus.emit('tool:fetch:error', {
        url,
        method,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return {
            success: false,
            error: `Request timeout after ${timeout}ms`
          }
        }
        return {
          success: false,
          error: `Fetch failed: ${error.message}`
        }
      }

      return {
        success: false,
        error: 'Unknown fetch error'
      }
    }
  }
})
