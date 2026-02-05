/**
 * PromptCompiler - Prompt 编译器
 */

import type { AgentDefinition } from '../types/agent.js'
import type { ToolRegistry } from './tool-registry.js'
import type { ContextManager } from './context-manager.js'
import type { TokenBudget } from './token-budget.js'
import type { SkillManager } from '../skills/skill-manager.js'
import { countTokens, truncateToTokens } from '../utils/tokenizer.js'

/**
 * Prompt 段落
 */
export interface PromptSection {
  /** 段落 ID */
  id: string
  /** 段落内容 */
  content: string
  /** 是否受保护（永不裁剪） */
  protected: boolean
  /** token 数量 */
  tokens?: number
}

/**
 * 编译后的 Prompt
 */
export class CompiledPrompt {
  private sections: PromptSection[]
  private maxTokens: number

  constructor(sections: PromptSection[], _tokenBudget: TokenBudget, maxTokens: number = 8192) {
    this.sections = sections.map(section => ({
      ...section,
      tokens: countTokens(section.content)
    }))
    this.maxTokens = maxTokens
  }

  /**
   * 渲染为字符串
   */
  render(): string {
    const result: string[] = []
    let totalTokens = 0

    // 首先计算受保护段落的总 token
    const protectedTokens = this.sections
      .filter(s => s.protected)
      .reduce((sum, s) => sum + (s.tokens ?? 0), 0)

    const remainingBudget = this.maxTokens - protectedTokens

    for (const section of this.sections) {
      if (section.protected) {
        // 受保护段落直接添加
        result.push(section.content)
        totalTokens += section.tokens ?? 0
      } else {
        // 非保护段落检查预算
        const sectionTokens = section.tokens ?? 0
        if (totalTokens + sectionTokens <= this.maxTokens) {
          result.push(section.content)
          totalTokens += sectionTokens
        } else {
          // 尝试截断
          const available = remainingBudget - (totalTokens - protectedTokens)
          if (available > 100) {
            const truncated = truncateToTokens(section.content, available, 'tail')
            result.push(truncated)
            totalTokens += countTokens(truncated)
          }
        }
      }
    }

    return result.join('\n\n')
  }

  /**
   * 获取段落列表
   */
  getSections(): PromptSection[] {
    return [...this.sections]
  }

  /**
   * 获取总 token 数
   */
  getTotalTokens(): number {
    return this.sections.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  }

  /**
   * 获取受保护段落的 token 数
   */
  getProtectedTokens(): number {
    return this.sections
      .filter(s => s.protected)
      .reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  }
}

/**
 * Prompt 编译器
 */
export class PromptCompiler {
  /**
   * 编译 Agent 定义为 Prompt
   */
  compile(
    agent: AgentDefinition,
    toolRegistry: ToolRegistry,
    contextManager: ContextManager,
    tokenBudget: TokenBudget,
    skillManager?: SkillManager
  ): CompiledPrompt {
    const sections: PromptSection[] = []

    // 1. Identity（永不裁剪）
    sections.push({
      id: 'identity',
      content: agent.identity.trim(),
      protected: true
    })

    // 2. Available Tools
    const toolsSection = `## Available Tools\n\n${toolRegistry.generateCompactToolDescriptions()}`
    sections.push({
      id: 'tools',
      content: toolsSection,
      protected: true
    })

    // 3. Available Context Sources
    const ctxSection = `## Available Context Sources

Use \`ctx.get\` to fetch context when needed.

${contextManager.getAvailableSourcesDescription()}

${agent.contextGuide ?? ''}`

    sections.push({
      id: 'context-sources',
      content: ctxSection.trim(),
      protected: true
    })

    // 4. Pack Prompt Fragments（可裁剪）
    for (const pack of agent.packs) {
      if (pack.promptFragment) {
        sections.push({
          id: `pack:${pack.id}`,
          content: pack.promptFragment.trim(),
          protected: false
        })
      }
    }

    // 5. Skill Sections（可裁剪，懒加载的程序性知识）
    // Phase 1.5: Use skillSection.id directly (SkillManager already adds skill: prefix)
    if (skillManager) {
      const skillSections = skillManager.getPromptSections()
      for (const skillSection of skillSections) {
        sections.push({
          id: skillSection.id,
          content: skillSection.content,
          protected: skillSection.protected
        })
      }
    }

    // 6. Constraints（永不裁剪）
    if (agent.constraints.length > 0) {
      const constraintsSection = `## Constraints

${agent.constraints.map(c => `- ${c}`).join('\n')}`

      sections.push({
        id: 'constraints',
        content: constraintsSection,
        protected: true
      })
    }

    const maxTokens = agent.model?.maxTokens ?? 8192

    return new CompiledPrompt(sections, tokenBudget, maxTokens)
  }

  /**
   * 编译简单的系统提示
   */
  compileSimple(config: {
    identity?: string
    tools?: ToolRegistry
    contextSources?: ContextManager
    constraints?: string[]
    additionalInstructions?: string
    /** Pre-loaded context to include in system prompt */
    initialContext?: string
    /** Skill manager for lazy-loaded procedural knowledge */
    skillManager?: SkillManager
  }, tokenBudget: TokenBudget): CompiledPrompt {
    const sections: PromptSection[] = []

    if (config.identity) {
      sections.push({
        id: 'identity',
        content: config.identity.trim(),
        protected: true
      })
    }

    if (config.tools) {
      sections.push({
        id: 'tools',
        content: `## Available Tools\n\n${config.tools.generateCompactToolDescriptions()}`,
        protected: true
      })
    }

    if (config.contextSources) {
      sections.push({
        id: 'context-sources',
        content: `## Available Context Sources\n\n${config.contextSources.getAvailableSourcesDescription()}`,
        protected: true
      })
    }

    // Pre-loaded context (agent knowledge, cached schema, etc.)
    if (config.initialContext) {
      sections.push({
        id: 'initial-context',
        content: `## Pre-loaded Context\n\n${config.initialContext.trim()}`,
        protected: false  // Can be truncated if too large
      })
    }

    // Skill sections (lazy-loaded procedural knowledge)
    // Phase 1.5: Use skillSection.id directly (SkillManager already adds skill: prefix)
    if (config.skillManager) {
      const skillSections = config.skillManager.getPromptSections()
      for (const skillSection of skillSections) {
        sections.push({
          id: skillSection.id,
          content: skillSection.content,
          protected: skillSection.protected
        })
      }
    }

    if (config.constraints && config.constraints.length > 0) {
      sections.push({
        id: 'constraints',
        content: `## Constraints\n\n${config.constraints.map(c => `- ${c}`).join('\n')}`,
        protected: true
      })
    }

    if (config.additionalInstructions) {
      sections.push({
        id: 'additional',
        content: config.additionalInstructions.trim(),
        protected: false
      })
    }

    return new CompiledPrompt(sections, tokenBudget)
  }
}
