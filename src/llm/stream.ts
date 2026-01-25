/**
 * Stream - 统一流式 API
 *
 * 基于 Vercel AI SDK 的流式处理，支持双流合并
 */

import {
  streamText,
  generateText,
  type CoreMessage,
  type CoreTool,
  type LanguageModelV1
} from 'ai'
import { z } from 'zod'
import type {
  StreamOptions,
  GenerateOptions,
  CompletionResponse,
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  FinishEvent,
  ErrorEvent,
  TokenUsage,
  Message,
  ContentBlock,
  ToolUseContent,
  LLMToolDefinition
} from './provider.types.js'
import {
  getLanguageModel,
  getModelDefaults,
  supportsTools
} from './provider.js'
import { getModel } from './models.js'
import type { ProviderSDKConfig, ProviderID } from './provider.types.js'

/**
 * 将框架消息转换为 Vercel AI SDK 消息格式
 */
function convertMessages(messages: Message[]): CoreMessage[] {
  return messages.map((msg): CoreMessage => {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content
      }
    }

    // 处理内容块数组
    const blocks = msg.content as ContentBlock[]

    if (msg.role === 'assistant') {
      // Assistant 消息可能包含工具调用
      const textBlocks = blocks.filter(b => b.type === 'text')
      const toolCallBlocks = blocks.filter(b => b.type === 'tool_use')

      // 构建内容数组，包含文本和工具调用
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
      > = []

      // 添加文本块
      for (const block of textBlocks) {
        content.push({
          type: 'text',
          text: (block as { text: string }).text
        })
      }

      // 添加工具调用
      for (const tc of toolCallBlocks) {
        content.push({
          type: 'tool-call',
          toolCallId: (tc as ToolUseContent).id,
          toolName: (tc as ToolUseContent).name,
          args: (tc as ToolUseContent).input as Record<string, unknown>
        })
      }

      if (content.length === 0) {
        return {
          role: 'assistant',
          content: ''
        }
      }

      // 如果只有文本块，返回简单字符串
      if (toolCallBlocks.length === 0) {
        return {
          role: 'assistant',
          content: textBlocks.map(b => (b as { text: string }).text).join('')
        }
      }

      return {
        role: 'assistant',
        content
      }
    }

    if (msg.role === 'tool') {
      // Tool 结果消息
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      return {
        role: 'tool',
        content: toolResults.map(tr => ({
          type: 'tool-result' as const,
          toolCallId: (tr as { tool_use_id: string }).tool_use_id,
          toolName: 'unknown', // Will be matched by toolCallId
          result: (tr as { content: string }).content
        }))
      }
    }

    // User 或 System 消息
    const textContent = blocks
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')

    return {
      role: msg.role as 'user' | 'system',
      content: textContent
    }
  })
}

/**
 * 将 LLM 工具定义转换为 Vercel AI SDK 工具格式
 */
function convertTools(
  tools: LLMToolDefinition[]
): Record<string, CoreTool<any, any>> {
  const result: Record<string, CoreTool<any, any>> = {}

  for (const tool of tools) {
    // 将 JSON Schema 转换为 Zod schema
    const zodSchema = jsonSchemaToZod(tool.parameters)

    result[tool.name] = {
      description: tool.description,
      parameters: zodSchema
    }
  }

  return result
}

/**
 * 简化的 JSON Schema 到 Zod 转换
 */
function jsonSchemaToZod(schema: {
  type: string
  properties: Record<string, unknown>
  required?: string[]
}): z.ZodType<any> {
  const props: Record<string, z.ZodType<any>> = {}
  const required = schema.required || []

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const prop = propSchema as { type?: string; description?: string }
    let zodProp: z.ZodType<any>

    switch (prop.type) {
      case 'string':
        zodProp = z.string()
        break
      case 'number':
        zodProp = z.number()
        break
      case 'integer':
        zodProp = z.number().int()
        break
      case 'boolean':
        zodProp = z.boolean()
        break
      case 'array':
        zodProp = z.array(z.unknown())
        break
      case 'object':
        zodProp = z.record(z.unknown())
        break
      default:
        zodProp = z.unknown()
    }

    if (prop.description) {
      zodProp = zodProp.describe(prop.description)
    }

    if (!required.includes(key)) {
      zodProp = zodProp.optional()
    }

    props[key] = zodProp
  }

  return z.object(props)
}

/**
 * LLM 客户端配置
 */
export interface LLMClientConfig {
  /** Provider ID */
  provider: ProviderID
  /** 模型 ID */
  model: string
  /** SDK 配置 */
  config: ProviderSDKConfig
}

/**
 * 创建 LLM 客户端
 */
export function createLLMClient(clientConfig: LLMClientConfig) {
  const languageModel = getLanguageModel({
    provider: clientConfig.provider,
    model: clientConfig.model,
    config: clientConfig.config
  })

  const modelConfig = getModel(clientConfig.model)
  const defaults = getModelDefaults(clientConfig.model)

  return {
    /**
     * 流式生成
     */
    async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
      const { system, messages, tools, maxTokens, temperature, stopSequences } =
        options

      const streamOptions: Parameters<typeof streamText>[0] = {
        model: languageModel,
        system,
        messages: convertMessages(messages),
        maxTokens: maxTokens ?? defaults.maxTokens,
        stopSequences
      }

      // 只在模型支持时添加温度
      if (modelConfig?.capabilities.temperature && temperature !== undefined) {
        streamOptions.temperature = temperature
      }

      // 只在模型支持时添加工具
      if (tools && tools.length > 0 && supportsTools(clientConfig.model)) {
        streamOptions.tools = convertTools(tools)
      }

      try {
        const result = streamText(streamOptions)

        // 使用 fullStream 获取所有事件
        for await (const event of result.fullStream) {
          switch (event.type) {
            case 'text-delta':
              yield {
                type: 'text-delta',
                data: { text: event.textDelta }
              } as TextDeltaEvent
              break

            case 'tool-call':
              yield {
                type: 'tool-call',
                data: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args
                }
              } as ToolCallEvent
              break

            case 'step-finish':
              // 可以处理步骤完成事件
              break

            case 'finish':
              const usage = await result.usage
              const text = await result.text
              const toolCalls = (await result.toolCalls) || []

              yield {
                type: 'finish',
                data: {
                  finishReason: event.finishReason,
                  usage: {
                    promptTokens: usage?.promptTokens ?? 0,
                    completionTokens: usage?.completionTokens ?? 0,
                    totalTokens: usage?.totalTokens ?? 0
                  },
                  text,
                  toolCalls: toolCalls.map((tc: { toolCallId: string; toolName: string; args: unknown }) => ({
                    type: 'tool_use' as const,
                    id: tc.toolCallId,
                    name: tc.toolName,
                    input: tc.args
                  }))
                }
              } as FinishEvent
              break

            case 'error':
              yield {
                type: 'error',
                data: { error: event.error as Error }
              } as ErrorEvent
              break
          }
        }
      } catch (error) {
        yield {
          type: 'error',
          data: { error: error as Error }
        } as ErrorEvent
      }
    },

    /**
     * 非流式生成
     */
    async generate(options: GenerateOptions): Promise<CompletionResponse> {
      const { system, messages, tools, maxTokens, temperature, stopSequences } =
        options

      const generateOptions: Parameters<typeof generateText>[0] = {
        model: languageModel,
        system,
        messages: convertMessages(messages),
        maxTokens: maxTokens ?? defaults.maxTokens,
        stopSequences
      }

      // 只在模型支持时添加温度
      if (modelConfig?.capabilities.temperature && temperature !== undefined) {
        generateOptions.temperature = temperature
      }

      // 只在模型支持时添加工具
      if (tools && tools.length > 0 && supportsTools(clientConfig.model)) {
        generateOptions.tools = convertTools(tools)
      }

      const result = await generateText(generateOptions)

      const toolCalls: ToolUseContent[] = (result.toolCalls || []).map((tc: { toolCallId: string; toolName: string; args: unknown }) => ({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args
      }))

      let finishReason: CompletionResponse['finishReason'] = 'stop'
      if (result.finishReason === 'tool-calls') {
        finishReason = 'tool-calls'
      } else if (result.finishReason === 'length') {
        finishReason = 'length'
      } else if (result.finishReason === 'content-filter') {
        finishReason = 'content-filter'
      } else if (result.finishReason === 'error') {
        finishReason = 'error'
      }

      return {
        id: result.response?.id ?? crypto.randomUUID(),
        text: result.text,
        toolCalls,
        finishReason,
        usage: {
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0
        }
      }
    },

    /**
     * 获取模型配置
     */
    getModelConfig() {
      return modelConfig
    },

    /**
     * 获取语言模型实例
     */
    getLanguageModel(): LanguageModelV1 {
      return languageModel
    }
  }
}

/**
 * 快捷方式：直接使用模型 ID 创建客户端
 */
export function createLLMClientFromModelId(
  modelId: string,
  config: ProviderSDKConfig
) {
  const modelConfig = getModel(modelId)
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId}`)
  }

  return createLLMClient({
    provider: modelConfig.providerID,
    model: modelId,
    config
  })
}

/**
 * 流式回调接口
 */
export interface StreamCallbacks {
  onText?: (text: string) => void
  onToolCall?: (toolCall: {
    toolCallId: string
    toolName: string
    args: unknown
  }) => void
  onFinish?: (result: {
    text: string
    toolCalls: ToolUseContent[]
    usage: TokenUsage
  }) => void
  onError?: (error: Error) => void
}

/**
 * 使用回调的流式生成
 */
export async function streamWithCallbacks(
  client: ReturnType<typeof createLLMClient>,
  options: StreamOptions,
  callbacks: StreamCallbacks
): Promise<CompletionResponse> {
  let finalText = ''
  const toolCalls: ToolUseContent[] = []
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let finishReason: CompletionResponse['finishReason'] = 'stop'

  for await (const event of client.stream(options)) {
    switch (event.type) {
      case 'text-delta':
        const textData = event.data as { text: string }
        finalText += textData.text
        callbacks.onText?.(textData.text)
        break

      case 'tool-call':
        const toolData = event.data as {
          toolCallId: string
          toolName: string
          args: unknown
        }
        toolCalls.push({
          type: 'tool_use',
          id: toolData.toolCallId,
          name: toolData.toolName,
          input: toolData.args
        })
        callbacks.onToolCall?.(toolData)
        break

      case 'finish':
        const finishData = event.data as FinishEvent['data']
        usage = finishData.usage
        finishReason = finishData.finishReason as CompletionResponse['finishReason']
        callbacks.onFinish?.({
          text: finishData.text,
          toolCalls: finishData.toolCalls,
          usage: finishData.usage
        })
        break

      case 'error':
        const errorData = event.data as { error: Error }
        callbacks.onError?.(errorData.error)
        finishReason = 'error'
        break
    }
  }

  return {
    id: crypto.randomUUID(),
    text: finalText,
    toolCalls,
    finishReason,
    usage
  }
}
