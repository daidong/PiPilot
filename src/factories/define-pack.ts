/**
 * definePack - Pack 定义工厂
 */

import type { Pack, PackConfig } from '../types/pack.js'
import type { Tool } from '../types/tool.js'
import type { Policy } from '../types/policy.js'
import type { ContextSource } from '../types/context.js'
import type { Runtime } from '../types/runtime.js'

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

  return {
    id: config.id,
    description: config.description,
    tools: config.tools ?? [],
    policies: config.policies ?? [],
    contextSources: config.contextSources ?? [],
    promptFragment: config.promptFragment,
    dependencies: config.dependencies ?? [],
    onInit: config.onInit,
    onDestroy: config.onDestroy
  }
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
    promptFragment: '',
    dependencies: []
  }

  const toolNames = new Set<string>()
  const policyIds = new Set<string>()
  const sourceIds = new Set<string>()

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
    promptFragment?: string
    dependencies?: string[]
    onInit?: (runtime: Runtime) => Promise<void>
    onDestroy?: (runtime: Runtime) => Promise<void>
  }
): Pack {
  const extended: Pack = {
    id: extension.id ?? base.id,
    description: extension.description ?? base.description,
    tools: [...(base.tools ?? []), ...(extension.tools ?? [])],
    policies: [...(base.policies ?? []), ...(extension.policies ?? [])],
    contextSources: [...(base.contextSources ?? []), ...(extension.contextSources ?? [])],
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
  }
): Pack {
  return {
    ...pack,
    tools: filter.tools ? (pack.tools ?? []).filter(filter.tools) : pack.tools,
    policies: filter.policies ? (pack.policies ?? []).filter(filter.policies) : pack.policies,
    contextSources: filter.contextSources
      ? (pack.contextSources ?? []).filter(filter.contextSources)
      : pack.contextSources
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
