/**
 * llm-call - LLM 子调用工具
 *
 * 允许工具内进行 LLM 调用，用于查询重写、分类、过滤等任务。
 * 使用与主 Agent 相同的 LLM 客户端。
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface LLMCallInput {
  /** 用户提示 */
  prompt: string
  /** 系统提示（可选） */
  systemPrompt?: string
  /** 最大生成 token 数，默认 1000 */
  maxTokens?: number
  /** 温度参数（0-1），默认不设置（使用模型默认值） */
  temperature?: number
  /** 是否返回 JSON 格式（如果模型支持） */
  jsonMode?: boolean
}

export interface LLMCallOutput {
  /** 生成的文本 */
  text: string
  /** Token 使用情况 */
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 完成原因 */
  finishReason: string
}

export const llmCall: Tool<LLMCallInput, LLMCallOutput> = defineTool({
  name: 'llm-call',
  description: `进行 LLM 子调用，用于文本处理任务如查询重写、分类、摘要、过滤等。
使用与主 Agent 相同的模型和配置。
适用于：
- 查询重写/扩展
- 文本分类
- 相关性判断
- 摘要生成
- 结构化数据提取

注意：此工具会消耗 token，请合理使用。`,
  parameters: {
    prompt: {
      type: 'string',
      description: '用户提示（任务描述和输入数据）',
      required: true
    },
    systemPrompt: {
      type: 'string',
      description: '系统提示（定义 LLM 的角色和行为）',
      required: false
    },
    maxTokens: {
      type: 'number',
      description: '最大生成 token 数，默认 1000',
      required: false,
      default: 1000
    },
    temperature: {
      type: 'number',
      description: '温度参数（0-1），控制输出随机性',
      required: false
    },
    jsonMode: {
      type: 'boolean',
      description: '是否期望返回 JSON 格式',
      required: false,
      default: false
    }
  },
  execute: async (input, { runtime }) => {
    const {
      prompt,
      systemPrompt,
      maxTokens = 1000,
      temperature,
      jsonMode = false
    } = input

    // 检查 LLM 客户端是否可用
    if (!runtime.llmClient) {
      return {
        success: false,
        error: 'LLM client not available in runtime. Make sure the agent is properly configured.'
      }
    }

    try {
      // 记录事件
      runtime.eventBus.emit('tool:llm-call:start', {
        promptLength: prompt.length,
        maxTokens
      })

      // 构建系统提示
      let finalSystemPrompt = systemPrompt || 'You are a helpful assistant.'
      if (jsonMode) {
        finalSystemPrompt += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation, just JSON.'
      }

      // 调用 LLM
      const response = await runtime.llmClient.generate({
        system: finalSystemPrompt,
        messages: [{
          role: 'user',
          content: prompt
        }],
        maxTokens,
        temperature
      })

      // 消耗 token 预算 (使用 'expensive' tier 因为 LLM 调用成本较高)
      runtime.tokenBudget.consume('expensive', response.usage.totalTokens)

      // 记录事件
      runtime.eventBus.emit('tool:llm-call:complete', {
        usage: response.usage,
        finishReason: response.finishReason
      })

      // 如果是 JSON 模式，尝试验证 JSON
      let text = response.text
      if (jsonMode) {
        try {
          // 尝试提取 JSON（处理可能包含的 markdown 代码块）
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
          if (jsonMatch && jsonMatch[1]) {
            text = jsonMatch[1].trim()
          }
          // 验证 JSON 是否有效
          JSON.parse(text)
        } catch {
          // JSON 解析失败，但仍返回原始文本
          runtime.eventBus.emit('tool:llm-call:warning', {
            message: 'JSON mode enabled but response is not valid JSON'
          })
        }
      }

      return {
        success: true,
        data: {
          text,
          usage: response.usage,
          finishReason: response.finishReason
        }
      }
    } catch (error) {
      // 记录错误事件
      runtime.eventBus.emit('tool:llm-call:error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      return {
        success: false,
        error: error instanceof Error ? error.message : 'LLM call failed'
      }
    }
  }
})
