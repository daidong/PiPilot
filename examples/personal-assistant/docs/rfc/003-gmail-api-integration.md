# RFC-003: Gmail API Integration

**Status**: In Progress
**Author**: Captain
**Date**: 2026-02-01

## 1. Motivation

The personal assistant currently reads emails from a local SQLite database (maintained by ChatMail). However, updates made via the assistant (e.g., marking as read) only change the local DB — they never sync back to Gmail. This means:

- Marking an email as read in the assistant doesn't mark it read in Gmail
- There's no way to send or reply to emails through the assistant
- The assistant is read-only for email, limiting its usefulness

## 2. Design: UNIX Philosophy — SQLite Reads, Gmail Writes

| Operation | Method | Reason |
|-----------|--------|--------|
| Read/query email | Local SQLite (`sqlite_read_query`) | Fast, offline, supports complex queries + FTS5 |
| Mark read/unread, star/unstar | Gmail REST API | Must sync state back to Gmail |
| Send, reply | Gmail REST API (`messages.send`) | Must deliver via Gmail (no direct SMTP — uses the REST API) |
| Delete, trash | **Forbidden** | Guard policy denies — too destructive |

**Key insight**: reads are already fast and reliable via SQLite. Only *write* operations need the Gmail API. After each successful Gmail API call, we also update the local DB (dual-write) to keep it in sync without waiting for the next external sync.

### OAuth Scopes

ChatMail must issue refresh tokens with at least these scopes:

| Scope | Used by |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.modify` | `mark_as_read`, `mark_as_unread`, `star`, `unstar` (label modifications) |
| `https://www.googleapis.com/auth/gmail.send` | `send`, `reply` |
| `https://www.googleapis.com/auth/gmail.readonly` | Already used by ChatMail for sync |

If the refresh token lacks a required scope, the Gmail API will return 403. The tool surfaces this error to the user with a message to re-authorize in ChatMail.

### Token Handling

OAuth tokens are maintained by an external app (ChatMail) in the `accounts` table. The gmail tool is **read-only** on this table — it never writes tokens back.

1. Reads `access_token` and `token_expiry` from accounts
2. If the token looks expired, logs a warning but still attempts the call (ChatMail may have refreshed it since our last DB read)
3. On 401 from Gmail: returns a clear error telling the user to refresh the token in ChatMail
4. The tool never performs token refresh itself — that's ChatMail's responsibility

This keeps a clean separation of concerns: ChatMail owns the OAuth lifecycle, we just consume the token.

## 3. Gmail Tool Actions

### `mark_as_read` / `mark_as_unread`

- Gmail API: `POST /gmail/v1/users/me/messages/{id}/modify` — called per message (sequential loop)
  - `mark_as_read`: `{ removeLabelIds: ['UNREAD'] }`
  - `mark_as_unread`: `{ addLabelIds: ['UNREAD'] }`
- Local DB: `UPDATE messages SET is_read=1/0 WHERE id=?`
- Accepts `message_ids: string[]` of any length — the tool auto-chunks into groups of 25 and processes each message sequentially via `messages/{id}/modify`. For typical assistant usage this is fine. If rate limits become an issue, we can migrate to `users.messages.batchModify` in a future phase.

### `star` / `unstar`

- Gmail API: `POST /gmail/v1/users/me/messages/{id}/modify` — same per-message loop as above
  - `star`: `{ addLabelIds: ['STARRED'] }`
  - `unstar`: `{ removeLabelIds: ['STARRED'] }`
- Local DB: `UPDATE messages SET is_starred=1/0 WHERE id=?`
- Same auto-chunking as mark_as_read/unread.

### `send`

- Gmail API: `POST /gmail/v1/users/me/messages/send`
- Body: base64url-encoded RFC 2822 message
- Parameters: `to`, `cc` (optional), `subject`, `body`
- Safety: requires `confirm: true` to actually send. Without it, returns a preview.
- Dual-write: on success, inserts into the local `outbox` table with `status: 'sent'` so the local DB reflects the sent message immediately. ChatMail's next sync will reconcile the full message record in `messages`.

### `reply`

- Uses the same `messages.send` endpoint but includes:
  - `In-Reply-To` and `References` headers from the original message
  - `threadId` in the Gmail API request body
- Parameters: `thread_id`, `in_reply_to`, `to`, `cc` (optional), `subject`, `body`
- Dual-write: same outbox insert as `send`, with `reply_to_message_id` set.

### Threading / Message-ID Limitation

The local `messages` table does not store the RFC 2822 `Message-ID` header (the `id` column is Gmail's internal ID, not the same thing). This means:

- `In-Reply-To` and `References` headers **cannot** be populated from local data alone.
- The `in_reply_to` parameter is optional. When omitted, Gmail still threads correctly using `threadId` — the reply appears in the right thread, but strict `In-Reply-To` header chaining is absent.
- If precise `In-Reply-To` is needed, we could fetch `message.payload.headers` from the Gmail API for the original message. This is deferred to a future phase.
- **In practice**: Gmail's `threadId` is sufficient for correct threading in the Gmail UI. The missing `Message-ID` only affects third-party clients that rely solely on header-based threading.

## 4. Safety

- **No delete/trash**: A guard policy (`no-gmail-delete`) denies any call with `action: 'delete'` or `action: 'trash'`
- **Send confirmation**: `send` and `reply` actions require `confirm: true`. Without it, the tool returns a draft preview so the user can review before sending.

## 5. Implementation Phases

### Phase A: Label Modifications + Token Refresh

- `gmail-tool.ts` with `mark_as_read`, `mark_as_unread`, `star`, `unstar`
- Token refresh logic (read from accounts, refresh if expired, write back)
- Local DB dual-write after successful API call
- Update coordinator prompt to use gmail tool instead of sqlite_write_query

### Phase B: Send + Reply

- Add `send` and `reply` actions
- RFC 2822 message construction with proper headers
- Confirmation flow (draft preview → confirm)

### Phase C: Guard Policy

- `no-gmail-delete` guard policy
- Wire into coordinator agent config

## 6. Files

| File | Type | Description |
|------|------|-------------|
| `src/agent/tools/gmail-tool.ts` | New | Gmail tool factory |
| `src/agent/policies/no-gmail-delete.ts` | New | Guard policy forbidding delete/trash |
| `src/agent/agents/coordinator.ts` | Modified | Import and register gmail tool + policy |
| `src/agent/agents/prompts/index.ts` | Modified | Add gmail tool docs and update email instructions |
