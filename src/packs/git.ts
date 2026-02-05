/**
 * git - Git 操作包
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
 * Git status 工具
 */
const gitStatus: Tool = defineTool({
  name: 'git_status',
  description: '获取 Git 仓库状态',
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
 * Git diff 工具
 */
const gitDiff: Tool = defineTool({
  name: 'git_diff',
  description: '查看 Git 变更',
  parameters: {
    staged: {
      type: 'boolean',
      description: '是否只查看已暂存的变更',
      required: false,
      default: false
    },
    file: {
      type: 'string',
      description: '指定文件路径',
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
 * Git add 工具
 */
const gitAdd: Tool = defineTool({
  name: 'git_add',
  description: '暂存文件',
  parameters: {
    files: {
      type: 'array',
      description: '要暂存的文件列表，使用 "." 表示全部',
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
 * Git commit 工具
 */
const gitCommit: Tool = defineTool({
  name: 'git_commit',
  description: '提交变更',
  parameters: {
    message: {
      type: 'string',
      description: '提交信息',
      required: true
    }
  },
  execute: async (input, { runtime }) => {
    const { message } = input as { message: string }

    // 使用 heredoc 处理多行消息
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
 * Git log 工具
 */
const gitLog: Tool = defineTool({
  name: 'git_log',
  description: '查看提交历史',
  parameters: {
    limit: {
      type: 'number',
      description: '显示的提交数量',
      required: false,
      default: 10
    },
    oneline: {
      type: 'boolean',
      description: '单行显示',
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
 * 禁止强制推送策略
 */
const noForcePush = defineGuardPolicy({
  id: 'no-force-push',
  description: '禁止 git push --force',
  priority: 5,
  match: (ctx) => {
    const cmd = (ctx.input as { command?: string })?.command ?? ''
    return /git\s+push.*--force/.test(cmd)
  },
  decide: () => ({
    action: 'deny',
    reason: '禁止使用 --force 推送'
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
      description: 'Git 操作包：git.status, git.diff, git.add, git.commit, git.log',

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
    description: 'Git 操作包：git.status, git.diff, git.add, git.commit, git.log',

    tools: [
      gitStatus,
      gitDiff,
      gitAdd,
      gitCommit,
      gitLog
    ],

    policies: [noForcePush],

    promptFragment: `
## Git 操作

### 可用工具
- **git.status**: 查看仓库状态
- **git.diff**: 查看变更内容
- **git.add**: 暂存文件
- **git.commit**: 提交变更
- **git.log**: 查看提交历史

### 提交规范
1. 先查看 status 和 diff 确认变更
2. 使用清晰的提交信息
3. 避免大规模提交，按功能拆分
    `.trim()
  })
}
