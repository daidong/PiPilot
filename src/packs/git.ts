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
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

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

const GIT_DEFAULT_CWD_SESSION_KEY = 'git.defaultCwd'
const GIT_DISCOVERY_MAX_DEPTH = 3
const GIT_DISCOVERY_MAX_DIRS = 200
const GIT_DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  '.agentfoundry',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage'
])

function normalizeGitCwd(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function isGitRepoDir(absDir: string): Promise<boolean> {
  try {
    const gitPath = path.join(absDir, '.git')
    const details = await stat(gitPath)
    return details.isDirectory() || details.isFile()
  } catch {
    return false
  }
}

async function discoverNestedGitRepo(projectPath: string): Promise<string | null> {
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: projectPath, rel: '.', depth: 0 }]
  let scannedDirs = 0

  while (queue.length > 0 && scannedDirs < GIT_DISCOVERY_MAX_DIRS) {
    const current = queue.shift()!
    scannedDirs += 1

    if (current.depth > 0 && await isGitRepoDir(current.abs)) {
      return current.rel
    }

    if (current.depth >= GIT_DISCOVERY_MAX_DEPTH) continue

    let entries: Array<{ isDirectory: () => boolean; name: string }>
    try {
      entries = await readdir(current.abs, { withFileTypes: true }) as Array<{ isDirectory: () => boolean; name: string }>
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (GIT_DISCOVERY_SKIP_DIRS.has(entry.name)) continue
      const nextAbs = path.join(current.abs, entry.name)
      const nextRel = current.rel === '.'
        ? entry.name
        : `${current.rel}/${entry.name}`
      queue.push({ abs: nextAbs, rel: nextRel, depth: current.depth + 1 })
    }
  }

  return null
}

async function resolveGitCwd(runtime: { io: { exec: Function }; projectPath: string; sessionState: { get: <T>(key: string) => T | undefined; set: (key: string, value: unknown) => void } }, rawCwd?: unknown): Promise<string> {
  const explicit = normalizeGitCwd(rawCwd)
  if (explicit) {
    runtime.sessionState.set(GIT_DEFAULT_CWD_SESSION_KEY, explicit)
    return explicit
  }

  const remembered = normalizeGitCwd(runtime.sessionState.get<string>(GIT_DEFAULT_CWD_SESSION_KEY))
  if (remembered) return remembered

  const rootProbe = await runtime.io.exec('git rev-parse --is-inside-work-tree', {
    caller: 'git.cwd.probe',
    cwd: '.'
  })
  if (rootProbe.success) {
    runtime.sessionState.set(GIT_DEFAULT_CWD_SESSION_KEY, '.')
    return '.'
  }

  const discovered = await discoverNestedGitRepo(runtime.projectPath)
  if (discovered) {
    runtime.sessionState.set(GIT_DEFAULT_CWD_SESSION_KEY, discovered)
    return discovered
  }

  return '.'
}

/**
 * Git status tool
 */
const gitStatus: Tool = defineTool({
  name: 'git_status',
  description: 'Get Git repository status',
  parameters: {
    cwd: {
      type: 'string',
      description: 'Optional working directory for Git repository (relative to project root)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const cwd = await resolveGitCwd(runtime as Parameters<typeof resolveGitCwd>[0], (input as { cwd?: string } | undefined)?.cwd)
    const result = await runtime.io.exec('git status --short', {
      caller: 'git.status',
      cwd
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        cwd,
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
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for Git repository (relative to project root)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { staged, file, cwd: rawCwd } = input as { staged?: boolean; file?: string; cwd?: string }
    const cwd = await resolveGitCwd(runtime as Parameters<typeof resolveGitCwd>[0], rawCwd)

    let cmd = 'git diff'
    if (staged) cmd += ' --staged'
    if (file) cmd += ` -- ${file}`

    const result = await runtime.io.exec(cmd, { caller: 'git.diff', cwd })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        cwd,
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
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for Git repository (relative to project root)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { files, cwd: rawCwd } = input as { files: string[]; cwd?: string }
    const cwd = await resolveGitCwd(runtime as Parameters<typeof resolveGitCwd>[0], rawCwd)
    const fileList = files.join(' ')

    const result = await runtime.io.exec(`git add ${fileList}`, {
      caller: 'git.add',
      cwd
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true, data: { cwd, added: files } }
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
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for Git repository (relative to project root)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { message, cwd: rawCwd } = input as { message: string; cwd?: string }
    const cwd = await resolveGitCwd(runtime as Parameters<typeof resolveGitCwd>[0], rawCwd)

    // Use heredoc to handle multi-line messages
    const escapedMessage = message.replace(/"/g, '\\"')
    const result = await runtime.io.exec(`git commit -m "${escapedMessage}"`, {
      caller: 'git.commit',
      cwd
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: {
        cwd,
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
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for Git repository (relative to project root)',
      required: false
    }
  },
  execute: async (input, { runtime }) => {
    const { limit, oneline, cwd: rawCwd } = input as { limit?: number; oneline?: boolean; cwd?: string }
    const cwd = await resolveGitCwd(runtime as Parameters<typeof resolveGitCwd>[0], rawCwd)

    let cmd = `git log -${limit ?? 10}`
    if (oneline !== false) cmd += ' --oneline'

    const result = await runtime.io.exec(cmd, { caller: 'git.log', cwd })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      data: { cwd, log: result.data!.stdout }
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
