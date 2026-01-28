/**
 * Tools - Built-in tool exports
 *
 * Layered architecture:
 * - safeTools: Core safe tools (enabled by default)
 * - execTools: Execution capability (requires explicit enable)
 * - networkTools: Network capability (requires explicit enable)
 * - computeTools: Compute capability (requires explicit enable)
 * - browserTools: Browser automation (requires explicit enable)
 */

// ============ Tool exports ============

export { read } from './read.js'
export { write } from './write.js'
export { edit } from './edit.js'
export { bash } from './bash.js'
export { glob } from './glob.js'
export { grep } from './grep.js'
export { ctxGet, createCtxGetTool } from './ctx-get.js'
export { ctxExpand } from './ctx-expand.js'
export { fetchTool } from './fetch.js'
export { llmCall } from './llm-call.js'
export { llmExpand } from './llm-expand.js'
export { llmFilter } from './llm-filter.js'
export { browser, browse } from './browser.js'
export { memoryPut } from './memory-put.js'
export { memoryUpdate } from './memory-update.js'
export { memoryDelete } from './memory-delete.js'
export { todoAdd } from './todo-add.js'
export { todoUpdate } from './todo-update.js'
export { todoComplete } from './todo-complete.js'
export { todoRemove } from './todo-remove.js'

// ============ Type exports ============

export type { ReadInput, ReadOutput } from './read.js'
export type { WriteInput, WriteOutput } from './write.js'
export type { EditInput, EditOutput } from './edit.js'
export type { BashInput, BashOutput } from './bash.js'
export type { GlobInput, GlobOutput } from './glob.js'
export type { GrepInput, GrepOutput } from './grep.js'
export type { CtxGetInput, CtxGetOutput, CreateCtxGetOptions, SourceInfo } from './ctx-get.js'
export type { CtxExpandInput, CtxExpandOutput, CtxExpandType } from './ctx-expand.js'
export type { FetchInput, FetchOutput } from './fetch.js'
export type { LLMCallInput, LLMCallOutput } from './llm-call.js'
export type { LLMExpandInput, LLMExpandOutput } from './llm-expand.js'
export type { LLMFilterInput, LLMFilterOutput } from './llm-filter.js'
export type { BrowserInput, BrowserOutput, BrowseInput, BrowseOutput, SnapshotElement } from './browser.js'
export type { MemoryPutInput, MemoryPutOutput } from './memory-put.js'
export type { MemoryUpdateInput, MemoryUpdateOutput } from './memory-update.js'
export type { MemoryDeleteInput, MemoryDeleteOutput } from './memory-delete.js'
export type { TodoAddInput, TodoAddOutput } from './todo-add.js'
export type { TodoUpdateInput, TodoUpdateOutput } from './todo-update.js'
export type { TodoCompleteInput, TodoCompleteOutput } from './todo-complete.js'
export type { TodoRemoveInput, TodoRemoveOutput } from './todo-remove.js'

// ============ Layered tool sets ============

import type { Tool } from '../types/tool.js'
import { read } from './read.js'
import { write } from './write.js'
import { edit } from './edit.js'
import { bash } from './bash.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { ctxGet } from './ctx-get.js'
import { ctxExpand } from './ctx-expand.js'
import { fetchTool } from './fetch.js'
import { llmCall } from './llm-call.js'
import { llmExpand } from './llm-expand.js'
import { llmFilter } from './llm-filter.js'
import { browser, browse } from './browser.js'
import { memoryPut } from './memory-put.js'
import { memoryUpdate } from './memory-update.js'
import { memoryDelete } from './memory-delete.js'
import { todoAdd } from './todo-add.js'
import { todoUpdate } from './todo-update.js'
import { todoComplete } from './todo-complete.js'
import { todoRemove } from './todo-remove.js'

/**
 * Safe core tools (enabled by default)
 *
 * Properties:
 * - No external dependencies
 * - Runs within sandbox
 * - Auditable
 *
 * Contains: ctx-get, ctx-expand, read, write, edit, glob, grep
 */
export const safeTools: Tool<any, any>[] = [
  ctxGet,
  ctxExpand,
  read,
  write,
  edit,
  glob,
  grep
]

/**
 * Execution capability tools (requires explicit enable)
 *
 * Risk level: high
 * Contains: bash
 */
export const execTools: Tool<any, any>[] = [
  bash
]

/**
 * Network capability tools (requires explicit enable)
 *
 * Risk level: elevated
 * Contains: fetch
 */
export const networkTools: Tool<any, any>[] = [
  fetchTool
]

/**
 * Compute capability tools (requires explicit enable)
 *
 * Risk level: elevated (cost-based)
 * Contains: llm-call, llm-expand, llm-filter
 */
export const computeTools: Tool<any, any>[] = [
  llmCall,
  llmExpand,
  llmFilter
]

/**
 * Browser automation tools (requires explicit enable)
 *
 * Risk level: elevated
 * Contains: browser, browse
 */
export const browserTools: Tool<any, any>[] = [
  browser,
  browse
]

/**
 * Memory management tools (requires explicit enable)
 *
 * Risk level: safe
 * Contains: memory-put, memory-update, memory-delete
 */
export const memoryTools: Tool<any, any>[] = [
  memoryPut,
  memoryUpdate,
  memoryDelete
]

/**
 * Todo task tracking tools
 *
 * Risk level: safe
 * Contains: todo-add, todo-update, todo-complete, todo-remove
 */
export const todoTools: Tool<any, any>[] = [
  todoAdd,
  todoUpdate,
  todoComplete,
  todoRemove
]

/**
 * All builtin tools
 */
export const builtinTools: Tool<any, any>[] = [
  ...safeTools,
  ...execTools,
  ...networkTools,
  ...computeTools,
  ...browserTools,
  ...memoryTools,
  ...todoTools
]

/**
 * Get a builtin tool by name
 */
export function getBuiltinTool(name: string): Tool | undefined {
  return builtinTools.find(t => t.name === name)
}

/**
 * Tool risk level
 */
export type ToolRiskLevel = 'safe' | 'elevated' | 'high'

/**
 * Tool metadata
 */
export interface ToolMeta {
  name: string
  riskLevel: ToolRiskLevel
  category: 'safe' | 'exec' | 'network' | 'compute' | 'browser' | 'memory'
  requiresExplicitEnable: boolean
  description: string
}

/**
 * Built-in tool metadata
 */
export const toolMeta: Record<string, ToolMeta> = {
  'ctx-get': {
    name: 'ctx-get',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Get context information'
  },
  'ctx-expand': {
    name: 'ctx-expand',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Expand compressed context from history index'
  },
  read: {
    name: 'read',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Read file contents'
  },
  write: {
    name: 'write',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Write file contents'
  },
  edit: {
    name: 'edit',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Edit file contents'
  },
  glob: {
    name: 'glob',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'File pattern matching'
  },
  grep: {
    name: 'grep',
    riskLevel: 'safe',
    category: 'safe',
    requiresExplicitEnable: false,
    description: 'Content search'
  },
  bash: {
    name: 'bash',
    riskLevel: 'high',
    category: 'exec',
    requiresExplicitEnable: true,
    description: 'Execute shell commands'
  },
  fetch: {
    name: 'fetch',
    riskLevel: 'elevated',
    category: 'network',
    requiresExplicitEnable: true,
    description: 'HTTP requests'
  },
  'llm-call': {
    name: 'llm-call',
    riskLevel: 'elevated',
    category: 'compute',
    requiresExplicitEnable: true,
    description: 'LLM sub-call'
  },
  'llm-expand': {
    name: 'llm-expand',
    riskLevel: 'elevated',
    category: 'compute',
    requiresExplicitEnable: true,
    description: 'LLM text expansion (query rewriting, synonyms, rephrasing)'
  },
  'llm-filter': {
    name: 'llm-filter',
    riskLevel: 'elevated',
    category: 'compute',
    requiresExplicitEnable: true,
    description: 'LLM relevance filtering (scoring and selection)'
  },
  browser: {
    name: 'browser',
    riskLevel: 'elevated',
    category: 'browser',
    requiresExplicitEnable: true,
    description: 'Browser operations'
  },
  browse: {
    name: 'browse',
    riskLevel: 'elevated',
    category: 'browser',
    requiresExplicitEnable: true,
    description: 'Browse web pages'
  },
  'memory-put': {
    name: 'memory-put',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Store a memory item'
  },
  'memory-update': {
    name: 'memory-update',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Update an existing memory item'
  },
  'memory-delete': {
    name: 'memory-delete',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Delete a memory item'
  },
  'todo-add': {
    name: 'todo-add',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Create a new todo item'
  },
  'todo-update': {
    name: 'todo-update',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Update an existing todo item'
  },
  'todo-complete': {
    name: 'todo-complete',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Mark a todo item as done'
  },
  'todo-remove': {
    name: 'todo-remove',
    riskLevel: 'safe',
    category: 'memory',
    requiresExplicitEnable: false,
    description: 'Remove a todo item'
  }
}

/**
 * Get tools by risk level
 */
export function getToolsByRiskLevel(level: ToolRiskLevel): Tool[] {
  return builtinTools.filter(t => toolMeta[t.name]?.riskLevel === level)
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: ToolMeta['category']): Tool[] {
  return builtinTools.filter(t => toolMeta[t.name]?.category === category)
}
