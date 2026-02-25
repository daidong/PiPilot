import { randomUUID } from 'node:crypto'
import type { AgentRunResult } from '../types/agent.js'
import type { Message, DetailedTokenUsage } from '../llm/provider.types.js'
import { createLLMClient, streamWithCallbacks } from '../llm/index.js'
import type { ThinAgentLoopDeps, StateStore, ToolRunContext } from './types.js'
import { createEvent } from './state-store.js'
import { PluginRegistry } from './plugin-registry.js'
import { HookBus } from './hook-bus.js'

function usageAdd(left: DetailedTokenUsage, right: DetailedTokenUsage): DetailedTokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheCreationInputTokens: (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0)
  }
}

export class ThinAgentLoop {
  private readonly deps: ThinAgentLoopDeps
  private readonly store: StateStore
  private readonly hookBus: HookBus
  private readonly plugins: PluginRegistry
  private readonly client: ReturnType<typeof createLLMClient>
  private readonly messages: Message[] = []
  private stopped = false

  constructor(input: {
    deps: ThinAgentLoopDeps
    store: StateStore
    hookBus: HookBus
    plugins: PluginRegistry
  }) {
    this.deps = input.deps
    this.store = input.store
    this.hookBus = input.hookBus
    this.plugins = input.plugins

    this.client = createLLMClient({
      provider: this.deps.provider,
      model: this.deps.model,
      config: { apiKey: this.deps.apiKey }
    })
  }

  stop(): void {
    this.stopped = true
  }

  async destroy(): Promise<void> {
    // nothing to cleanup in loop, lifecycle managed by createAgent
  }

  private async emit(type: string, source: string, data?: Record<string, unknown>): Promise<void> {
    const event = createEvent(type, source, data)
    await this.store.append(event)
    await this.hookBus.emit(type, data)
    await this.plugins.broadcast({ type, data })
  }

  private buildSystemPrompt(contextBlocks: Array<{ source: string; content: string }>): string {
    const promptFragments = this.plugins.getPromptFragments()

    const pluginPromptSection = promptFragments.length > 0
      ? `\n\n## Plugin Guidance\n${promptFragments.map(item => `- ${item}`).join('\n')}`
      : ''

    const contextSection = contextBlocks.length > 0
      ? `\n\n## Runtime Context\n${contextBlocks.map(item => `### ${item.source}\n${item.content}`).join('\n\n')}`
      : ''

    return `${this.deps.systemPrompt}${pluginPromptSection}${contextSection}`
  }

  async run(prompt: string): Promise<AgentRunResult> {
    const startedAt = Date.now()
    const runId = randomUUID()
    this.stopped = false

    await this.emit('agent.run_start', 'thin-core.loop', {
      runId,
      prompt
    })

    const userMessage: Message = {
      role: 'user',
      content: prompt
    }

    this.messages.push(userMessage)

    await this.emit('agent.message_user', 'thin-core.loop', {
      runId,
      message: prompt
    })

    const maxSteps = Math.max(1, this.deps.maxSteps)
    let finalOutput = ''
    let steps = 0
    let usage: DetailedTokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    }

    for (let step = 1; step <= maxSteps; step += 1) {
      if (this.stopped) break
      steps = step
      await this.plugins.activatePending()

      const contextBlocks = await this.plugins.collectContext(prompt, this.messages)
      let systemPrompt = this.buildSystemPrompt(contextBlocks)
      let modelMessages = [...this.messages]
      const toolSchemas = this.plugins.getToolSchemas()

      const beforeModel = await this.plugins.applyBeforeModel({
        prompt,
        messages: modelMessages,
        systemPrompt,
        tools: toolSchemas
      })

      systemPrompt = beforeModel.systemPrompt
      modelMessages = beforeModel.messages

      await this.emit('agent.before_model', 'thin-core.loop', {
        runId,
        step,
        toolCount: toolSchemas.length
      })

      let accumulatedText = ''
      let toolCalls: Array<{ id: string; name: string; input: unknown }> = []
      let lastUsage: DetailedTokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }

      const completion = await streamWithCallbacks(
        this.client,
        {
          system: systemPrompt,
          messages: modelMessages,
          tools: toolSchemas,
          maxTokens: this.deps.maxTokens,
          temperature: this.deps.temperature,
          reasoningEffort: this.deps.reasoningEffort
        },
        {
          onText: chunk => {
            accumulatedText += chunk
            this.deps.onStream?.(chunk)
          },
          onToolCall: call => {
            toolCalls.push({
              id: call.toolCallId,
              name: call.toolName,
              input: call.args
            })
            this.deps.onToolCall?.(call.toolName, call.args)
          },
          onFinish: result => {
            lastUsage = result.usage
            toolCalls = result.toolCalls.map(call => ({
              id: call.id,
              name: call.name,
              input: call.input
            }))
            if (!accumulatedText && result.text) {
              accumulatedText = result.text
            }
          }
        }
      )

      usage = usageAdd(usage, completion.usage)

      const assistantBlocks: Message['content'] = toolCalls.length === 0
        ? accumulatedText
        : [
            ...(accumulatedText ? [{ type: 'text', text: accumulatedText } as const] : []),
            ...toolCalls.map(call => ({
              type: 'tool_use' as const,
              id: call.id,
              name: call.name,
              input: call.input
            }))
          ]

      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantBlocks
      }

      this.messages.push(assistantMessage)
      await this.emit('agent.after_model', 'thin-core.loop', {
        runId,
        step,
        finishReason: completion.finishReason,
        toolCalls: toolCalls.map(call => call.name)
      })

      await this.plugins.applyAfterModel({
        prompt,
        assistant: assistantMessage,
        usage: lastUsage
      })

      if (toolCalls.length === 0) {
        finalOutput = accumulatedText
        break
      }

      for (const call of toolCalls) {
        if (this.stopped) break

        const toolContext: ToolRunContext = {
          runId,
          step,
          projectPath: this.deps.projectPath,
          store: this.store,
          emit: async (type, data) => this.emit(type, 'thin-core.tool', data)
        }

        await this.emit('agent.tool_start', 'thin-core.loop', {
          runId,
          step,
          tool: call.name
        })

        const result = await this.plugins.executeTool(call.name, call.input, toolContext)

        this.deps.onToolResult?.(call.name, result)

        const toolResultMessage: Message = {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: result.content,
              is_error: result.isError
            }
          ]
        }

        this.messages.push(toolResultMessage)

        await this.emit('agent.tool_end', 'thin-core.loop', {
          runId,
          step,
          tool: call.name,
          ok: result.ok,
          isError: result.isError === true
        })
      }
    }

    const success = !this.stopped

    await this.emit('agent.run_end', 'thin-core.loop', {
      runId,
      success,
      steps,
      durationMs: Date.now() - startedAt
    })

    return {
      success,
      output: finalOutput,
      steps,
      durationMs: Date.now() - startedAt,
      trace: [],
      usage: {
        tokens: usage,
        cost: {
          promptCost: 0,
          completionCost: 0,
          cachedReadCost: 0,
          cacheCreationCost: 0,
          totalCost: 0,
          modelId: this.deps.model
        },
        callCount: steps,
        cacheHitRate: 0,
        durationMs: Date.now() - startedAt
      }
    }
  }
}
