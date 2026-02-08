/**
 * git - Git operations pack
 *
 * Migration to Skills:
 * - Set useSkills: true to use lazy-loaded skills instead of promptFragment
 * - Skills reduce initial token usage by ~75% (50 vs 200 tokens)
 * - Skills load automatically when git_* tools are first used
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { defineTool } from '../factories/define-tool.js'
import { defineGuardPolicy } from '../factories/define-policy.js'
import type { Tool } from '../types/tool.js'
import { gitWorkflowSkill } from '../skills/builtin/index.js'

/**
 * Git Pack options
 */
export interface GitPackOptions {
  /**
   * Use Skills instead of promptFragment for token optimization
   * When true, uses lazy-loaded gitWorkflowSkill instead of inline promptFragment
   * @default true
   */
  useSkills?: boolean
}

/**
 * Git status tool
 */
const gitStatus: Tool = defineTool({
  name: 'git_status',
  description: 'Get Git repository status',
  parameters: {},
  execute: async (_, { runtime }) => {
    const result = await runtime.io.exec('git status --short', {
      caller: 'git.status'
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        output: result.data!.stdout,
        hasChanges: result.data!.stdout.trim().length > 0
      }
    }
  }
})

/**
 * Git diff tool
 */
const gitDiff: Tool = defineTool({
  name: 'git_diff',
  description: 'View Git changes',
  parameters: {
    staged: {
      type: 'boolean',
      description: 'Whether to show only staged changes',
      required: false,
      default: false
    },
    file: {
      type: 'string',
      description: 'Specify file path',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { staged, file } = input as { staged?: boolean; file?: string }

    let cmd = 'git diff'
    if (staged) cmd += ' --staged'
    if (file) cmd += ` -- ${file}`

    const result = await runtime.io.exec(cmd, { caller: 'git.diff' })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        diff: result.data!.stdout,
        isEmpty: result.data!.stdout.trim().length === 0
      }
    }
  }
})

/**
 * Git add tool
 */
const gitAdd: Tool = defineTool({
  name: 'git_add',
  description: 'Stage files',
  parameters: {
    files: {
      type: 'array',
      description: 'List of files to stage, use "." for all',
      required: true,
      items: { type: 'string' }
    }
  },
  execute: async (input, { runtime }) => {
    const { files } = input as { files: string[] }
    const fileList = files.join(' ')

    const result = await runtime.io.exec(`git add ${fileList}`, {
      caller: 'git.add'
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true, data: { added: files } }
  }
})

/**
 * Git commit tool
 */
const gitCommit: Tool = defineTool({
  name: 'git_commit',
  description: 'Commit changes',
  parameters: {
    message: {
      type: 'string',
      description: 'Commit message',
      required: true
    }
  },
  execute: async (input, { runtime }) => {
    const { message } = input as { message: string }

    // Use heredoc to handle multi-line messages
    const escapedMessage = message.replace(/"/g, '\\"')
    const result = await runtime.io.exec(`git commit -m "${escapedMessage}"`, {
      caller: 'git.commit'
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        output: result.data!.stdout,
        committed: true
      }
    }
  }
})

/**
 * Git log tool
 */
const gitLog: Tool = defineTool({
  name: 'git_log',
  description: 'View commit history',
  parameters: {
    limit: {
      type: 'number',
      description: 'Number of commits to display',
      required: false,
      default: 10
    },
    oneline: {
      type: 'boolean',
      description: 'Display in single-line format',
      required: false,
      default: true
    }
  },
  execute: async (input, { runtime }) => {
    const { limit, oneline } = input as { limit?: number; oneline?: boolean }

    let cmd = `git log -${limit ?? 10}`
    if (oneline !== false) cmd += ' --oneline'

    const result = await runtime.io.exec(cmd, { caller: 'git.log' })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: { log: result.data!.stdout }
    }
  }
})

/**
 * Deny force push policy
 */
const noForcePush = defineGuardPolicy({
  id: 'no-force-push',
  description: 'Deny git push --force',
  priority: 5,
  match: (ctx) => {
    const cmd = (ctx.input as { command?: string })?.command ?? ''
    return /git\s+push.*--force/.test(cmd)
  },
  decide: () => ({
    action: 'deny',
    reason: 'Force push with --force is not allowed'
  })
})

/**
 * Git Pack
 *
 * Provides Git operations with optional Skills-based guidance.
 *
 * @param options - Configuration options
 * @param options.useSkills - Use lazy-loaded skill instead of promptFragment (default: true)
 */
export function git(options: GitPackOptions = {}): Pack {
  const { useSkills = true } = options

  // Skills-based approach: lazy loading for token optimization
  if (useSkills) {
    return definePack({
      id: 'git',
      description: 'Git operations pack: git.status, git.diff, git.add, git.commit, git.log',

      tools: [
        gitStatus,
        gitDiff,
        gitAdd,
        gitCommit,
        gitLog
      ],

      policies: [noForcePush],

      skills: [gitWorkflowSkill],
      skillLoadingConfig: {
        lazy: ['git-workflow-skill'] // Loads when git_* tools are first used
      }
    })
  }

  // Legacy promptFragment approach (for backward compatibility)
  return definePack({
    id: 'git',
    description: 'Git operations pack: git.status, git.diff, git.add, git.commit, git.log',

    tools: [
      gitStatus,
      gitDiff,
      gitAdd,
      gitCommit,
      gitLog
    ],

    policies: [noForcePush],

    promptFragment: `
## Git Operations

### Available Tools
- **git.status**: View repository status
- **git.diff**: View changes
- **git.add**: Stage files
- **git.commit**: Commit changes
- **git.log**: View commit history

### Commit Guidelines
1. Check status and diff to review changes before committing
2. Use clear, descriptive commit messages
3. Avoid large commits; split by feature
    `.trim()
  })
}
