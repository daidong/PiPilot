/**
 * definePack - Pack 定义工厂
 */

import type { Pack, PackConfig } from '../types/pack.js'
import type { Tool } from '../types/tool.js'
import type { Policy } from '../types/policy.js'
import type { ContextSource } from '../types/context.js'
import type { Runtime } from '../types/runtime.js'
import type { Skill, SkillLoadingConfig } from '../types/skill.js'

/**
 * 定义 Pack
 */
export function definePack(config: PackConfig): Pack {
  // 验证配置
  if (!config.id) {
    throw new Error('Pack id is required')
  }

  if (!config.description) {
    throw new Error('Pack description is required')
  }

  // Warn if using deprecated promptFragment when skills are available
  if (config.promptFragment && config.skills && config.skills.length > 0) {
    console.warn(
      `[definePack] Pack "${config.id}" uses both promptFragment and skills. ` +
      'Consider migrating promptFragment content to skills for token optimization.'
    )
  }

  // Build default skillLoadingConfig if skills provided but no config
  let skillLoadingConfig = config.skillLoadingConfig
  if (config.skills && config.skills.length > 0 && !skillLoadingConfig) {
    skillLoadingConfig = buildDefaultSkillLoadingConfig(config.skills)
  }

  return {
    id: config.id,
    description: config.description,
    tools: config.tools ?? [],
    policies: config.policies ?? [],
    contextSources: config.contextSources ?? [],
    skills: config.skills ?? [],
    skillLoadingConfig,
    promptFragment: config.promptFragment,
    dependencies: config.dependencies ?? [],
    onInit: config.onInit,
    onDestroy: config.onDestroy
  }
}

/**
 * Build default skill loading config based on skill definitions
 */
function buildDefaultSkillLoadingConfig(skills: Skill[]): SkillLoadingConfig {
  const config: SkillLoadingConfig = {
    eager: [],
    lazy: [],
    onDemand: []
  }

  for (const skill of skills) {
    switch (skill.loadingStrategy) {
      case 'eager':
        config.eager!.push(skill.id)
        break
      case 'lazy':
        config.lazy!.push(skill.id)
        break
      case 'on-demand':
        config.onDemand!.push(skill.id)
        break
    }
  }

  return config
}

/**
 * 合并多个 Pack
 */
export function mergePacks(...packs: Pack[]): Pack {
  const merged: Pack = {
    id: packs.map(p => p.id).join('+'),
    description: `Merged pack: ${packs.map(p => p.id).join(', ')}`,
    tools: [],
    policies: [],
    contextSources: [],
    skills: [],
    skillLoadingConfig: {
      eager: [],
      lazy: [],
      onDemand: []
    },
    promptFragment: '',
    dependencies: []
  }

  const toolNames = new Set<string>()
  const policyIds = new Set<string>()
  const sourceIds = new Set<string>()
  const skillIds = new Set<string>()

  for (const pack of packs) {
    // 合并工具（去重）
    for (const tool of pack.tools ?? []) {
      if (!toolNames.has(tool.name)) {
        toolNames.add(tool.name)
        merged.tools!.push(tool)
      }
    }

    // 合并策略（去重）
    for (const policy of pack.policies ?? []) {
      if (!policyIds.has(policy.id)) {
        policyIds.add(policy.id)
        merged.policies!.push(policy)
      }
    }

    // 合并上下文源（去重）
    for (const source of pack.contextSources ?? []) {
      if (!sourceIds.has(source.id)) {
        sourceIds.add(source.id)
        merged.contextSources!.push(source)
      }
    }

    // 合并 Skills（去重）
    for (const skill of pack.skills ?? []) {
      if (!skillIds.has(skill.id)) {
        skillIds.add(skill.id)
        merged.skills!.push(skill)
      }
    }

    // 合并 skill loading config
    if (pack.skillLoadingConfig) {
      for (const id of pack.skillLoadingConfig.eager ?? []) {
        if (!merged.skillLoadingConfig!.eager!.includes(id)) {
          merged.skillLoadingConfig!.eager!.push(id)
        }
      }
      for (const id of pack.skillLoadingConfig.lazy ?? []) {
        if (!merged.skillLoadingConfig!.lazy!.includes(id)) {
          merged.skillLoadingConfig!.lazy!.push(id)
        }
      }
      for (const id of pack.skillLoadingConfig.onDemand ?? []) {
        if (!merged.skillLoadingConfig!.onDemand!.includes(id)) {
          merged.skillLoadingConfig!.onDemand!.push(id)
        }
      }
    }

    // 合并 prompt fragment
    if (pack.promptFragment) {
      merged.promptFragment += '\n\n' + pack.promptFragment
    }

    // 合并依赖
    for (const dep of pack.dependencies ?? []) {
      if (!merged.dependencies!.includes(dep)) {
        merged.dependencies!.push(dep)
      }
    }
  }

  // 创建合并的初始化函数
  const initFns = packs.filter(p => p.onInit).map(p => p.onInit!)
  if (initFns.length > 0) {
    merged.onInit = async (runtime: Runtime) => {
      for (const fn of initFns) {
        await fn(runtime)
      }
    }
  }

  // 创建合并的销毁函数
  const destroyFns = packs.filter(p => p.onDestroy).map(p => p.onDestroy!)
  if (destroyFns.length > 0) {
    merged.onDestroy = async (runtime: Runtime) => {
      for (const fn of destroyFns) {
        await fn(runtime)
      }
    }
  }

  return merged
}

/**
 * 扩展 Pack
 */
export function extendPack(
  base: Pack,
  extension: {
    id?: string
    description?: string
    tools?: Tool[]
    policies?: Policy[]
    contextSources?: ContextSource[]
    skills?: Skill[]
    skillLoadingConfig?: SkillLoadingConfig
    promptFragment?: string
    dependencies?: string[]
    onInit?: (runtime: Runtime) => Promise<void>
    onDestroy?: (runtime: Runtime) => Promise<void>
  }
): Pack {
  // Merge skills with deduplication
  const skillIds = new Set((base.skills ?? []).map(s => s.id))
  const mergedSkills = [...(base.skills ?? [])]
  for (const skill of extension.skills ?? []) {
    if (!skillIds.has(skill.id)) {
      skillIds.add(skill.id)
      mergedSkills.push(skill)
    }
  }

  // Merge skill loading configs
  const mergedSkillLoadingConfig: SkillLoadingConfig = {
    eager: [
      ...(base.skillLoadingConfig?.eager ?? []),
      ...(extension.skillLoadingConfig?.eager ?? [])
    ].filter((v, i, a) => a.indexOf(v) === i),
    lazy: [
      ...(base.skillLoadingConfig?.lazy ?? []),
      ...(extension.skillLoadingConfig?.lazy ?? [])
    ].filter((v, i, a) => a.indexOf(v) === i),
    onDemand: [
      ...(base.skillLoadingConfig?.onDemand ?? []),
      ...(extension.skillLoadingConfig?.onDemand ?? [])
    ].filter((v, i, a) => a.indexOf(v) === i)
  }

  const extended: Pack = {
    id: extension.id ?? base.id,
    description: extension.description ?? base.description,
    tools: [...(base.tools ?? []), ...(extension.tools ?? [])],
    policies: [...(base.policies ?? []), ...(extension.policies ?? [])],
    contextSources: [...(base.contextSources ?? []), ...(extension.contextSources ?? [])],
    skills: mergedSkills,
    skillLoadingConfig: mergedSkillLoadingConfig,
    promptFragment: [base.promptFragment, extension.promptFragment].filter(Boolean).join('\n\n'),
    dependencies: [...new Set([...(base.dependencies ?? []), ...(extension.dependencies ?? [])])]
  }

  // 合并初始化函数
  if (base.onInit || extension.onInit) {
    extended.onInit = async (runtime: Runtime) => {
      if (base.onInit) await base.onInit(runtime)
      if (extension.onInit) await extension.onInit(runtime)
    }
  }

  // 合并销毁函数
  if (base.onDestroy || extension.onDestroy) {
    extended.onDestroy = async (runtime: Runtime) => {
      if (base.onDestroy) await base.onDestroy(runtime)
      if (extension.onDestroy) await extension.onDestroy(runtime)
    }
  }

  return extended
}

/**
 * 过滤 Pack 内容
 */
export function filterPack(
  pack: Pack,
  filter: {
    tools?: (tool: Tool) => boolean
    policies?: (policy: Policy) => boolean
    contextSources?: (source: ContextSource) => boolean
    skills?: (skill: Skill) => boolean
  }
): Pack {
  const filteredSkills = filter.skills
    ? (pack.skills ?? []).filter(filter.skills)
    : pack.skills

  // Update skill loading config to only include filtered skill ids
  const filteredSkillIds = new Set((filteredSkills ?? []).map(s => s.id))
  const filteredSkillLoadingConfig: SkillLoadingConfig | undefined = pack.skillLoadingConfig
    ? {
        eager: (pack.skillLoadingConfig.eager ?? []).filter(id => filteredSkillIds.has(id)),
        lazy: (pack.skillLoadingConfig.lazy ?? []).filter(id => filteredSkillIds.has(id)),
        onDemand: (pack.skillLoadingConfig.onDemand ?? []).filter(id => filteredSkillIds.has(id))
      }
    : undefined

  return {
    ...pack,
    tools: filter.tools ? (pack.tools ?? []).filter(filter.tools) : pack.tools,
    policies: filter.policies ? (pack.policies ?? []).filter(filter.policies) : pack.policies,
    contextSources: filter.contextSources
      ? (pack.contextSources ?? []).filter(filter.contextSources)
      : pack.contextSources,
    skills: filteredSkills,
    skillLoadingConfig: filteredSkillLoadingConfig
  }
}

/**
 * 创建空 Pack
 */
export function createEmptyPack(id: string, description: string): Pack {
  return definePack({
    id,
    description,
    tools: [],
    policies: [],
    contextSources: []
  })
}
