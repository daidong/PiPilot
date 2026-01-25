/**
 * repo.git - Git 状态上下文源
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'

export interface RepoGitParams {
  includeLog?: boolean
  logLimit?: number
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export interface GitLog {
  hash: string
  message: string
  author: string
  date: string
}

export interface RepoGitData {
  status: GitStatus
  log?: GitLog[]
  isGitRepo: boolean
}

/**
 * 解析 git status 输出
 */
function parseGitStatus(output: string): Partial<GitStatus> {
  const lines = output.split('\n')
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []
  let branch = 'unknown'
  let ahead = 0
  let behind = 0

  for (const line of lines) {
    // 解析分支信息
    if (line.startsWith('## ')) {
      const branchMatch = line.match(/^## (\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/)
      if (branchMatch) {
        branch = branchMatch[1] ?? 'unknown'
        if (branchMatch[3]) {
          const aheadMatch = branchMatch[3].match(/ahead (\d+)/)
          const behindMatch = branchMatch[3].match(/behind (\d+)/)
          if (aheadMatch) ahead = parseInt(aheadMatch[1]!, 10)
          if (behindMatch) behind = parseInt(behindMatch[1]!, 10)
        }
      }
      continue
    }

    if (line.length < 3) continue

    const status = line.slice(0, 2)
    const file = line.slice(3)

    if (status[0] !== ' ' && status[0] !== '?') {
      staged.push(file)
    }
    if (status[1] !== ' ' && status[1] !== '?') {
      unstaged.push(file)
    }
    if (status === '??') {
      untracked.push(file)
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked }
}

/**
 * 解析 git log 输出
 */
function parseGitLog(output: string): GitLog[] {
  const logs: GitLog[] = []
  const entries = output.split('\n---\n')

  for (const entry of entries) {
    const lines = entry.trim().split('\n')
    if (lines.length >= 3) {
      logs.push({
        hash: lines[0] ?? '',
        author: lines[1] ?? '',
        date: lines[2] ?? '',
        message: lines.slice(3).join(' ').trim()
      })
    }
  }

  return logs
}

export const repoGit: ContextSource<RepoGitParams, RepoGitData> = defineContextSource({
  id: 'repo.git',
  kind: 'index',
  description: 'Get Git repository status including branch, staged/unstaged changes, and recent commits.',
  shortDescription: 'Get Git status and recent commits',
  resourceTypes: ['exec'],
  params: [
    { name: 'includeLog', type: 'boolean', required: false, description: 'Include recent commit log', default: false },
    { name: 'logLimit', type: 'number', required: false, description: 'Number of commits to include', default: 5 }
  ],
  examples: [
    { description: 'Get current status', params: {}, resultSummary: 'Branch, staged, unstaged files' },
    { description: 'Include recent commits', params: { includeLog: true, logLimit: 10 }, resultSummary: 'Status + last 10 commits' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 30 * 1000
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<RepoGitData>> => {
    const startTime = Date.now()
    const operations: { type: string; target: string; traceId: string }[] = []

    // 检查是否是 git 仓库
    const checkResult = await runtime.io.exec('git rev-parse --git-dir', {
      caller: 'ctx.get:repo.git'
    })

    if (!checkResult.success) {
      return createSuccessResult(
        { status: { branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }, isGitRepo: false },
        'Not a git repository',
        {
          provenance: { operations: [], durationMs: Date.now() - startTime }
        }
      )
    }

    // 获取 status
    const statusResult = await runtime.io.exec('git status --porcelain=v2 --branch', {
      caller: 'ctx.get:repo.git'
    })

    if (!statusResult.success) {
      return createErrorResult(statusResult.error ?? 'Failed to get git status', Date.now() - startTime)
    }

    operations.push({ type: 'exec', target: 'git status', traceId: statusResult.traceId })

    const status = parseGitStatus(statusResult.data!.stdout)

    // 获取 log（如果请求）
    let log: GitLog[] | undefined
    if (params?.includeLog) {
      const logLimit = params.logLimit ?? 5
      const logResult = await runtime.io.exec(
        `git log -${logLimit} --format="%h%n%an%n%ar%n%s%n---"`,
        { caller: 'ctx.get:repo.git' }
      )

      if (logResult.success) {
        operations.push({ type: 'exec', target: 'git log', traceId: logResult.traceId })
        log = parseGitLog(logResult.data!.stdout)
      }
    }

    // 渲染
    const lines = [
      `# Git Status`,
      '',
      `**Branch:** ${status.branch}`,
      status.ahead ? `**Ahead:** ${status.ahead} commits` : '',
      status.behind ? `**Behind:** ${status.behind} commits` : '',
      ''
    ]

    if (status.staged && status.staged.length > 0) {
      lines.push('**Staged:**')
      lines.push(...status.staged.slice(0, 10).map(f => `  - ${f}`))
      if (status.staged.length > 10) {
        lines.push(`  ... (${status.staged.length - 10} more)`)
      }
      lines.push('')
    }

    if (status.unstaged && status.unstaged.length > 0) {
      lines.push('**Unstaged:**')
      lines.push(...status.unstaged.slice(0, 10).map(f => `  - ${f}`))
      if (status.unstaged.length > 10) {
        lines.push(`  ... (${status.unstaged.length - 10} more)`)
      }
      lines.push('')
    }

    if (status.untracked && status.untracked.length > 0) {
      lines.push('**Untracked:**')
      lines.push(...status.untracked.slice(0, 5).map(f => `  - ${f}`))
      if (status.untracked.length > 5) {
        lines.push(`  ... (${status.untracked.length - 5} more)`)
      }
      lines.push('')
    }

    if (log && log.length > 0) {
      lines.push('**Recent commits:**')
      for (const entry of log) {
        lines.push(`  - \`${entry.hash}\` ${entry.message} (${entry.author}, ${entry.date})`)
      }
    }

    return createSuccessResult(
      {
        status: status as GitStatus,
        log,
        isGitRepo: true
      },
      lines.filter(Boolean).join('\n'),
      {
        provenance: {
          operations,
          durationMs: Date.now() - startTime
        },
        coverage: { complete: true }
      }
    )
  }
})
