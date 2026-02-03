/**
 * Gmail Tool
 *
 * Provides write operations to Gmail via the REST API (mark read/unread,
 * star/unstar, send, reply). Reads stay on local SQLite. Deletion is
 * forbidden by policy.
 *
 * DB access uses the MCP sqlite tools already registered in the runtime
 * (sqlite_read_query / sqlite_write_query) — no native `better-sqlite3`
 * import, so this works correctly inside Electron's main process.
 *
 * Token assumption: an external app (e.g. ChatMail) maintains OAuth tokens
 * in the `accounts` table. This tool only reads tokens — it never writes
 * to the accounts table. If the token is expired or invalid, the tool
 * reports the error so the user can refresh via the external app.
 */

import { defineTool } from '@framework/factories/define-tool.js'
import type { ToolContext } from '@framework/types/tool.js'

// ============================================================================
// Constants
// ============================================================================

/** Maximum message IDs per Gmail API chunk to avoid rate limits. */
const CHUNK_SIZE = 25

// ============================================================================
// Types
// ============================================================================

interface AccountToken {
  email: string
  access_token: string
}

interface GmailApiResponse {
  ok: boolean
  status: number
  data?: any
  error?: string
}

// ============================================================================
// SQLite helpers (via MCP tools in runtime)
// ============================================================================

async function sqlRead(ctx: ToolContext, query: string): Promise<any[]> {
  const result = await ctx.runtime.toolRegistry.call('sqlite_read_query', { query }, ctx)
  if (!result.success) {
    throw new Error(`sqlite_read_query failed: ${result.error}`)
  }
  // MCP sqlite server returns rows as JSON.stringify(rows) inside data.text
  const data = result.data as { text?: string } | undefined
  if (!data?.text) return []
  try {
    const parsed = JSON.parse(data.text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function sqlWrite(ctx: ToolContext, query: string): Promise<void> {
  const result = await ctx.runtime.toolRegistry.call('sqlite_write_query', { query }, ctx)
  if (!result.success) {
    throw new Error(`sqlite_write_query failed: ${result.error}`)
  }
}

/** Escape a string value for use in SQL (single-quote escaping). */
function esc(v: string): string {
  return v.replace(/'/g, "''")
}

/** Split an array into chunks of at most `size` elements. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

// ============================================================================
// Token Management (read-only — never writes to accounts table)
// ============================================================================

/**
 * Read access_token from accounts table. We assume the external app
 * (ChatMail) keeps it fresh. If it's expired or missing, we report the
 * error clearly so the user knows to refresh in ChatMail.
 */
async function getToken(ctx: ToolContext, accountEmail?: string): Promise<AccountToken> {
  const where = accountEmail
    ? `WHERE email = '${esc(accountEmail)}'`
    : 'ORDER BY created_at ASC LIMIT 1'
  const rows = await sqlRead(ctx,
    `SELECT email, access_token, token_expiry FROM accounts ${where}`
  )

  const row = rows[0] as { email: string; access_token: string; token_expiry: number } | undefined
  if (!row) {
    throw new Error(
      accountEmail
        ? `No account found for ${accountEmail}. Add the account in ChatMail first.`
        : 'No accounts found in database. Add a Gmail account in ChatMail first.'
    )
  }

  if (!row.access_token) {
    throw new Error(`Account ${row.email} has no access token. Re-authorize in ChatMail.`)
  }

  // Stop if token is expired — ChatMail needs to refresh it first
  if (row.token_expiry && row.token_expiry < Date.now()) {
    throw new Error(
      `Access token for ${row.email} is expired (expired at ${new Date(row.token_expiry).toISOString()}). ` +
      'Please open ChatMail to refresh the token, then try again.'
    )
  }

  return { email: row.email, access_token: row.access_token }
}

// ============================================================================
// Gmail API Wrapper
// ============================================================================

async function callGmailApi(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<GmailApiResponse> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    ...(body && { body: JSON.stringify(body) })
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Gmail token expired or revoked. Please refresh the token in ChatMail and try again.' }
    }
    return { ok: false, status: res.status, error: `Gmail API error (${res.status}): ${text}` }
  }

  const data = res.status === 204 ? null : await res.json()
  return { ok: true, status: res.status, data }
}

// ============================================================================
// RFC 2822 Message Builder
// ============================================================================

function buildRfc2822Message(opts: {
  from: string
  to: string
  cc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}): string {
  const lines: string[] = []
  lines.push(`From: ${opts.from}`)
  lines.push(`To: ${opts.to}`)
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  lines.push(`Subject: ${opts.subject}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references) lines.push(`References: ${opts.references}`)
  lines.push('')
  lines.push(opts.body)
  return lines.join('\r\n')
}

/** Base64url encode (no padding) per Gmail API requirements. */
function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ============================================================================
// Outbox Dual-Write
// ============================================================================

/**
 * Insert a record into the local outbox table after a successful send/reply
 * so the local DB reflects the sent message immediately.
 */
async function insertOutbox(
  ctx: ToolContext,
  accountId: string,
  to: string,
  cc: string | undefined,
  subject: string,
  body: string,
  replyToMessageId: string | undefined,
  status: string
) {
  const id = crypto.randomUUID()
  const toRecipients = JSON.stringify(
    to.split(',').map(e => ({ email: e.trim(), name: '' }))
  )
  const ccRecipients = cc
    ? JSON.stringify(cc.split(',').map(e => ({ email: e.trim(), name: '' })))
    : 'NULL'
  const replyCol = replyToMessageId ? `'${esc(replyToMessageId)}'` : 'NULL'

  await sqlWrite(ctx,
    `INSERT INTO outbox (id, account_id, to_recipients, cc_recipients, subject, body_html, reply_to_message_id, status, created_at)
     VALUES ('${esc(id)}', '${esc(accountId)}', '${esc(toRecipients)}', ${ccRecipients === 'NULL' ? 'NULL' : `'${esc(ccRecipients)}'`}, '${esc(subject)}', '${esc(body)}', ${replyCol}, '${esc(status)}', ${Date.now()})`
  )
}

// ============================================================================
// Tool Factory
// ============================================================================

export function createGmailTool(_emailDbPath: string) {
  return defineTool({
    name: 'gmail',
    description:
      'Perform Gmail write operations: mark_as_read, mark_as_unread, star, unstar, send, reply. ' +
      'Accepts any number of message_ids — auto-chunks internally. ' +
      'Email reads use sqlite_read_query. Deletion is not permitted.',
    parameters: {
      action: {
        type: 'string',
        description: 'Action: mark_as_read, mark_as_unread, star, unstar, send, reply',
        required: true
      },
      message_ids: {
        type: 'array',
        description: 'Gmail message IDs for mark/star actions. Any count accepted — auto-chunked internally.',
        required: false
      },
      to: {
        type: 'string',
        description: 'Recipient email(s), comma-separated. Required for send/reply.',
        required: false
      },
      cc: {
        type: 'string',
        description: 'CC recipients, comma-separated. Optional for send/reply.',
        required: false
      },
      subject: {
        type: 'string',
        description: 'Email subject. Required for send, optional for reply.',
        required: false
      },
      body: {
        type: 'string',
        description: 'Email body (plain text). Required for send/reply.',
        required: false
      },
      thread_id: {
        type: 'string',
        description: 'Gmail thread ID for reply action.',
        required: false
      },
      in_reply_to: {
        type: 'string',
        description: 'Message-ID header of the email being replied to (optional — Gmail threads correctly via thread_id alone).',
        required: false
      },
      confirm: {
        type: 'boolean',
        description: 'Set to true to actually send. Without it, send/reply returns a preview.',
        required: false
      },
      account_email: {
        type: 'string',
        description: 'Account email to use. Defaults to first account.',
        required: false
      }
    },
    execute: async (input: {
      action: string
      message_ids?: string[]
      to?: string
      cc?: string
      subject?: string
      body?: string
      thread_id?: string
      in_reply_to?: string
      confirm?: boolean
      account_email?: string
    }, context: ToolContext) => {
      const { action, message_ids, to, cc, subject, body, thread_id, in_reply_to, confirm, account_email } = input

      try {
        const account = await getToken(context, account_email)

        // ----- Mark as read / unread -----
        if (action === 'mark_as_read' || action === 'mark_as_unread') {
          if (!message_ids || message_ids.length === 0) {
            return { success: false, error: 'message_ids required for mark_as_read/mark_as_unread' }
          }

          const isRead = action === 'mark_as_read'
          const labelChange = isRead
            ? { removeLabelIds: ['UNREAD'] }
            : { addLabelIds: ['UNREAD'] }

          const chunks = chunk(message_ids, CHUNK_SIZE)
          let okCount = 0
          let failCount = 0
          const failures: string[] = []

          for (const batch of chunks) {
            for (const msgId of batch) {
              const res = await callGmailApi(account.access_token, 'POST', `messages/${msgId}/modify`, labelChange)
              if (!res.ok) {
                failCount++
                failures.push(`${msgId}: ${res.error}`)
                // Stop early on auth errors — all subsequent calls will fail too
                if (res.status === 401) {
                  return { success: false, error: res.error, data: { ok: okCount, failed: failCount + (message_ids.length - okCount - failCount) } }
                }
              } else {
                await sqlWrite(context,
                  `UPDATE messages SET is_read = ${isRead ? 1 : 0} WHERE id = '${esc(msgId)}'`
                )
                okCount++
              }
            }
          }

          return {
            success: failCount === 0,
            data: {
              action,
              total: message_ids.length,
              ok: okCount,
              failed: failCount,
              ...(failures.length > 0 && { failures })
            }
          }
        }

        // ----- Star / Unstar -----
        if (action === 'star' || action === 'unstar') {
          if (!message_ids || message_ids.length === 0) {
            return { success: false, error: 'message_ids required for star/unstar' }
          }

          const isStar = action === 'star'
          const labelChange = isStar
            ? { addLabelIds: ['STARRED'] }
            : { removeLabelIds: ['STARRED'] }

          const chunks = chunk(message_ids, CHUNK_SIZE)
          let okCount = 0
          let failCount = 0
          const failures: string[] = []

          for (const batch of chunks) {
            for (const msgId of batch) {
              const res = await callGmailApi(account.access_token, 'POST', `messages/${msgId}/modify`, labelChange)
              if (!res.ok) {
                failCount++
                failures.push(`${msgId}: ${res.error}`)
                if (res.status === 401) {
                  return { success: false, error: res.error, data: { ok: okCount, failed: failCount + (message_ids.length - okCount - failCount) } }
                }
              } else {
                await sqlWrite(context,
                  `UPDATE messages SET is_starred = ${isStar ? 1 : 0} WHERE id = '${esc(msgId)}'`
                )
                okCount++
              }
            }
          }

          return {
            success: failCount === 0,
            data: {
              action,
              total: message_ids.length,
              ok: okCount,
              failed: failCount,
              ...(failures.length > 0 && { failures })
            }
          }
        }

        // ----- Send -----
        if (action === 'send') {
          if (!to || !subject || !body) {
            return { success: false, error: 'to, subject, and body are required for send' }
          }

          if (!confirm) {
            return {
              success: true,
              data: {
                action: 'send_preview',
                from: account.email,
                to,
                cc: cc || undefined,
                subject,
                body,
                message: 'This is a preview. Call again with confirm: true to send.'
              }
            }
          }

          const raw = base64urlEncode(buildRfc2822Message({
            from: account.email,
            to,
            cc,
            subject,
            body
          }))

          const res = await callGmailApi(account.access_token, 'POST', 'messages/send', { raw })
          if (!res.ok) {
            return { success: false, error: res.error }
          }

          // Dual-write: insert into outbox so local DB reflects the sent message
          await insertOutbox(context, account.email, to, cc, subject, body, undefined, 'sent')

          return { success: true, data: { action: 'sent', messageId: res.data?.id, threadId: res.data?.threadId } }
        }

        // ----- Reply -----
        if (action === 'reply') {
          if (!to || !body) {
            return { success: false, error: 'to and body are required for reply' }
          }

          if (!confirm) {
            return {
              success: true,
              data: {
                action: 'reply_preview',
                from: account.email,
                to,
                cc: cc || undefined,
                subject: subject || '(Re: ...)',
                body,
                thread_id,
                in_reply_to,
                message: 'This is a preview. Call again with confirm: true to send.'
              }
            }
          }

          const raw = base64urlEncode(buildRfc2822Message({
            from: account.email,
            to,
            cc,
            subject: subject || '',
            body,
            inReplyTo: in_reply_to,
            references: in_reply_to
          }))

          const apiBody: Record<string, unknown> = { raw }
          if (thread_id) apiBody.threadId = thread_id

          const res = await callGmailApi(account.access_token, 'POST', 'messages/send', apiBody)
          if (!res.ok) {
            return { success: false, error: res.error }
          }

          // Dual-write: insert into outbox with reply metadata
          await insertOutbox(context, account.email, to, cc, subject || '', body, in_reply_to, 'sent')

          return { success: true, data: { action: 'replied', messageId: res.data?.id, threadId: res.data?.threadId } }
        }

        return { success: false, error: `Unknown action: ${action}. Valid: mark_as_read, mark_as_unread, star, unstar, send, reply` }
      } catch (err: any) {
        return { success: false, error: err.message || String(err) }
      }
    }
  })
}
