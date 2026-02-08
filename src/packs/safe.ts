/**
 * safe - Safe core toolkit
 *
 * Features:
 * - No external dependencies
 * - Runs within sandbox
 * - Auditable
 * - Enabled by default
 *
 * Migration to Skills:
 * - Set useSkills: true to use lazy-loaded skills instead of promptFragment
 * - Skills reduce initial token usage by ~60% (50 vs 120 tokens)
 * - Skills load automatically when ctx-get tool is first used
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { read, write, edit, glob, grep, ctxGet, skillCreateTool, skillApproveTool } from '../tools/index.js'
import { noSecretFiles } from '../policies/no-secret-files.js'
import { normalizePathsPolicies } from '../policies/normalize-paths.js'
import { autoLimitRead, autoLimitGrep, autoLimitGlob } from '../policies/auto-limit.js'
import { contextRetrievalSkill, resourcefulPhilosophySkill } from '../skills/builtin/index.js'

/**
 * Safe Pack options
 */
export interface SafePackOptions {
  /**
   * Use Skills instead of promptFragment for token optimization
   * When true, uses lazy-loaded contextRetrievalSkill instead of inline promptFragment
   * @default true
   */
  useSkills?: boolean

  /**
   * Disable resourceful philosophy skill
   * @default false
   */
  disableResourcefulSkill?: boolean
}

/**
 * Safe Pack - Safe core toolkit
 *
 * Included tools:
 * - ctx-get: Unified context entry point
 * - read: Read files
 * - write: Write files
 * - edit: Edit files
 * - glob: File pattern matching
 * - grep: Content search
 *
 * Not included:
 * - bash: Execution capability (moved to execPack)
 * - fetch: Network capability (moved to networkPack)
 * - llm_call: LLM calls (moved to computePack)
 *
 * @param options - Configuration options
 * @param options.useSkills - Use lazy-loaded skill instead of promptFragment (default: true)
 */
export function safe(options: SafePackOptions = {}): Pack {
  const { useSkills = true, disableResourcefulSkill = false } = options

  const tools = [
    ctxGet as any,
    read as any,
    write as any,
    edit as any,
    glob as any,
    grep as any,
    skillCreateTool as any,
    skillApproveTool as any
  ]

  const policies = [
    // Guard: Deny access to sensitive files
    ...noSecretFiles,
    // Mutate: Path normalization
    ...normalizePathsPolicies,
    // Mutate: Auto-limit output size
    autoLimitRead,
    autoLimitGrep,
    autoLimitGlob
  ]

  // Skills-based approach: lazy loading for token optimization
  if (useSkills) {
    const packSkills = disableResourcefulSkill
      ? [contextRetrievalSkill]
      : [contextRetrievalSkill, resourcefulPhilosophySkill]
    const eagerSkills = disableResourcefulSkill ? [] : ['resourceful-philosophy']

    return definePack({
      id: 'safe',
      description: 'Safe core toolkit: ctx-get, read, write, edit, glob, grep, skill-create, skill-approve',
      tools,
      policies,
      skills: packSkills,
      skillLoadingConfig: {
        eager: eagerSkills,
        lazy: ['context-retrieval-skill'] // Loads when ctx-get tool is first used
      }
    })
  }

  // Legacy promptFragment approach (for backward compatibility)
  return definePack({
    id: 'safe',
    description: 'Safe core toolkit: ctx-get, read, write, edit, glob, grep, skill-create, skill-approve',
    tools,
    policies,
    promptFragment: `
## Core Tools Guide

### Context Retrieval
- **ctx-get**: Unified context entry point for structured information
  - Available sources depend on registered packs (session.*, memory.*, docs.*, etc.)
  - Source IDs are listed in the ctx-get tool description

### File Operations
- **read**: Read file content with pagination
- **write**: Write/create files
- **edit**: Edit files (replace specific content)
- **glob**: Match files by pattern
- **grep**: Search content in files

### Best Practices
1. Use glob to find files, then read to view content
2. Use grep to search for specific patterns
3. Use edit for precise modifications, avoid full rewrites
4. Use ctx-get for session history, memory, and documentation
    `.trim()
  })
}

/**
 * Alias: safePack
 */
export const safePack = safe
