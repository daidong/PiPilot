/**
 * createAgent - Agent 创建工厂
 */

import type { Agent, AgentConfig, AgentRunResult, SessionState } from '../types/agent.js'
import type { Runtime } from '../types/runtime.js'
import type { Pack } from '../types/pack.js'

import { EventBus } from '../core/event-bus.js'
import { TraceCollector } from '../core/trace-collector.js'
import { TokenBudget } from '../core/token-budget.js'
import { RuntimeIO } from '../core/runtime-io.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { PolicyEngine } from '../core/policy-engine.js'
import { ContextManager } from '../core/context-manager.js'
import { PromptCompiler } from '../core/prompt-compiler.js'
import { AgentLoop } from './agent-loop.js'
import { createLLMClient, detectProviderFromApiKey } from '../llm/index.js'
import type { ProviderID } from '../llm/index.js'
import { packs } from '../packs/index.js'
import {
  tryLoadConfig,
  normalizePackConfigs,
  type AgentYAMLConfig
} from '../config/index.js'

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 创建会话状态
 */
function createSessionState(): SessionState {
  const store = new Map<string, unknown>()

  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => { store.set(key, value) },
    delete: (key: string): void => { store.delete(key) },
    has: (key: string): boolean => store.has(key)
  }
}

/**
 * 根据 API 密钥自动检测 Provider 和默认模型
 */
function detectProviderAndModel(apiKey: string, preferredModel?: string): { provider: ProviderID; model: string } {
  const provider = detectProviderFromApiKey(apiKey)

  if (provider) {
    const model = preferredModel || (provider === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022')
    return { provider, model }
  }

  // 默认使用 OpenAI
  return {
    provider: 'openai',
    model: preferredModel || 'gpt-4o'
  }
}

/**
 * Pack 名称到工厂函数的映射
 * 注意: python pack 需要 PythonBridge 配置，无法自动创建
 */
type PackFactory = (options?: Record<string, unknown>) => Pack

const packFactories: Record<string, PackFactory> = {
  safe: packs.safe,
  exec: packs.exec,
  network: packs.network as PackFactory,
  compute: packs.compute as PackFactory,
  repo: packs.repo,
  git: packs.git,
  exploration: packs.exploration,
  browser: packs.browser,
  'kv-memory': packs.kvMemory,
  kvMemory: packs.kvMemory,  // alias without hyphen
  docs: packs.docs,
  discovery: packs.discovery,
  'session-memory': packs.sessionMemory,
  sessionMemory: packs.sessionMemory  // alias without hyphen
  // python: requires PythonBridge, cannot be auto-created from config
}

/**
 * 根据 pack 名称解析为 Pack 实例
 */
function resolvePackFromName(packConfig: { name: string; options?: Record<string, unknown> }): Pack | null {
  const factory = packFactories[packConfig.name]
  if (!factory) {
    console.warn(`[createAgent] Unknown pack: ${packConfig.name}`)
    return null
  }

  return factory(packConfig.options)
}

/**
 * 从 YAML 配置解析 Packs
 */
function resolvePacksFromConfig(yamlConfig: AgentYAMLConfig): Pack[] {
  if (!yamlConfig.packs || yamlConfig.packs.length === 0) {
    return [packs.safe()]
  }

  const normalized = normalizePackConfigs(yamlConfig.packs)
  const resolvedPacks: Pack[] = []

  for (const packConfig of normalized) {
    const pack = resolvePackFromName(packConfig)
    if (pack) {
      resolvedPacks.push(pack)
    }
  }

  // 确保至少有 safe pack
  if (resolvedPacks.length === 0) {
    return [packs.safe()]
  }

  return resolvedPacks
}

/**
 * 创建 Agent 的选项（扩展 AgentConfig）
 */
export interface CreateAgentOptions extends AgentConfig {
  /** 是否禁用配置文件加载 */
  skipConfigFile?: boolean

  /** 配置文件搜索目录（默认 process.cwd()） */
  configDir?: string

  /** Agent 身份描述（从配置文件或参数） */
  identity?: string

  /** 约束条件 */
  constraints?: string[]

  /**
   * Pre-loaded context to include in system prompt.
   * Use this to inject agent knowledge, cached schema, etc.
   * The content will be included in the "Pre-loaded Context" section.
   */
  initialContext?: string
}

/**
 * 创建 Agent
 */
export function createAgent(config: CreateAgentOptions = {}): Agent {
  // 尝试加载配置文件
  let yamlConfig: AgentYAMLConfig | null = null
  if (!config.skipConfigFile) {
    yamlConfig = tryLoadConfig(config.configDir ?? config.projectPath)
  }

  const agentId = generateId()
  const sessionId = generateId()

  // 合并配置：参数 > YAML 配置 > 默认值
  // Let the LLM layer use model-specific defaults if not specified
  const effectiveMaxTokens = config.maxTokens
    ?? yamlConfig?.model?.maxTokens

  // Token budget for tracking usage (separate from LLM maxTokens)
  const tokenBudgetTotal = effectiveMaxTokens ?? 100000

  const effectiveMaxSteps = config.maxSteps
    ?? yamlConfig?.maxSteps
    ?? 30

  const effectiveModel = config.model
    ?? yamlConfig?.model?.default

  const effectiveIdentity = config.identity
    ?? yamlConfig?.identity
    ?? 'You are a helpful AI assistant with access to various tools.'

  const effectiveConstraints = config.constraints
    ?? yamlConfig?.constraints
    ?? [
      'Always explain what you are doing before taking actions',
      'Ask for clarification when instructions are unclear'
    ]

  // 创建核心组件
  const eventBus = new EventBus()
  const trace = new TraceCollector(sessionId)
  const tokenBudget = new TokenBudget({
    total: tokenBudgetTotal,
    warningThreshold: 0.8
  })

  // 创建策略引擎
  const policyEngine = new PolicyEngine({
    trace,
    eventBus,
    onApprovalRequired: config.onApprovalRequired
      ? async (decision) => config.onApprovalRequired!(decision.message, decision.timeout)
      : undefined,
    onAlert: (alert) => {
      console.log(`[${alert.level}] ${alert.message}`)
    }
  })

  // 创建工具注册表
  const toolRegistry = new ToolRegistry()

  // 创建上下文管理器
  const contextManager = new ContextManager()

  // 获取工作目录
  const projectPath = config.projectPath ?? process.cwd()

  // 创建运行时占位（需要先创建才能传递给 RuntimeIO）
  let currentStep = 0
  const runtime: Runtime = {
    projectPath,
    sessionId,
    agentId,
    get step() { return currentStep },
    set step(value: number) { currentStep = value },
    io: null as unknown as RuntimeIO,
    eventBus,
    trace,
    tokenBudget,
    toolRegistry,
    policyEngine,
    contextManager,
    sessionState: createSessionState()
  } as Runtime

  // 创建 RuntimeIO
  const runtimeIO = new RuntimeIO({
    projectPath,
    policyEngine,
    trace,
    eventBus,
    agentId,
    sessionId,
    getCurrentStep: () => currentStep
  })

  // 更新 runtime
  ;(runtime as any).io = runtimeIO

  // 配置工具注册表
  toolRegistry.configure({
    policyEngine,
    trace,
    runtime
  })

  // 配置上下文管理器
  contextManager.configure({
    trace,
    tokenBudget,
    runtime
  })

  // 加载 Packs
  // 优先级：参数 > YAML 配置 > 默认
  let packsToLoad: Pack[]

  if (config.packs && config.packs.length > 0) {
    // 参数指定了 packs
    packsToLoad = config.packs
  } else if (yamlConfig) {
    // 从 YAML 配置解析
    packsToLoad = resolvePacksFromConfig(yamlConfig)
  } else {
    // 默认
    packsToLoad = [packs.standard()]
  }

  for (const pack of packsToLoad) {
    // 注册工具
    if (pack.tools) {
      toolRegistry.registerAll(pack.tools)
    }

    // 注册策略
    if (pack.policies) {
      policyEngine.registerAll(pack.policies)
    }

    // 注册上下文源
    if (pack.contextSources) {
      contextManager.registerAll(pack.contextSources)
    }
  }

  // 注册额外策略
  if (config.policies) {
    policyEngine.registerAll(config.policies)
  }

  // 创建 LLM 客户端
  const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? ''
  const { provider, model } = detectProviderAndModel(apiKey, effectiveModel)

  const llmClient = createLLMClient({
    provider,
    model,
    config: { apiKey }
  })

  // 将 LLM 客户端添加到 runtime（供工具内 LLM 调用使用）
  ;(runtime as any).llmClient = llmClient

  // 编译系统提示
  const promptCompiler = new PromptCompiler()
  const compiledPrompt = promptCompiler.compileSimple({
    identity: effectiveIdentity,
    tools: toolRegistry,
    contextSources: contextManager,
    constraints: effectiveConstraints,
    initialContext: config.initialContext
  }, tokenBudget)

  const systemPrompt = compiledPrompt.render()

  // 创建 AgentLoop
  let agentLoop: AgentLoop | null = null

  const agent: Agent = {
    id: agentId,

    async run(prompt: string): Promise<AgentRunResult> {
      // 初始化 Packs
      for (const pack of packsToLoad) {
        if (pack.onInit) {
          await pack.onInit(runtime)
        }
      }

      agentLoop = new AgentLoop({
        client: llmClient,
        toolRegistry,
        runtime,
        trace,
        systemPrompt,
        maxSteps: effectiveMaxSteps,
        maxTokens: effectiveMaxTokens,
        onText: config.onStream,
        onToolCall: config.onToolCall,
        onToolResult: config.onToolResult
      })

      return agentLoop.run(prompt)
    },

    stop(): void {
      agentLoop?.stop()
    },

    async destroy(): Promise<void> {
      // 销毁 Packs
      for (const pack of packsToLoad) {
        if (pack.onDestroy) {
          await pack.onDestroy(runtime)
        }
      }

      // 清理
      eventBus.clear()
      trace.clear()
      toolRegistry.clear()
      contextManager.clear()
      policyEngine.clear()
    }
  }

  return agent
}
