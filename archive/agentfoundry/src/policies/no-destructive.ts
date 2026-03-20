/**
 * no-destructive - Prohibit dangerous commands policy
 */

import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * Dangerous command patterns
 */
const DESTRUCTIVE_PATTERNS = [
  // Delete operations
  /\brm\s+(-[rf]+\s+)?[\/\w]/,
  /\brmdir\b/,
  /\bdel\b/,
  /\brd\b/,

  // Database operations
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)/i,
  /\bTRUNCATE\s+TABLE/i,
  /\bDELETE\s+FROM\s+\w+\s*$/i, // DELETE without WHERE

  // System operations
  /\bformat\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,

  // Dangerous Git operations
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[fd]/,

  // Permission operations
  /\bchmod\s+777/,
  /\bchown\s+-R/
]

/**
 * Prohibit dangerous commands policy
 */
export const noDestructive = defineGuardPolicy({
  id: 'no-destructive',
  description: 'Prohibit execution of dangerous destructive commands',
  priority: 10,
  match: (ctx) => {
    return ctx.tool === 'bash' || ctx.operation === 'exec'
  },
  decide: (ctx) => {
    const command = (ctx.input as { command?: string })?.command ??
                    (ctx.params as { command?: string })?.command ?? ''

    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        return {
          action: 'deny',
          reason: `Dangerous command blocked: ${command.slice(0, 50)}...`
        }
      }
    }

    return { action: 'allow' }
  }
})

/**
 * Dangerous operations requiring approval (more lenient than noDestructive)
 */
export const requireApprovalForDestructive = defineGuardPolicy({
  id: 'require-approval-destructive',
  description: 'Dangerous commands require user approval',
  priority: 20,
  match: (ctx) => {
    return ctx.tool === 'bash' || ctx.operation === 'exec'
  },
  decide: (ctx) => {
    const command = (ctx.input as { command?: string })?.command ??
                    (ctx.params as { command?: string })?.command ?? ''

    // Command patterns that require approval
    const needsApproval = [
      /\brm\b/,
      /\bgit\s+push/,
      /\bnpm\s+publish/,
      /\bsudo\b/
    ]

    for (const pattern of needsApproval) {
      if (pattern.test(command)) {
        return {
          action: 'require_approval',
          message: `Confirmation required to execute this command: ${command}`,
          timeout: 30000
        }
      }
    }

    return { action: 'allow' }
  }
})
