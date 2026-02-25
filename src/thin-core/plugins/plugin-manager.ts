import type { PluginDefinition, PluginInstallResult, PluginToolResult, ToolRunContext } from '../types.js'

interface PluginManagerActions {
  install: (path: string) => Promise<PluginInstallResult>
  reload: (id: string) => Promise<PluginInstallResult>
  test: (input: { path?: string; id?: string }) => Promise<Record<string, unknown>>
  invoke: (input: { id: string; tool: string; args?: unknown }, ctx: ToolRunContext) => Promise<PluginToolResult>
  list: () => Array<Record<string, unknown>>
}

export function pluginManagerPlugin(actions: PluginManagerActions): PluginDefinition {
  return {
    manifest: {
      id: 'core.plugin-manager',
      version: '1.0.0',
      capabilities: ['memory']
    },
    prompts: [
      'Use plugin.test before plugin.install. plugin.install and plugin.reload take effect in the next turn.'
    ],
    tools: [
      {
        name: 'plugin.test',
        description: 'Run plugin preflight test by path or loaded id.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Plugin folder path' },
            id: { type: 'string', description: 'Loaded plugin id' }
          },
          required: []
        },
        async execute(args) {
          const input = args as { path?: string; id?: string }
          const result = await actions.test(input)
          return {
            ok: true,
            content: JSON.stringify(result, null, 2),
            data: result
          }
        }
      },
      {
        name: 'plugin.install',
        description: 'Install or update plugin from path. Activates next turn.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Plugin folder path' }
          },
          required: ['path']
        },
        async execute(args) {
          const input = args as { path?: string }
          const result = await actions.install(input.path ?? '')
          return {
            ok: true,
            content: JSON.stringify(result, null, 2),
            data: result
          }
        }
      },
      {
        name: 'plugin.reload',
        description: 'Reload an installed dynamic plugin. Activates next turn.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Plugin id' }
          },
          required: ['id']
        },
        async execute(args) {
          const input = args as { id?: string }
          const result = await actions.reload(input.id ?? '')
          return {
            ok: true,
            content: JSON.stringify(result, null, 2),
            data: result
          }
        }
      },
      {
        name: 'plugin.invoke',
        description: 'Invoke a plugin tool directly for smoke verification.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Plugin id' },
            tool: { type: 'string', description: 'Tool name' },
            args: { type: 'object', description: 'Tool arguments' }
          },
          required: ['id', 'tool']
        },
        async execute(args, ctx) {
          const input = args as { id?: string; tool?: string; args?: unknown }
          const result = await actions.invoke({
            id: input.id ?? '',
            tool: input.tool ?? '',
            args: input.args
          }, ctx)

          return {
            ok: result.ok,
            content: result.content,
            isError: result.isError,
            data: result.data
          }
        }
      },
      {
        name: 'plugin.list',
        description: 'List active plugins and pending metadata.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        },
        async execute() {
          const result = actions.list()
          return {
            ok: true,
            content: JSON.stringify(result, null, 2),
            data: result
          }
        }
      }
    ]
  }
}
