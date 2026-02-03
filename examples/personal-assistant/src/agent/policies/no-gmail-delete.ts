/**
 * No Gmail Delete Policy
 *
 * Guard policy that forbids delete and trash actions on the gmail tool.
 * Email deletion is too destructive and irreversible.
 */

import { defineGuardPolicy } from '@framework/factories/define-policy.js'

export const noGmailDelete = defineGuardPolicy({
  id: 'no-gmail-delete',
  description: 'Forbid email deletion and trashing via Gmail tool',
  match: (ctx) => ctx.tool === 'gmail',
  decide: (ctx) => {
    const action = (ctx.args as Record<string, unknown>)?.action
    if (action === 'delete' || action === 'trash') {
      return { action: 'deny', reason: 'Email deletion is not permitted. Emails can only be read, marked, starred, or replied to.' }
    }
    return { action: 'allow' }
  }
})
