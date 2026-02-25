import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { AgentRunOptions, AgentRunResult } from '../types/agent.js'
import type { ThinAgent, ThinCreateAgentOptions, ToolRunContext, StateStore } from './types.js'
import { InMemoryStateStore } from './state-store.js'
import { HookBus } from './hook-bus.js'
import { ToolRunner } from './tool-runner.js'
import { PluginRegistry } from './plugin-registry.js'
import { ThinAgentLoop } from './agent-loop.js'
import { fsPlugin, execPlugin, memoryPlugin, reviewPlugin, pluginManagerPlugin } from './plugins/index.js'

function resolveApiKey(provider: string, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit
  const envKeyMap: Record<string, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY
  }

  const key = envKeyMap[provider]
  if (!key) {
    throw new Error(`Missing API key for provider ${provider}; set env var or pass apiKey`) 
  }

  return key
}

export type CreateAgentOptions = ThinCreateAgentOptions

export function createAgent(options: ThinCreateAgentOptions = {}): ThinAgent {
  const provider = options.provider ?? 'openai'
  const model = options.model ?? 'gpt-5.2'
  const apiKey = resolveApiKey(provider, options.apiKey)
  const projectPath = resolve(options.projectPath ?? process.cwd())

  const agentId = `thin-agent-${randomUUID().slice(0, 8)}`
  const sessionId = `thin-session-${randomUUID().slice(0, 8)}`

  const store: StateStore = options.store ?? new InMemoryStateStore()
  const hookBus = new HookBus()
  const toolRunner = new ToolRunner()
  const plugins = new PluginRegistry({
    projectPath,
    store,
    hookBus,
    toolRunner
  })

  const defaultPlugins = [fsPlugin(), execPlugin(), memoryPlugin(), reviewPlugin()]
  const configuredPlugins = options.plugins ?? defaultPlugins

  let initialized = false

  const ensureInit = async () => {
    if (initialized) return

    for (const plugin of configuredPlugins) {
      await plugins.registerStatic(plugin)
    }

    await plugins.registerStatic(pluginManagerPlugin({
      install: async (path) => plugins.installFromPath(path),
      reload: async (id) => plugins.reload(id),
      test: async (input) => plugins.test(input),
      invoke: async (input, ctx) => plugins.invoke(input, ctx),
      list: () => plugins.listPlugins()
    }))

    initialized = true
  }

  const loop = new ThinAgentLoop({
    deps: {
      projectPath,
      provider,
      model,
      apiKey,
      systemPrompt: options.systemPrompt ?? 'You are a plugin-driven autonomous agent. Use tools and produce direct, practical outputs.',
      maxSteps: Math.max(1, options.maxSteps ?? 24),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      reasoningEffort: options.reasoningEffort,
      onStream: options.onStream,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult
    },
    store,
    hookBus,
    plugins
  })

  let active = true

  const baseToolContext = (step: number): ToolRunContext => ({
    runId: `manual-${randomUUID().slice(0, 6)}`,
    step,
    projectPath,
    store,
    emit: async (type, data) => {
      await hookBus.emit(type, data)
    }
  })

  const agent: ThinAgent = {
    id: agentId,
    runtime: {
      projectPath,
      sessionId,
      agentId,
      step: 0,
      io: {},
      eventBus: {},
      trace: {},
      tokenBudget: {},
      toolRegistry: {},
      policyEngine: {},
      contextManager: {},
      sessionState: {
        get: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        has: () => false
      }
    } as any,

    ensureInit,

    async run(prompt: string, _runOptions?: AgentRunOptions): Promise<AgentRunResult> {
      if (!active) {
        throw new Error('Agent is destroyed')
      }
      await ensureInit()
      return loop.run(prompt)
    },

    stop(): void {
      loop.stop()
    },

    async destroy(): Promise<void> {
      if (!active) return
      active = false
      await loop.destroy()
      await plugins.destroy()
      await store.close?.()
      hookBus.clear()
    },

    async installPlugin(path: string) {
      await ensureInit()
      return plugins.installFromPath(path)
    },

    async reloadPlugin(id: string) {
      await ensureInit()
      return plugins.reload(id)
    },

    async testPlugin(input: { path?: string; id?: string }) {
      await ensureInit()
      return plugins.test(input)
    },

    async invokePlugin(input: { id: string; tool: string; args?: unknown }) {
      await ensureInit()
      return plugins.invoke(input, baseToolContext(0))
    }
  }

  return agent
}
