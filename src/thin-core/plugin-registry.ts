import type {
  PluginDefinition,
  PluginDescriptor,
  PluginInstallResult,
  PluginLifecycleContext,
  PluginToolDefinition,
  PluginToolResult,
  ToolRunContext,
  GuardDecision,
  ContextFragment,
  StateStore,
  HookEvent,
  DynamicPluginHandle
} from './types.js'
import { createEvent } from './state-store.js'
import { PluginLoader } from './plugin-loader.js'
import { HookBus } from './hook-bus.js'
import { ToolRunner } from './tool-runner.js'

interface RegistryConfig {
  projectPath: string
  store: StateStore
  hookBus: HookBus
  toolRunner: ToolRunner
}

type StaticPluginRuntime = {
  kind: 'static'
  definition: PluginDefinition
  descriptor: PluginDescriptor
}

type DynamicPluginRuntime = {
  kind: 'dynamic'
  descriptor: PluginDescriptor
  handle: DynamicPluginHandle
  sourcePath: string
  version: string
  hash: string
}

type PluginRuntime = StaticPluginRuntime | DynamicPluginRuntime

interface ToolBinding {
  pluginId: string
  tool: PluginToolDefinition
  run: (args: unknown, ctx: ToolRunContext) => Promise<PluginToolResult>
}

function cloneMessages<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createLifecycleContext(projectPath: string, store: StateStore, hookBus: HookBus): PluginLifecycleContext {
  return {
    projectPath,
    store,
    emit: async (type, data) => {
      const event = createEvent(type, 'plugin.lifecycle', data)
      await store.append(event)
      await hookBus.emit(type, data)
    }
  }
}

function staticDescriptor(definition: PluginDefinition): PluginDescriptor {
  return {
    manifest: definition.manifest,
    prompts: definition.prompts ?? [],
    tools: (definition.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      timeoutMs: tool.timeoutMs,
      retries: tool.retries
    })),
    hasGuards: (definition.guards?.length ?? 0) > 0,
    contexts: (definition.context ?? []).map(ctx => ctx.id),
    routes: definition.routes ?? [],
    ui: definition.ui ?? []
  }
}

export class PluginRegistry {
  private readonly projectPath: string
  private readonly store: StateStore
  private readonly hookBus: HookBus
  private readonly toolRunner: ToolRunner
  private readonly loader: PluginLoader

  private active = new Map<string, PluginRuntime>()
  private pending = new Map<string, DynamicPluginRuntime>()
  private toolIndex = new Map<string, ToolBinding>()

  constructor(config: RegistryConfig) {
    this.projectPath = config.projectPath
    this.store = config.store
    this.hookBus = config.hookBus
    this.toolRunner = config.toolRunner
    this.loader = new PluginLoader({
      projectPath: this.projectPath,
      store: this.store
    })
  }

  private lifecycleContext(): PluginLifecycleContext {
    return createLifecycleContext(this.projectPath, this.store, this.hookBus)
  }

  private async audit(action: string, data?: Record<string, unknown>): Promise<void> {
    await this.store.append(createEvent('plugin.audit', 'plugin.registry', { action, ...data }))
  }

  private rebuildToolIndex(): void {
    this.toolIndex.clear()

    for (const [pluginId, runtime] of this.active.entries()) {
      if (runtime.kind === 'static') {
        for (const tool of runtime.definition.tools ?? []) {
          this.toolIndex.set(tool.name, {
            pluginId,
            tool,
            run: (args, ctx) => this.toolRunner.run(tool, args, ctx)
          })
        }
        continue
      }

      for (const tool of runtime.descriptor.tools) {
        const descriptorTool: PluginToolDefinition = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          timeoutMs: tool.timeoutMs,
          retries: tool.retries,
          execute: (args, ctx) => runtime.handle.runTool(tool.name, args, ctx)
        }

        this.toolIndex.set(tool.name, {
          pluginId,
          tool: descriptorTool,
          run: (args, ctx) => this.toolRunner.run(descriptorTool, args, ctx)
        })
      }
    }
  }

  async registerStatic(definition: PluginDefinition): Promise<void> {
    const id = definition.manifest.id
    if (!id) throw new Error('Plugin manifest.id is required')

    const runtime: StaticPluginRuntime = {
      kind: 'static',
      definition,
      descriptor: staticDescriptor(definition)
    }

    this.active.set(id, runtime)

    if (definition.hooks?.onInit) {
      await definition.hooks.onInit(this.lifecycleContext())
    }

    await this.audit('register_static', {
      pluginId: id,
      version: definition.manifest.version
    })

    this.rebuildToolIndex()
  }

  async activatePending(): Promise<void> {
    if (this.pending.size === 0) return

    for (const [id, candidate] of this.pending.entries()) {
      const previous = this.active.get(id)

      try {
        await candidate.handle.runHook('onInit', {
          projectPath: this.projectPath
        })

        this.active.set(id, candidate)
        this.pending.delete(id)

        if (previous?.kind === 'dynamic') {
          await previous.handle.dispose()
        }

        await this.audit('activate_dynamic', {
          pluginId: id,
          version: candidate.version,
          hash: candidate.hash
        })
      } catch (err) {
        await candidate.handle.dispose()
        this.pending.delete(id)

        await this.audit('activate_failed', {
          pluginId: id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    this.rebuildToolIndex()
  }

  async installFromPath(path: string): Promise<PluginInstallResult> {
    const loaded = await this.loader.loadPath(path)
    const runtime: DynamicPluginRuntime = {
      kind: 'dynamic',
      descriptor: loaded.descriptor,
      handle: loaded.handle,
      sourcePath: loaded.sourcePath,
      version: loaded.version,
      hash: loaded.hash
    }

    const previousPending = this.pending.get(loaded.id)
    if (previousPending) {
      await previousPending.handle.dispose()
    }

    this.pending.set(loaded.id, runtime)

    await this.audit('install_pending', {
      pluginId: loaded.id,
      version: loaded.version,
      sourcePath: loaded.sourcePath,
      hash: loaded.hash
    })

    return {
      id: loaded.id,
      version: loaded.version,
      status: 'pending_activation',
      toolCount: loaded.descriptor.tools.length
    }
  }

  async reload(id: string): Promise<PluginInstallResult> {
    const active = this.active.get(id)
    const pending = this.pending.get(id)

    let sourcePath: string | undefined
    if (pending?.kind === 'dynamic') {
      sourcePath = pending.sourcePath
    } else if (active?.kind === 'dynamic') {
      sourcePath = active.sourcePath
    }

    if (!sourcePath) {
      throw new Error(`Plugin ${id} is not dynamic or has no sourcePath`)
    }

    return this.installFromPath(sourcePath)
  }

  async test(input: { path?: string; id?: string }): Promise<Record<string, unknown>> {
    if (input.path) {
      return this.loader.runPreflight(input.path)
    }

    if (!input.id) {
      throw new Error('plugin.test requires path or id')
    }

    const active = this.active.get(input.id)
    if (!active) {
      throw new Error(`Plugin not found: ${input.id}`)
    }

    if (active.kind === 'dynamic') {
      await active.handle.runHook('onEvent', {
        type: 'plugin.test',
        data: { ts: Date.now() }
      } as HookEvent)
    }

    return {
      ok: true,
      id: input.id,
      dynamic: active.kind === 'dynamic',
      tools: active.descriptor.tools.map(tool => tool.name)
    }
  }

  async invoke(input: { id: string; tool: string; args?: unknown }, ctx: ToolRunContext): Promise<PluginToolResult> {
    const runtime = this.active.get(input.id)
    if (!runtime) {
      throw new Error(`Plugin not found: ${input.id}`)
    }

    if (runtime.kind === 'dynamic') {
      return runtime.handle.runTool(input.tool, input.args ?? {}, ctx)
    }

    const tool = (runtime.definition.tools ?? []).find(item => item.name === input.tool)
    if (!tool) {
      throw new Error(`Tool not found: ${input.tool}`)
    }

    return this.toolRunner.run(tool, input.args ?? {}, ctx)
  }

  getToolSchemas() {
    return [...this.toolIndex.values()].map(binding => ({
      name: binding.tool.name,
      description: binding.tool.description,
      parameters: binding.tool.parameters
    }))
  }

  getPromptFragments(): string[] {
    const all: string[] = []
    for (const runtime of this.active.values()) {
      all.push(...runtime.descriptor.prompts)
    }
    return all
  }

  getRoutes() {
    return [...this.active.values()].flatMap(runtime => runtime.descriptor.routes)
  }

  getUIBindings() {
    return [...this.active.values()].flatMap(runtime => runtime.descriptor.ui)
  }

  async collectContext(prompt: string, messages: any[]): Promise<ContextFragment[]> {
    const out: ContextFragment[] = []

    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        const providers = runtime.definition.context ?? []
        for (const provider of providers) {
          const item = await provider.provide({
            prompt,
            messages: cloneMessages(messages),
            store: this.store
          })
          if (item) out.push(item)
        }
      } else {
        const items = await runtime.handle.runContext(prompt, cloneMessages(messages))
        out.push(...items)
      }
    }

    return out
  }

  async applyBeforeModel(input: {
    prompt: string
    messages: any[]
    systemPrompt: string
    tools: any[]
  }): Promise<{
    prompt: string
    messages: any[]
    systemPrompt: string
    tools: any[]
  }> {
    const merged = {
      ...input,
      messages: cloneMessages(input.messages)
    }

    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        const out = await runtime.definition.hooks?.beforeModel?.(merged, this.lifecycleContext())
        if (out?.systemPrompt) merged.systemPrompt = out.systemPrompt
        if (out?.messages) merged.messages = out.messages
      } else {
        const out = await runtime.handle.runHook<typeof merged, any>('beforeModel', merged)
        if (out && typeof out === 'object') {
          if (typeof out.systemPrompt === 'string') merged.systemPrompt = out.systemPrompt
          if (Array.isArray(out.messages)) merged.messages = out.messages
        }
      }
    }

    return merged
  }

  async applyAfterModel(input: {
    prompt: string
    assistant: any
    usage: any
  }): Promise<void> {
    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        await runtime.definition.hooks?.afterModel?.(input, this.lifecycleContext())
      } else {
        await runtime.handle.runHook('afterModel', input)
      }
    }
  }

  async runGuards(toolName: string, args: unknown, context: ToolRunContext): Promise<GuardDecision> {
    let transformedArgs = args

    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        const guards = runtime.definition.guards ?? []
        for (const guard of guards) {
          const out = await guard({ toolName, args: transformedArgs, context })
          if (out?.allow === false) {
            return { allow: false, reason: out.reason }
          }
          if (out?.transformedArgs !== undefined) {
            transformedArgs = out.transformedArgs
          }
        }
      } else {
        const out = await runtime.handle.runGuard(toolName, transformedArgs, context)
        if (out?.allow === false) {
          return { allow: false, reason: out.reason }
        }
        if (out?.transformedArgs !== undefined) {
          transformedArgs = out.transformedArgs
        }
      }
    }

    return { allow: true, transformedArgs }
  }

  async applyBeforeTool(toolName: string, args: unknown): Promise<unknown> {
    let currentArgs = args

    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        const out = await runtime.definition.hooks?.beforeTool?.({ toolName, args: currentArgs }, this.lifecycleContext())
        if (out?.args !== undefined) currentArgs = out.args
      } else {
        const out = await runtime.handle.runHook('beforeTool', { toolName, args: currentArgs })
        if (out && typeof out === 'object' && 'args' in out) {
          currentArgs = (out as { args?: unknown }).args ?? currentArgs
        }
      }
    }

    return currentArgs
  }

  async applyAfterTool(toolName: string, args: unknown, result: PluginToolResult): Promise<void> {
    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        await runtime.definition.hooks?.afterTool?.({ toolName, args, result }, this.lifecycleContext())
      } else {
        await runtime.handle.runHook('afterTool', { toolName, args, result })
      }
    }
  }

  async executeTool(toolName: string, args: unknown, ctx: ToolRunContext): Promise<PluginToolResult> {
    const binding = this.toolIndex.get(toolName)
    if (!binding) {
      return {
        ok: false,
        content: `Tool not found: ${toolName}`,
        isError: true
      }
    }

    const guard = await this.runGuards(toolName, args, ctx)
    if (!guard.allow) {
      return {
        ok: false,
        content: guard.reason ?? `Guard denied tool call: ${toolName}`,
        isError: true
      }
    }

    const mutatedArgs = await this.applyBeforeTool(toolName, guard.transformedArgs ?? args)
    const result = await binding.run(mutatedArgs, ctx)
    await this.applyAfterTool(toolName, mutatedArgs, result)

    await this.audit('tool_executed', {
      pluginId: binding.pluginId,
      toolName,
      ok: result.ok
    })

    return result
  }

  async broadcast(event: HookEvent): Promise<void> {
    for (const runtime of this.active.values()) {
      if (runtime.kind === 'static') {
        await runtime.definition.hooks?.onEvent?.(event, this.lifecycleContext())
      } else {
        await runtime.handle.runHook('onEvent', event)
      }
    }
  }

  listPlugins() {
    return [...this.active.entries()].map(([id, runtime]) => ({
      id,
      version: runtime.descriptor.manifest.version,
      kind: runtime.kind,
      tools: runtime.descriptor.tools.map(tool => tool.name),
      sourcePath: runtime.kind === 'dynamic' ? runtime.sourcePath : undefined
    }))
  }

  async destroy(): Promise<void> {
    for (const runtime of this.active.values()) {
      if (runtime.kind === 'dynamic') {
        await runtime.handle.dispose()
      } else if (runtime.definition.hooks?.onEvent) {
        await runtime.definition.hooks.onEvent({ type: 'plugin.destroy', data: {} }, this.lifecycleContext())
      }
    }

    for (const runtime of this.pending.values()) {
      await runtime.handle.dispose()
    }

    this.active.clear()
    this.pending.clear()
    this.toolIndex.clear()
  }
}
