import type { PluginToolDefinition, PluginToolResult, ToolRunContext } from './types.js'

interface ToolRunnerOptions {
  defaultTimeoutMs?: number
  defaultRetries?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateType(expected: unknown, value: unknown): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return isObject(value)
    default: return true
  }
}

function validateArgs(schema: PluginToolDefinition['parameters'], args: unknown): string | undefined {
  if (!isObject(args)) {
    if (Object.keys(schema.properties).length === 0) return undefined
    return 'Tool arguments must be an object'
  }

  const required = schema.required ?? []
  for (const key of required) {
    if (!(key in args)) {
      return `Missing required argument: ${key}`
    }
  }

  for (const [key, descriptor] of Object.entries(schema.properties)) {
    if (!(key in args)) continue
    const typeName = isObject(descriptor) ? descriptor.type : undefined
    if (!validateType(typeName, args[key])) {
      return `Invalid type for argument ${key}; expected ${String(typeName)}`
    }
  }

  return undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${ms}ms`))
    }, ms)

    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(err => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

export class ToolRunner {
  private readonly defaultTimeoutMs: number
  private readonly defaultRetries: number

  constructor(options?: ToolRunnerOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 20_000
    this.defaultRetries = options?.defaultRetries ?? 0
  }

  async run(tool: PluginToolDefinition, args: unknown, ctx: ToolRunContext): Promise<PluginToolResult> {
    const error = validateArgs(tool.parameters, args)
    if (error) {
      return { ok: false, content: error, isError: true }
    }

    const retries = Math.max(0, tool.retries ?? this.defaultRetries)
    const timeoutMs = Math.max(1, tool.timeoutMs ?? this.defaultTimeoutMs)

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await withTimeout(tool.execute(args, ctx), timeoutMs)
        return result
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }

    return {
      ok: false,
      content: lastError?.message ?? 'Tool execution failed',
      isError: true
    }
  }
}
