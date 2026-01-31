/**
 * Stream - 统一流式 API
 *
 * 基于 Vercel AI SDK 的流式处理，支持双流合并
 */

import {
  streamText,
  generateText,
  type ModelMessage,
  type LanguageModel,
  type ToolSet
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
function convertMessages(messages: Message[]): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
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
      // SDK 6: ToolCallPart uses 'input' instead of 'args'
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
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
          input: (tc as ToolUseContent).input
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
      // SDK 6: ToolResultPart uses output: { type: 'text', value: string }
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      return {
        role: 'tool',
        content: toolResults.map(tr => ({
          type: 'tool-result' as const,
          toolCallId: (tr as { tool_use_id: string }).tool_use_id,
          toolName: 'unknown', // Will be matched by toolCallId
          output: {
            type: 'text' as const,
            value: (tr as { content: string }).content
          }
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
 * SDK 6: uses inputSchema instead of parameters, strict defaults to false
 */
function convertTools(
  tools: LLMToolDefinition[]
): ToolSet {
  const result: ToolSet = {}

  for (const tool of tools) {
    // 将 JSON Schema 转换为 Zod schema
    const zodSchema = jsonSchemaToZod(tool.parameters)

    result[tool.name] = {
      description: tool.description,
      inputSchema: zodSchema
      // strict: false is the default in SDK 6, no need to set
    }
  }

  return result
}

/**
 * JSON Schema property type
 */
interface JsonSchemaProperty {
  type?: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

/**
 * Convert a single JSON Schema property to Zod type
 * OpenAI strict mode requirements:
 * - All types must be explicit (no 'any' or 'unknown')
 * - additionalProperties must have 'type' key
 * - All object properties must be in 'required' array (use nullable for optional)
 */
function convertPropertyToZod(prop: JsonSchemaProperty, isRequired: boolean): z.ZodType<any> {
  let zodType: z.ZodType<any>

  switch (prop.type) {
    case 'string':
      // Handle enum
      if (prop.enum && prop.enum.length > 0) {
        zodType = z.enum(prop.enum as [string, ...string[]])
      } else {
        zodType = z.string()
      }
      break

    case 'number':
      zodType = z.number()
      break

    case 'integer':
      zodType = z.number().int()
      break

    case 'boolean':
      zodType = z.boolean()
      break

    case 'array':
      // Handle array items
      if (prop.items) {
        const itemType = convertPropertyToZod(prop.items, true)
        zodType = z.array(itemType)
      } else {
        // Default to string array for OpenAI strict mode
        zodType = z.array(z.string())
      }
      break

    case 'object':
      // Handle object with defined properties
      if (prop.properties && Object.keys(prop.properties).length > 0) {
        const nestedRequired = prop.required || []
        const nestedProps: Record<string, z.ZodType<any>> = {}

        for (const [key, nestedProp] of Object.entries(prop.properties)) {
          const isNestedRequired = nestedRequired.includes(key)
          nestedProps[key] = convertPropertyToZod(nestedProp, isNestedRequired)
        }
        zodType = z.object(nestedProps)
      } else {
        // Dynamic object without defined properties
        // Use z.object({}).catchall() to generate both:
        // - "properties": {} (required by OpenAI strict mode for 'required' array)
        // - "additionalProperties": { "type": "string" }
        // z.record() doesn't generate 'properties' which causes OpenAI strict mode errors
        zodType = z.object({}).catchall(z.string())
      }
      break

    default:
      // Fallback to string for OpenAI strict mode
      zodType = z.string()
  }

  // Add description
  if (prop.description) {
    zodType = zodType.describe(prop.description)
  }

  // Handle optional (nullable) fields
  // OpenAI strict mode requires all properties in 'required' array
  // Use nullable() for optional fields
  if (!isRequired) {
    zodType = zodType.nullable()
  }

  return zodType
}

/**
 * Convert JSON Schema to Zod schema
 * Handles nested objects, arrays, enums, and OpenAI strict mode requirements
 */
function jsonSchemaToZod(schema: {
  type: string
  properties: Record<string, unknown>
  required?: string[]
}): z.ZodType<any> {
  const props: Record<string, z.ZodType<any>> = {}
  const required = schema.required || []

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const isRequired = required.includes(key)
    props[key] = convertPropertyToZod(propSchema as JsonSchemaProperty, isRequired)
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
      const { system, messages, tools, maxTokens, temperature, stopSequences, reasoningEffort } =
        options

      const streamOptions: Parameters<typeof streamText>[0] = {
        model: languageModel,
        system,
        messages: convertMessages(messages),
        maxOutputTokens: maxTokens ?? defaults.maxTokens,
        stopSequences
      }

      // Only add temperature when model supports it
      if (modelConfig?.capabilities.temperature && temperature !== undefined) {
        streamOptions.temperature = temperature
      }

      // Pass reasoning effort for reasoning models via providerOptions
      if (modelConfig?.capabilities.reasoning && reasoningEffort) {
        if (clientConfig.provider === 'anthropic') {
          // Anthropic uses 'thinking' with a budget token approach
          // reasoningEffort is not directly supported; skip for now
        } else {
          streamOptions.providerOptions = {
            openai: { reasoningEffort }
          }
        }
      }

      // Only add tools when model supports them
      // SDK 6: strict mode defaults to false per tool, no need to configure globally
      if (tools && tools.length > 0 && supportsTools(clientConfig.model)) {
        streamOptions.tools = convertTools(tools)
      }

      // Debug: log exact request params to verify maxOutputTokens forwarding
      if (typeof process !== 'undefined' && process.env?.AGENT_FOUNDRY_DEBUG_LLM) {
        console.error('[LLM:debug] streamText params:', JSON.stringify({
          maxOutputTokens: streamOptions.maxOutputTokens,
          temperature: streamOptions.temperature,
          toolCount: streamOptions.tools ? Object.keys(streamOptions.tools).length : 0,
          systemLength: typeof streamOptions.system === 'string' ? streamOptions.system.length : 0,
          messagesCount: streamOptions.messages?.length ?? 0,
          providerOptions: streamOptions.providerOptions
        }))
      }

      try {
        const result = streamText(streamOptions)

        // 使用 fullStream 获取所有事件
        for await (const event of result.fullStream) {
          switch (event.type) {
            case 'text-delta':
              yield {
                type: 'text-delta',
                data: { text: event.text }
              } as TextDeltaEvent
              break

            case 'tool-call':
              yield {
                type: 'tool-call',
                data: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.input
                }
              } as ToolCallEvent
              break

            case 'finish':
              const usage = await result.usage
              const text = await result.text
              const toolCalls = (await result.toolCalls) || []

              // SDK 6: inputTokens/outputTokens instead of promptTokens/completionTokens
              const inputTokens = usage?.inputTokens ?? 0
              const outputTokens = usage?.outputTokens ?? 0

              yield {
                type: 'finish',
                data: {
                  finishReason: event.finishReason,
                  usage: {
                    promptTokens: inputTokens,
                    completionTokens: outputTokens,
                    totalTokens: inputTokens + outputTokens
                  },
                  text,
                  toolCalls: toolCalls.map((tc: { toolCallId: string; toolName: string; input: unknown }) => ({
                    type: 'tool_use' as const,
                    id: tc.toolCallId,
                    name: tc.toolName,
                    input: tc.input
                  }))
                }
              } as FinishEvent
              break

            case 'error':
              // Normalize error to ensure it has a message
              const rawError = event.error
              const normalizedError = rawError instanceof Error
                ? rawError
                : new Error(
                    typeof rawError === 'string'
                      ? rawError
                      : JSON.stringify(rawError) || 'Unknown streaming error'
                  )
              yield {
                type: 'error',
                data: { error: normalizedError }
              } as ErrorEvent
              break
          }
        }
      } catch (error) {
        // Normalize caught error to ensure it has a message
        const normalizedError = error instanceof Error
          ? error
          : new Error(
              typeof error === 'string'
                ? error
                : JSON.stringify(error) || 'Unknown error during streaming'
            )
        yield {
          type: 'error',
          data: { error: normalizedError }
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
        maxOutputTokens: maxTokens ?? defaults.maxTokens,
        stopSequences
      }

      // 只在模型支持时添加温度
      if (modelConfig?.capabilities.temperature && temperature !== undefined) {
        generateOptions.temperature = temperature
      }

      // 只在模型支持时添加工具
      // SDK 6: strict mode defaults to false per tool
      if (tools && tools.length > 0 && supportsTools(clientConfig.model)) {
        generateOptions.tools = convertTools(tools)
      }

      // Debug: log exact request params to verify maxOutputTokens forwarding
      if (typeof process !== 'undefined' && process.env?.AGENT_FOUNDRY_DEBUG_LLM) {
        console.error('[LLM:debug] generateText params:', JSON.stringify({
          maxOutputTokens: generateOptions.maxOutputTokens,
          temperature: generateOptions.temperature,
          toolCount: generateOptions.tools ? Object.keys(generateOptions.tools).length : 0,
          systemLength: typeof generateOptions.system === 'string' ? generateOptions.system.length : 0,
          messagesCount: generateOptions.messages?.length ?? 0
        }))
      }

      const result = await generateText(generateOptions)

      const toolCalls: ToolUseContent[] = (result.toolCalls || []).map((tc: { toolCallId: string; toolName: string; input: unknown }) => ({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.input
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

      // SDK 6: inputTokens/outputTokens instead of promptTokens/completionTokens
      const inputTokens = result.usage?.inputTokens ?? 0
      const outputTokens = result.usage?.outputTokens ?? 0

      return {
        id: result.response?.id ?? crypto.randomUUID(),
        text: result.text,
        toolCalls,
        finishReason,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens
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
    getLanguageModel(): LanguageModel {
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
