/**
 * Gmail Skill
 *
 * Procedural knowledge for Gmail operations:
 * - Email database schema (ChatMail SQLite)
 * - Gmail API operations (mark, star, send, reply)
 * - Safety policies (no deletion)
 * - Query best practices
 *
 * Migrated from:
 * - coordinator-module-email (~500 tokens)
 * - gmail-tool description (~100 tokens)
 * - no-gmail-delete policy context (~50 tokens)
 *
 * Total before: ~650 tokens (always loaded)
 * After: ~80 tokens (summary) → ~500 tokens (full, lazy loaded)
 */

import { defineSkill } from '../../../../src/skills/define-skill.js'
import type { Skill } from '../../../../src/types/skill.js'

/**
 * Gmail Skill
 *
 * Comprehensive guidance for email operations via Gmail API
 * with local SQLite database for efficient querying.
 */
export const gmailSkill: Skill = defineSkill({
  id: 'gmail-skill',
  name: 'Gmail Operations',
  shortDescription: 'Email read via SQLite, write via Gmail API; no deletion permitted',

  instructions: {
    summary: `Gmail integration guidance:
- **Read**: Use sqlite_read_query on ChatMail DB (messages, contacts, groups tables)
- **Write**: Use gmail tool for mark_as_read, star, send, reply (confirm required for send/reply)
- **Safety**: Deletion/trash is NOT permitted
- **Query Rules**: Always use LIMIT, never SELECT *, use messages_fts for full-text search`,

    procedures: `
## ChatMail Database Schema

### Tables
\`\`\`sql
accounts(id, email, display_name, avatar_url, access_token, refresh_token,
         token_expiry, signature, last_sync_history_id, created_at, updated_at)

messages(id, gmail_thread_id, account_id, from_email, from_name, subject,
         snippet, body_text, body_html, internal_date, is_read, is_starred,
         is_sent_by_me, is_multi_recipient, original_to, original_cc,
         forwarded_to, is_tracked, tracked_at, is_fully_downloaded, created_at)

contacts(id, email, display_name, avatar_url, account_id, last_message_at,
         unread_count, is_muted, is_pinned, created_at)

conversation_messages(contact_id, message_id)

groups(id, gmail_thread_id, account_id, subject, participants,
       group_created_at, last_message_at, unread_count, is_muted, is_pinned, created_at)

group_messages(group_id, message_id)

attachments(id, message_id, filename, mime_type, size, local_path, is_downloaded)

outbox(id, account_id, to_recipients, cc_recipients, subject, body_html,
       reply_to_message_id, is_reply_all, status, error_message, retry_count, created_at)

messages_fts  -- Full-text search virtual table
\`\`\`

### Data Conventions
- **Timestamps**: Unix milliseconds; use \`datetime(internal_date/1000, 'unixepoch')\`
- **Booleans**: 0/1 integers
- **Email addresses**: Always lowercase
- **JSON fields**: original_to, original_cc, participants, to_recipients, cc_recipients
- **Message IDs**: messages.id is the native Gmail ID

## Query Best Practices

### MUST Follow
1. **Always use LIMIT** - Never unbounded queries
2. **Never SELECT *** - Specify columns needed
3. **Use sqlite_read_query** for all SELECT operations

### Full-Text Search
\`\`\`sql
SELECT m.id, m.subject, m.from_email, m.snippet
FROM messages m
JOIN messages_fts fts ON m.id = fts.rowid
WHERE messages_fts MATCH 'search term'
ORDER BY bm25(messages_fts, 10.0, 1.0, 5.0, 5.0)
LIMIT 20;
\`\`\`

BM25 weights: subject (10.0), from (1.0), snippet (5.0), body (5.0)

### Summarizing Emails
When displaying emails, include:
- Sender (from_email, from_name)
- Subject
- Date (formatted from internal_date)
- Snippet (first ~100 chars)

## Gmail Actions

### Supported Operations
| Action | Description | Confirm Required |
|--------|-------------|------------------|
| mark_as_read | Mark messages as read | No |
| mark_as_unread | Mark messages as unread | No |
| star | Add star to messages | No |
| unstar | Remove star from messages | No |
| send | Send new email | **Yes** |
| reply | Reply to message | **Yes** |

### Safety Policy
- ❌ **Deletion is NOT permitted** - No trash, no delete
- ❌ Attempting delete/trash will be blocked by policy
- ✅ Emails can only be read, marked, starred, or replied to

### Send/Reply with Confirmation
\`\`\`json
{
  "action": "send",
  "to": "recipient@example.com",
  "cc": "cc1@example.com,cc2@example.com",
  "subject": "Subject line",
  "body": "Plain text body content",
  "account_email": "myaccount@gmail.com",
  "confirm": true
}
\`\`\`

### Reply Parameters
For reply action, use \`thread_id\` + \`in_reply_to\`:
- \`thread_id\`: Gmail thread ID to reply in
- \`in_reply_to\`: Message-ID header (optional, helps threading)
- \`to\`: Recipient email(s), comma-separated
- \`body\`: Plain text reply content

### Batch Operations
- Multiple message_ids can be provided
- Auto-chunks to 25 messages per API call
- Respects Gmail API rate limits

## Token Management

### Token Expiry Handling
- Check \`token_expiry\` before operations
- If 401 error → ask user to refresh token in ChatMail app
- Tokens stored securely in accounts table

### Common Errors
| Error | Meaning | Action |
|-------|---------|--------|
| 401 | Token expired | Ask user to re-authenticate in ChatMail |
| 403 | Insufficient permissions | Check OAuth scopes |
| 429 | Rate limited | Wait and retry |
`,

    examples: `
## Query: Unread Emails

\`\`\`sql
SELECT m.id, m.from_name, m.from_email, m.subject,
       datetime(m.internal_date/1000, 'unixepoch') as date,
       m.snippet
FROM messages m
WHERE m.is_read = 0
ORDER BY m.internal_date DESC
LIMIT 10;
\`\`\`

## Query: Search Emails by Keyword

\`\`\`sql
SELECT m.id, m.subject, m.from_email, m.snippet
FROM messages m
JOIN messages_fts fts ON m.id = fts.rowid
WHERE messages_fts MATCH 'project deadline'
ORDER BY bm25(messages_fts, 10.0, 1.0, 5.0, 5.0)
LIMIT 20;
\`\`\`

## Query: Recent Emails from Contact

\`\`\`sql
SELECT m.id, m.subject, m.snippet,
       datetime(m.internal_date/1000, 'unixepoch') as date
FROM messages m
WHERE m.from_email = 'colleague@company.com'
ORDER BY m.internal_date DESC
LIMIT 5;
\`\`\`

## Action: Mark as Read

\`\`\`json
{
  "tool": "gmail",
  "input": {
    "action": "mark_as_read",
    "message_ids": ["18abc123def", "18abc456ghi"]
  }
}
\`\`\`

## Action: Send Email (with confirmation)

\`\`\`json
{
  "tool": "gmail",
  "input": {
    "action": "send",
    "to": "recipient@example.com",
    "cc": "cc1@example.com,cc2@example.com",
    "subject": "Meeting Follow-up",
    "body": "Thanks for the meeting today.\\n\\nBest regards",
    "account_email": "myaccount@gmail.com",
    "confirm": true
  }
}
\`\`\`

## Action: Reply to Thread

\`\`\`json
{
  "tool": "gmail",
  "input": {
    "action": "reply",
    "thread_id": "18abc123def",
    "in_reply_to": "<original-message-id@mail.gmail.com>",
    "to": "sender@example.com",
    "body": "Thanks for the update. I will review and get back to you.",
    "confirm": true
  }
}
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "Token expired" or 401 errors
- Tokens expire periodically
- Ask user to open ChatMail app and re-authenticate
- The app will refresh the token automatically

### "No results" for email search
- Check spelling in search terms
- Use full-text search with messages_fts
- Try broader search terms
- Verify emails exist in local sync

### "Query too slow"
- Add LIMIT clause (required)
- Use specific columns instead of SELECT *
- Add indexes for frequently queried columns
- Use messages_fts for text search instead of LIKE

### "Send/reply failed"
- Verify confirm: true is set
- Check recipient email format (comma-separated for multiple)
- Body should be plain text (not HTML)
- For reply, use thread_id + in_reply_to (not message_id)
- Verify account has send permissions

### "Can't delete emails"
- Deletion is intentionally blocked
- Use mark_as_read or archive via ChatMail UI
- This is a safety feature, not a bug

### "Missing email body"
- Check is_fully_downloaded flag
- Some emails may only have snippet synced
- Request full download if needed
`
  },

  tools: ['gmail', 'sqlite_read_query'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 80,
    full: 1100
  },

  tags: ['email', 'gmail', 'sqlite', 'communication']
})

export default gmailSkill
