/**
 * PromptCompiler - Prompt Compiler
 */

import type { AgentDefinition } from '../types/agent.js'
import type { ToolRegistry } from './tool-registry.js'
import type { ContextManager } from './context-manager.js'
import type { TokenBudget } from './token-budget.js'
import type { SkillManager } from '../skills/skill-manager.js'
import type { ProviderID } from '../llm/provider.types.js'
import { getProviderStyleNormalization } from '../llm/provider-style.js'
import { countTokens, truncateToTokens } from '../utils/tokenizer.js'

/**
 * Prompt section
 */
export interface PromptSection {
  /** Section ID */
  id: string
  /** Section content */
  content: string
  /** Whether it is protected (never truncated) */
  protected: boolean
  /** Token count */
  tokens?: number
}

/**
 * Compiled Prompt
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
   * Render as a string
   */
  render(): string {
    const result: string[] = []
    let totalTokens = 0

    // First calculate the total tokens of protected sections
    const protectedTokens = this.sections
      .filter(s => s.protected)
      .reduce((sum, s) => sum + (s.tokens ?? 0), 0)

    const remainingBudget = this.maxTokens - protectedTokens

    for (const section of this.sections) {
      if (section.protected) {
        // Protected sections are added directly
        result.push(section.content)
        totalTokens += section.tokens ?? 0
      } else {
        // Non-protected sections check the budget
        const sectionTokens = section.tokens ?? 0
        if (totalTokens + sectionTokens <= this.maxTokens) {
          result.push(section.content)
          totalTokens += sectionTokens
        } else {
          // Try to truncate
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
   * Get the list of sections
   */
  getSections(): PromptSection[] {
    return [...this.sections]
  }

  /**
   * Get total token count
   */
  getTotalTokens(): number {
    return this.sections.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  }

  /**
   * Get the token count of protected sections
   */
  getProtectedTokens(): number {
    return this.sections
      .filter(s => s.protected)
      .reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  }
}

/**
 * Prompt Compiler
 */
export class PromptCompiler {
  /**
   * Compile an Agent definition into a Prompt
   */
  compile(
    agent: AgentDefinition,
    toolRegistry: ToolRegistry,
    contextManager: ContextManager,
    tokenBudget: TokenBudget,
    skillManager?: SkillManager,
    provider?: ProviderID
  ): CompiledPrompt {
    const sections: PromptSection[] = []

    // 1. Identity (never truncated)
    sections.push({
      id: 'identity',
      content: agent.identity.trim(),
      protected: true
    })

    // 1.5. Provider style normalization (non-Anthropic only)
    const styleGuide = provider ? getProviderStyleNormalization(provider) : undefined
    if (styleGuide) {
      sections.push({ id: 'provider-style', content: styleGuide, protected: true })
    }

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

    // 4. Pack Prompt Fragments (can be truncated)
    for (const pack of agent.packs) {
      if (pack.promptFragment) {
        sections.push({
          id: `pack:${pack.id}`,
          content: pack.promptFragment.trim(),
          protected: false
        })
      }
    }

    // 5. Skill Sections (can be truncated, lazy-loaded procedural knowledge)
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

    // 6. Constraints (never truncated)
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
   * Compile a simple system prompt
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
  }, tokenBudget: TokenBudget, provider?: ProviderID): CompiledPrompt {
    const sections: PromptSection[] = []

    if (config.identity) {
      sections.push({
        id: 'identity',
        content: config.identity.trim(),
        protected: true
      })
    }

    // Provider style normalization (non-Anthropic only)
    const styleGuide = provider ? getProviderStyleNormalization(provider) : undefined
    if (styleGuide) {
      sections.push({ id: 'provider-style', content: styleGuide, protected: true })
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
