/**
 * Exec Access Policies
 *
 * Generates command execution policies based on permission declarations
 */

import type { Policy, PolicyContext, GuardDecision } from '../types/policy.js'
import { defineGuardPolicy } from '../factories/define-policy.js'

/**
 * Execution policy configuration
 */
export interface ExecPolicyConfig {
  /** Provider ID (used as policy ID prefix) */
  providerId: string
  /** Allowed command patterns */
  allowedCommands?: string[]
  /** Denied command patterns */
  deniedCommands?: string[]
  /** Policy priority */
  priority?: number
}

/**
 * Create a command execution policy
 */
export function createExecPolicy(config: ExecPolicyConfig): Policy {
  const { providerId, allowedCommands, deniedCommands, priority = 15 } = config

  return defineGuardPolicy({
    id: `${providerId}.exec`,
    description: `Command execution control for ${providerId}`,
    priority,
    match: (ctx: PolicyContext) => {
      // Match the bash tool or command execution operations
      return ctx.tool === 'bash' || ctx.operation === 'exec'
    },
    decide: (ctx: PolicyContext): GuardDecision => {
      const input = ctx.input as { command?: string } | undefined
      const command = input?.command

      if (!command) {
        return { action: 'allow' }
      }

      // Extract command name
      const commandName = extractCommandName(command)

      // Check if the command is in the denied list
      if (deniedCommands && matchesCommand(command, commandName, deniedCommands)) {
        return {
          action: 'deny',
          reason: `[${providerId}] Command execution denied: ${commandName}`
        }
      }

      // If an allow list exists, check if the command is within allowed scope
      if (allowedCommands && allowedCommands.length > 0) {
        if (!matchesCommand(command, commandName, allowedCommands)) {
          return {
            action: 'deny',
            reason: `[${providerId}] Command not in allowed list: ${commandName}`
          }
        }
      }

      return { action: 'allow' }
    }
  })
}

/**
 * Extract command name
 */
function extractCommandName(command: string): string {
  // Remove leading whitespace and environment variable assignments
  let cmd = command.trim()

  // Handle env VAR=value command format
  while (cmd.match(/^\w+=\S*\s+/)) {
    cmd = cmd.replace(/^\w+=\S*\s+/, '')
  }

  // Handle prefixes like sudo, time, etc.
  const prefixes = ['sudo', 'time', 'nice', 'nohup', 'env']
  for (const prefix of prefixes) {
    if (cmd.startsWith(prefix + ' ')) {
      cmd = cmd.slice(prefix.length + 1).trim()
    }
  }

  // Extract the first command
  const parts = cmd.split(/\s+/)
  const firstPart = parts[0] ?? ''

  // Remove path, keep only the command name
  const cmdName = firstPart.split('/').pop() ?? firstPart

  return cmdName
}

/**
 * Check if a command matches any pattern
 */
function matchesCommand(
  fullCommand: string,
  commandName: string,
  patterns: string[]
): boolean {
  for (const pattern of patterns) {
    if (matchCommandPattern(fullCommand, commandName, pattern)) {
      return true
    }
  }

  return false
}

/**
 * Match a command pattern
 *
 * Supported patterns:
 * - Exact match: npm
 * - Regex match: /rm\s+-rf/ (enclosed in /)
 * - Wildcard: npm* (matches npm, npx, etc.)
 * - Global wildcard: * (matches all)
 */
function matchCommandPattern(
  fullCommand: string,
  commandName: string,
  pattern: string
): boolean {
  // Global wildcard
  if (pattern === '*') {
    return true
  }

  // Regex match
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const regex = new RegExp(pattern.slice(1, -1), 'i')
      return regex.test(fullCommand)
    } catch {
      return false
    }
  }

  // Wildcard match
  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp('^' + regexPattern + '$', 'i')
    return regex.test(commandName)
  }

  // Exact match
  return commandName.toLowerCase() === pattern.toLowerCase()
}

/**
 * Create execution policies from permission declarations
 */
export function createExecAccessPolicies(
  providerId: string,
  permissions: { allow?: string[]; deny?: string[] } | undefined,
  priority?: number
): Policy[] {
  if (!permissions) {
    return []
  }

  // If there is only a deny list, create a deny policy
  if (permissions.deny && permissions.deny.length > 0 && !permissions.allow) {
    return [
      createExecPolicy({
        providerId,
        deniedCommands: permissions.deny,
        priority
      })
    ]
  }

  // If there is an allow list, create an allow policy
  if (permissions.allow && permissions.allow.length > 0) {
    return [
      createExecPolicy({
        providerId,
        allowedCommands: permissions.allow,
        deniedCommands: permissions.deny,
        priority
      })
    ]
  }

  return []
}
