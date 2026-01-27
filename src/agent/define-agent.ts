/**
 * defineAgent - Agent 定义工厂
 */

import type { AgentDefinition, Agent, AgentConfig, AgentRunResult, SessionState } from '../types/agent.js'
import type { Runtime } from '../types/runtime.js'

import { EventBus } from '../core/event-bus.js'
import { TraceCollector } from '../core/trace-collector.js'
import { TokenBudget } from '../core/token-budget.js'
import { RuntimeIO } from '../core/runtime-io.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { PolicyEngine } from '../core/policy-engine.js'
import { ContextManager } from '../core/context-manager.js'
import { PromptCompiler } from '../core/prompt-compiler.js'
import { AgentLoop } from './agent-loop.js'
import { createLLMClient, getModel } from '../llm/index.js'
import type { ProviderID } from '../llm/index.js'

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
 * 定义 Agent
 */
export function defineAgent(definition: AgentDefinition): (config: AgentConfig) => Agent {
  return (config: AgentConfig): Agent => {
    const agentId = definition.id
    const sessionId = generateId()

    // 创建核心组件
    const eventBus = new EventBus()
    const trace = new TraceCollector(sessionId)
    const tokenBudget = new TokenBudget({
      total: definition.model?.maxTokens ?? config.maxTokens ?? 100000,
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

    // 创建运行时
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

    ;(runtime as any).io = runtimeIO

    // 配置组件
    toolRegistry.configure({ policyEngine, trace, runtime })
    contextManager.configure({ trace, tokenBudget, runtime })

    // 合并 Packs
    const allPacks = [...definition.packs, ...(config.packs ?? [])]

    for (const pack of allPacks) {
      if (pack.tools) toolRegistry.registerAll(pack.tools)
      if (pack.policies) policyEngine.registerAll(pack.policies)
      if (pack.contextSources) contextManager.registerAll(pack.contextSources)
    }

    // 注册定义级别的策略
    if (definition.policies) {
      policyEngine.registerAll(definition.policies)
    }

    // 注册配置级别的策略
    if (config.policies) {
      policyEngine.registerAll(config.policies)
    }

    // 确定 Provider 和模型
    const modelId = config.model ?? definition.model?.default ?? 'gpt-4o'
    const modelConfig = getModel(modelId)
    const provider: ProviderID = config.provider ?? modelConfig?.providerID ?? 'openai'
    const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? ''

    // 创建 LLM 客户端
    const llmClient = createLLMClient({
      provider,
      model: modelId,
      config: { apiKey }
    })

    // 将 LLM 客户端添加到 runtime（供工具内 LLM 调用使用）
    ;(runtime as any).llmClient = llmClient

    // 编译系统提示
    const promptCompiler = new PromptCompiler()
    const compiledPrompt = promptCompiler.compile(
      definition,
      toolRegistry,
      contextManager,
      tokenBudget
    )

    const systemPrompt = compiledPrompt.render()

    // 创建 AgentLoop
    let agentLoop: AgentLoop | null = null

    const agent: Agent = {
      id: agentId,
      runtime,

      async run(prompt: string): Promise<AgentRunResult> {
        // 初始化 Packs
        for (const pack of allPacks) {
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
          maxSteps: definition.maxSteps ?? config.maxSteps ?? 30,
          maxTokens: definition.model?.maxTokens ?? config.maxTokens,
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
        for (const pack of allPacks) {
          if (pack.onDestroy) {
            await pack.onDestroy(runtime)
          }
        }

        eventBus.clear()
        trace.clear()
        toolRegistry.clear()
        contextManager.clear()
        policyEngine.clear()
      }
    }

    return agent
  }
}

/**
 * 验证 Agent 定义
 */
export function validateAgentDefinition(definition: Partial<AgentDefinition>): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!definition.id) {
    errors.push('id is required')
  }

  if (!definition.name) {
    errors.push('name is required')
  }

  if (!definition.identity) {
    errors.push('identity is required')
  }

  if (!definition.packs || definition.packs.length === 0) {
    errors.push('at least one pack is required')
  }

  if (!definition.constraints) {
    errors.push('constraints is required')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}
