/**
 * audit-all - 审计策略
 */

import { defineObservePolicy, defineAlertPolicy } from '../factories/define-policy.js'

/**
 * 审计所有工具调用
 */
export const auditAllCalls = defineObservePolicy({
  id: 'audit-all-calls',
  description: '记录所有工具调用',
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
 * 审计文件写入
 */
export const auditFileWrites = defineObservePolicy({
  id: 'audit-file-writes',
  description: '记录所有文件写入操作',
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
 * 审计命令执行
 */
export const auditCommandExecution = defineObservePolicy({
  id: 'audit-command-execution',
  description: '记录所有命令执行',
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
 * 错误告警
 */
export const alertOnErrors = defineAlertPolicy({
  id: 'alert-on-errors',
  description: '工具执行失败时告警',
  priority: 100,
  match: (ctx) => {
    const result = ctx.result as { success?: boolean } | undefined
    return result?.success === false
  },
  level: 'warn',
  message: (ctx) => {
    const result = ctx.result as { error?: string } | undefined
    return `工具 ${ctx.tool} 执行失败: ${result?.error ?? 'Unknown error'}`
  }
})

/**
 * 策略拒绝告警
 */
export const alertOnDenied = defineObservePolicy({
  id: 'alert-on-denied',
  description: '策略拒绝时告警',
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
 * 所有审计策略
 */
export const auditPolicies = [
  auditAllCalls,
  auditFileWrites,
  auditCommandExecution,
  alertOnErrors,
  alertOnDenied
]
