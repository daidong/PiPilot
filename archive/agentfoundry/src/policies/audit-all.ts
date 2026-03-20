/**
 * audit-all - Audit policies
 */

import { defineObservePolicy, defineAlertPolicy } from '../factories/define-policy.js'

/**
 * Audit all tool calls
 */
export const auditAllCalls = defineObservePolicy({
  id: 'audit-all-calls',
  description: 'Record all tool calls',
  priority: 100,
  match: () => true,
  decide: (ctx) => ({
    action: 'observe',
    record: {
      tool: ctx.tool,
      operation: ctx.operation,
      input: ctx.input,
      result: ctx.result,
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      step: ctx.step
    }
  })
})

/**
 * Audit file writes
 */
export const auditFileWrites = defineObservePolicy({
  id: 'audit-file-writes',
  description: 'Record all file write operations',
  priority: 100,
  match: (ctx) => {
    return ctx.tool === 'write' || ctx.tool === 'edit' || ctx.operation === 'writeFile'
  },
  decide: (ctx) => ({
    action: 'observe',
    record: {
      type: 'file_write',
      path: (ctx.input as { path?: string })?.path,
      timestamp: Date.now()
    },
    emit: [{
      event: 'file:write',
      data: {
        path: (ctx.input as { path?: string })?.path,
        sessionId: ctx.sessionId
      }
    }]
  })
})

/**
 * Audit command execution
 */
export const auditCommandExecution = defineObservePolicy({
  id: 'audit-command-execution',
  description: 'Record all command executions',
  priority: 100,
  match: (ctx) => {
    return ctx.tool === 'bash' || ctx.operation === 'exec'
  },
  decide: (ctx) => ({
    action: 'observe',
    record: {
      type: 'command_execution',
      command: (ctx.input as { command?: string })?.command,
      result: ctx.result,
      timestamp: Date.now()
    }
  })
})

/**
 * Error alerts
 */
export const alertOnErrors = defineAlertPolicy({
  id: 'alert-on-errors',
  description: 'Alert when tool execution fails',
  priority: 100,
  match: (ctx) => {
    const result = ctx.result as { success?: boolean } | undefined
    return result?.success === false
  },
  level: 'warn',
  message: (ctx) => {
    const result = ctx.result as { error?: string } | undefined
    return `Tool ${ctx.tool} execution failed: ${result?.error ?? 'Unknown error'}`
  }
})

/**
 * Policy denial alerts
 */
export const alertOnDenied = defineObservePolicy({
  id: 'alert-on-denied',
  description: 'Alert when a policy denies an action',
  priority: 100,
  match: () => true,
  decide: (ctx) => ({
    action: 'observe',
    emit: [{
      event: 'policy:activity',
      data: {
        tool: ctx.tool,
        step: ctx.step,
        timestamp: Date.now()
      }
    }]
  })
})

/**
 * All audit policies
 */
export const auditPolicies = [
  auditAllCalls,
  auditFileWrites,
  auditCommandExecution,
  alertOnErrors,
  alertOnDenied
]
