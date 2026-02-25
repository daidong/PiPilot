import type { PluginDefinition } from '../types.js'

export function memoryPlugin(): PluginDefinition {
  return {
    manifest: {
      id: 'core.memory',
      version: '1.0.0',
      capabilities: ['memory'],
      permissions: {
        memory: {},
        limits: {
          timeoutMs: 10_000,
          maxConcurrentOps: 8,
          maxMemoryMb: 64
        }
      }
    },
    prompts: [
      'Use memory.get/memory.set for durable key-value memory between turns.'
    ],
    tools: [
      {
        name: 'memory.get',
        description: 'Read a key from persistent memory.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key' }
          },
          required: ['key']
        },
        async execute(args, ctx) {
          const input = args as { key?: string }
          const key = input.key ?? ''
          const value = await ctx.store.getMemory(key)
          return {
            ok: true,
            content: JSON.stringify({ key, value }, null, 2),
            data: value
          }
        }
      },
      {
        name: 'memory.set',
        description: 'Set a key in persistent memory.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key' },
            value: { type: 'object', description: 'Any JSON value' }
          },
          required: ['key', 'value']
        },
        async execute(args, ctx) {
          const input = args as { key?: string; value?: unknown }
          const key = input.key ?? ''
          const value = input.value
          await ctx.store.setMemory(key, value)
          return {
            ok: true,
            content: `memory.set ok: ${key}`
          }
        }
      },
      {
        name: 'memory.list',
        description: 'List memory entries (optional prefix).',
        parameters: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: 'Key prefix' }
          },
          required: []
        },
        async execute(args, ctx) {
          const input = args as { prefix?: string }
          const values = await ctx.store.listMemory(input.prefix)
          return {
            ok: true,
            content: JSON.stringify(values, null, 2),
            data: values
          }
        }
      }
    ]
  }
}
