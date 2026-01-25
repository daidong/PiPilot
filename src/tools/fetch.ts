/**
 * fetch - HTTP 请求工具
 * 支持 GET, POST, PUT, DELETE 等 HTTP 方法
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface FetchInput {
  /** 请求 URL */
  url: string
  /** HTTP 方法，默认 GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
  /** 请求头 */
  headers?: Record<string, string>
  /** 请求体（POST/PUT/PATCH 时使用） */
  body?: string
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number
  /** 是否返回原始响应体（不尝试解析 JSON），默认 false */
  raw?: boolean
}

export interface FetchOutput {
  /** HTTP 状态码 */
  status: number
  /** HTTP 状态文本 */
  statusText: string
  /** 响应头 */
  headers: Record<string, string>
  /** 响应体（如果是 JSON 会自动解析，除非 raw=true） */
  body: unknown
  /** 是否成功（2xx 状态码） */
  ok: boolean
}

export const fetchTool: Tool<FetchInput, FetchOutput> = defineTool({
  name: 'fetch',
  description: `发送 HTTP 请求到外部 API。支持 GET, POST, PUT, DELETE 等方法。
响应体会自动尝试解析为 JSON，如果失败则返回原始文本。
注意：此工具用于调用外部 API，不适合访问本地文件。`,
  parameters: {
    url: {
      type: 'string',
      description: '请求 URL（必须是完整的 URL，包含协议）',
      required: true
    },
    method: {
      type: 'string',
      description: 'HTTP 方法：GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
      required: false,
      default: 'GET',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
    },
    headers: {
      type: 'object',
      description: '请求头，键值对形式',
      required: false
    },
    body: {
      type: 'string',
      description: '请求体（JSON 字符串或其他格式）',
      required: false
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒），默认 30000',
      required: false,
      default: 30000
    },
    raw: {
      type: 'boolean',
      description: '是否返回原始响应体（不尝试解析 JSON）',
      required: false,
      default: false
    }
  },
  execute: async (input, { runtime }) => {
    const { url, method = 'GET', headers = {}, body, timeout = 30000, raw = false } = input

    // 验证 URL
    try {
      new URL(url)
    } catch {
      return {
        success: false,
        error: `Invalid URL: ${url}`
      }
    }

    // 创建 AbortController 用于超时控制
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      // 记录事件
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

      // 解析响应头
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // 解析响应体
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
        // XML 返回原始文本
        responseBody = await response.text()
      } else {
        // 尝试解析为 JSON，失败则返回文本
        const text = await response.text()
        try {
          responseBody = JSON.parse(text)
        } catch {
          responseBody = text
        }
      }

      // 记录事件
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

      // 记录错误事件
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
