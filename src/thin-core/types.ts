import type { Agent, AgentRunResult } from '../types/agent.js'
import type { Message, LLMToolDefinition, ProviderID, DetailedTokenUsage } from '../llm/provider.types.js'

export type Capability = 'fs' | 'network' | 'bash' | 'mcp' | 'memory' | 'review' | 'ui' | 'routes'

export interface PluginPermissions {
  fs?: {
    read?: string[]
    write?: string[]
  }
  memory?: Record<string, never>
  network?: {
    domains?: string[]
  }
  bash?: {
    commands?: string[]
  }
  mcp?: {
    servers?: string[]
  }
  limits?: {
    timeoutMs?: number
    maxConcurrentOps?: number
    maxMemoryMb?: number
  }
}

export interface PluginManifest {
  id: string
  version: string
  capabilities?: Capability[]
  permissions?: PluginPermissions
  entry?: string
}

export interface SessionEvent {
  id: string
  ts: number
  type: string
  source?: string
  data?: Record<string, unknown>
}

export interface StateStore {
  append(event: SessionEvent): Promise<void>
  list(filter?: { type?: string; source?: string; limit?: number }): Promise<SessionEvent[]>
  getMemory<T = unknown>(key: string): Promise<T | undefined>
  setMemory<T = unknown>(key: string, value: T): Promise<void>
  deleteMemory(key: string): Promise<void>
  listMemory(prefix?: string): Promise<Record<string, unknown>>
  close?(): Promise<void>
}

export interface HookEvent {
  type: string
  data?: Record<string, unknown>
}

export type HookHandler = (event: HookEvent) => Promise<void> | void

export interface ToolRunContext {
  runId: string
  step: number
  projectPath: string
  store: StateStore
  emit: (type: string, data?: Record<string, unknown>) => Promise<void>
}

export interface PluginToolResult {
  ok: boolean
  content: string
  isError?: boolean
  data?: unknown
}

export interface PluginToolDefinition {
  name: string
  description: string
  parameters: LLMToolDefinition['parameters']
  timeoutMs?: number
  retries?: number
  execute: (args: unknown, ctx: ToolRunContext) => Promise<PluginToolResult>
}

export interface GuardDecision {
  allow: boolean
  reason?: string
  transformedArgs?: unknown
}

export type PluginGuard = (input: {
  toolName: string
  args: unknown
  context: ToolRunContext
}) => Promise<GuardDecision | void> | GuardDecision | void

export interface ContextFragment {
  source: string
  content: string
}

export interface PluginContextProvider {
  id: string
  provide: (input: { prompt: string; messages: Message[]; store: StateStore }) => Promise<ContextFragment | null>
}

export interface PluginRoute {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  description?: string
}

export interface PluginUIBinding {
  id: string
  description?: string
}

export interface BeforeModelInput {
  prompt: string
  messages: Message[]
  systemPrompt: string
  tools: LLMToolDefinition[]
}

export interface BeforeModelOutput {
  systemPrompt?: string
  messages?: Message[]
}

export interface AfterModelInput {
  prompt: string
  assistant: Message
  usage: DetailedTokenUsage
}

export interface BeforeToolInput {
  toolName: string
  args: unknown
}

export interface BeforeToolOutput {
  args?: unknown
}

export interface AfterToolInput {
  toolName: string
  args: unknown
  result: PluginToolResult
}

export interface PluginLifecycleHooks {
  onInit?: (ctx: PluginLifecycleContext) => Promise<void> | void
  beforeModel?: (input: BeforeModelInput, ctx: PluginLifecycleContext) => Promise<BeforeModelOutput | void> | BeforeModelOutput | void
  afterModel?: (input: AfterModelInput, ctx: PluginLifecycleContext) => Promise<void> | void
  beforeTool?: (input: BeforeToolInput, ctx: PluginLifecycleContext) => Promise<BeforeToolOutput | void> | BeforeToolOutput | void
  afterTool?: (input: AfterToolInput, ctx: PluginLifecycleContext) => Promise<void> | void
  onEvent?: (event: HookEvent, ctx: PluginLifecycleContext) => Promise<void> | void
}

export interface PluginLifecycleContext {
  projectPath: string
  store: StateStore
  emit: (type: string, data?: Record<string, unknown>) => Promise<void>
}

export interface PluginDefinition {
  manifest: PluginManifest
  prompts?: string[]
  tools?: PluginToolDefinition[]
  guards?: PluginGuard[]
  context?: PluginContextProvider[]
  routes?: PluginRoute[]
  ui?: PluginUIBinding[]
  hooks?: PluginLifecycleHooks
}

export interface PluginDescriptor {
  manifest: PluginManifest
  prompts: string[]
  tools: Omit<PluginToolDefinition, 'execute'>[]
  hasGuards: boolean
  contexts: string[]
  routes: PluginRoute[]
  ui: PluginUIBinding[]
}

export interface DynamicPluginHandle {
  descriptor: PluginDescriptor
  runHook: <TInput, TOutput>(name: keyof PluginLifecycleHooks, input: TInput) => Promise<TOutput | void>
  runGuard: (toolName: string, args: unknown, ctx: ToolRunContext) => Promise<GuardDecision | void>
  runContext: (prompt: string, messages: Message[]) => Promise<ContextFragment[]>
  runTool: (toolName: string, args: unknown, ctx: ToolRunContext) => Promise<PluginToolResult>
  dispose: () => Promise<void>
}

export interface PluginInstallResult {
  id: string
  version: string
  status: 'pending_activation' | 'active'
  toolCount: number
}

export interface ThinCreateAgentOptions {
  provider?: ProviderID
  model?: string
  apiKey?: string
  systemPrompt?: string
  projectPath?: string
  configDir?: string
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  plugins?: PluginDefinition[]
  store?: StateStore
  onStream?: (chunk: string) => void
  onToolCall?: (tool: string, input: unknown) => void
  onToolResult?: (tool: string, result: unknown) => void
  [key: string]: unknown
}

export interface ThinAgent extends Agent {
  installPlugin(path: string): Promise<PluginInstallResult>
  reloadPlugin(id: string): Promise<PluginInstallResult>
  testPlugin(input: { path?: string; id?: string }): Promise<Record<string, unknown>>
  invokePlugin(input: { id: string; tool: string; args?: unknown }): Promise<PluginToolResult>
}

export interface ThinAgentLoopDeps {
  projectPath: string
  model: string
  provider: ProviderID
  apiKey: string
  systemPrompt: string
  maxSteps: number
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  onStream?: (chunk: string) => void
  onToolCall?: (tool: string, input: unknown) => void
  onToolResult?: (tool: string, result: unknown) => void
}

export interface ThinAgentRuntime {
  run(prompt: string): Promise<AgentRunResult>
  stop(): void
  destroy(): Promise<void>
}
