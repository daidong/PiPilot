/**
 * exec - Execution capability pack (high risk)
 *
 * Features:
 * - Requires explicit enablement
 * - Enforced policy constraints
 * - Configurable allowlist/denylist
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineApprovalPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { bash } from '../tools/index.js'
import { noDestructive, requireApprovalForDestructive } from '../policies/no-destructive.js'
import { auditCommandExecution } from '../policies/audit-all.js'

/**
 * Exec Pack configuration options
 */
export interface ExecPackOptions {
  /**
   * Allowed command prefixes (allowlist mode)
   * If set, only matching commands can be executed
   */
  allowCommands?: string[]

  /**
   * Denied command patterns (denylist mode)
   * Includes dangerous commands by default
   */
  denyPatterns?: RegExp[]

  /**
   * Whether user approval is required
   * - 'none': No approval needed
   * - 'dangerous': Dangerous commands require approval (default)
   * - 'all': All commands require approval
   */
  approvalMode?: 'none' | 'dangerous' | 'all'

  /**
   * Execution timeout in milliseconds
   * Default: 60000
   */
  timeout?: number

  /**
   * Allowed working directories (cwd)
   * If set, execution is restricted to these directories
   */
  allowedCwd?: string[]
}

/**
 * Create an allowlist policy
 */
function createAllowlistPolicy(allowCommands: string[]): Policy {
  return defineGuardPolicy({
    id: 'exec:allowlist',
    description: 'Only allow execution of allowlisted commands',
    priority: 5,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      const allowed = allowCommands.some(prefix =>
        command.trim().startsWith(prefix)
      )
      if (!allowed) {
        return {
          action: 'deny',
          reason: `Command not in allowlist: ${command.slice(0, 50)}...`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create a denylist policy
 */
function createDenylistPolicy(denyPatterns: RegExp[]): Policy {
  return defineGuardPolicy({
    id: 'exec:denylist',
    description: 'Deny execution of denylisted commands',
    priority: 10,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      for (const pattern of denyPatterns) {
        if (pattern.test(command)) {
          return {
            action: 'deny',
            reason: `Command is denied: ${command.slice(0, 50)}...`
          }
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create an approve-all policy
 */
function createAllApprovalPolicy(): Policy {
  return defineApprovalPolicy({
    id: 'exec:approval-all',
    description: 'All bash commands require approval',
    priority: 15,
    match: (ctx) => ctx.tool === 'bash',
    message: (ctx) => {
      const command = (ctx.input as { command?: string })?.command ?? ''
      return `Confirm execution of command: ${command}`
    },
    timeout: 60000
  })
}

/**
 * Create a cwd restriction policy
 */
function createCwdPolicy(allowedCwd: string[]): Policy {
  return defineGuardPolicy({
    id: 'exec:cwd-restrict',
    description: 'Restrict the working directory for command execution',
    priority: 8,
    match: (ctx) => ctx.tool === 'bash',
    decide: (ctx) => {
      const cwd = (ctx.input as { cwd?: string })?.cwd
      if (cwd) {
        const allowed = allowedCwd.some(dir =>
          cwd.startsWith(dir) || cwd === dir
        )
        if (!allowed) {
          return {
            action: 'deny',
            reason: `Working directory not allowed: ${cwd}`
          }
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Exec Pack - Execution capability pack
 *
 * Included tools:
 * - bash: Execute shell commands
 *
 * Default policies:
 * - Deny dangerous commands (rm -rf, DROP TABLE, etc.)
 * - Dangerous operations require user approval
 * - Audit all command executions
 */
export function exec(options: ExecPackOptions = {}): Pack {
  const {
    allowCommands,
    denyPatterns,
    approvalMode = 'dangerous',
    allowedCwd
  } = options

  const policies: Policy[] = []

  // Allowlist policy (highest priority)
  if (allowCommands && allowCommands.length > 0) {
    policies.push(createAllowlistPolicy(allowCommands))
  }

  // Denylist policy
  if (denyPatterns && denyPatterns.length > 0) {
    policies.push(createDenylistPolicy(denyPatterns))
  } else {
    // Default: use built-in dangerous command blocking policy
    policies.push(noDestructive)
  }

  // CWD restriction policy
  if (allowedCwd && allowedCwd.length > 0) {
    policies.push(createCwdPolicy(allowedCwd))
  }

  // Approval policy
  if (approvalMode === 'all') {
    policies.push(createAllApprovalPolicy())
  } else if (approvalMode === 'dangerous') {
    policies.push(requireApprovalForDestructive)
  }

  // Audit policy
  policies.push(auditCommandExecution)

  return definePack({
    id: 'exec',
    description: 'Execution capability pack: bash command execution (requires explicit enablement)',

    tools: [bash as any],

    policies,

    promptFragment: `
## Command Execution Capabilities

### bash Tool
Execute shell commands for:
- Running build scripts
- Running tests
- Installing dependencies
- Git operations

### Security Restrictions
${allowCommands ? `- Allowed only: ${allowCommands.join(', ')}` : '- Dangerous commands are denied (rm -rf, DROP TABLE, etc.)'}
${approvalMode !== 'none' ? `- ${approvalMode === 'all' ? 'All commands' : 'Dangerous commands'} require user approval` : ''}
${allowedCwd ? `- Execution is only allowed in the following directories: ${allowedCwd.join(', ')}` : ''}

### Best Practices
1. Use absolute paths or an explicit cwd
2. Avoid composing complex piped commands
3. Set a reasonable timeout
    `.trim()
  })
}

/**
 * Alias: execPack
 */
export const execPack = exec

/**
 * Preset: Strict mode (only allows safe commands)
 */
export function execStrict(): Pack {
  return exec({
    allowCommands: [
      'ls', 'cat', 'head', 'tail', 'wc',
      'git status', 'git log', 'git diff', 'git branch',
      'npm list', 'npm outdated',
      'node --version', 'npm --version',
      'pwd', 'echo', 'date'
    ],
    approvalMode: 'all'
  })
}

/**
 * Preset: Development mode (allows common development commands)
 */
export function execDev(): Pack {
  return exec({
    allowCommands: [
      'npm', 'npx', 'yarn', 'pnpm',
      'git', 'node', 'tsc', 'tsx',
      'ls', 'cat', 'head', 'tail', 'wc',
      'mkdir', 'cp', 'mv',
      'pwd', 'echo', 'date', 'which'
    ],
    denyPatterns: [
      /\brm\s+(-[rf]+\s+)?(\/|~)/,  // Deny deleting root directory or home
      /\bsudo\b/,
      /\bchmod\s+777/,
      /\b(curl|wget)\s+.*\|\s*(sh|bash)/  // Deny curl | bash
    ],
    approvalMode: 'dangerous'
  })
}
