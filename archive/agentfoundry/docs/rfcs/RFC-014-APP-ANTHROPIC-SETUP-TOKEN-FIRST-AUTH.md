# RFC-014: App-Layer Anthropic Setup-Token-First Authentication (Deprecated)
## Research Pilot + Personal Assistant (Historical Plan)

Status: Deprecated (Historical)  
Author: AgentFoundry Team  
Created: 2026-02-07  
Updated: 2026-02-09

> Deprecation Note (2026-02-09): This RFC is kept for historical context only.  
> The setup-token-first design described below has been removed from active app code.  
> Current behavior in `research-pilot-desktop` and `personal-assistant` is **API Key only** for Anthropic models (`ANTHROPIC_API_KEY`), with no setup-token storage, setup modal, or setup-token fallback path.

---

## 0. Current Effective Behavior (Replaces This RFC)

1. Anthropic models use `ANTHROPIC_API_KEY` only.
2. OpenAI models use `OPENAI_API_KEY` only.
3. UI model selector shows `API Key Only` for both providers.
4. Cost/token panels no longer branch on setup-token mode.
5. `examples/shared/anthropic-auth/*` has been removed.

The remaining sections in this document describe the prior proposal and are no longer normative.

---

## 1. Executive Summary

This RFC defines an app-layer authentication path for Anthropic models:

1. Prefer `setup-token` by default.
2. Fallback to `ANTHROPIC_API_KEY` when token is missing or invalid.
3. Trigger setup-token login flow on first Anthropic model selection when token is unavailable.
4. Detect token revocation/expiry and guide re-login automatically.
5. Split usage/cost accounting by auth mode (`setup-token` vs `api-key`).
6. Implement one shared app-layer module and reuse it across both desktop apps.

Scope is limited to desktop apps:

1. `examples/research-pilot-desktop`
2. `examples/personal-assistant`

No framework-level default behavior is changed in this RFC.

---

## 2. Motivation

Current app behavior has three gaps:

1. Credential selection is not provider-aware.
2. Anthropic setup-token is not integrated into model selection flow.
3. Billing/cost display does not distinguish API-key billing vs non-API auth modes.

Operationally, this causes friction:

1. Users must manage API keys even when setup-token should be primary.
2. Token invalidation is discovered late and unclearly.
3. Cost panel can show misleading values when auth mode is not API-key based.

---

## 3. Design Principles

1. App-layer only: avoid changing kernel/framework default provider behavior.
2. Explicit mode: each Anthropic request resolves one auth mode (`setup-token` or `api-key`).
3. Safe fallback: auth failures degrade predictably instead of silently breaking chat.
4. User-visible state: UI always shows current Anthropic auth source and health.
5. Accurate billing semantics: only API-key mode contributes dollar estimates.

---

## 4. Scope

In scope:

1. Setup-token storage, retrieval, validation, and status in each app.
2. First-time Anthropic model selection checks and guided setup.
3. Anthropic request-time credential resolution with fallback chain.
4. Auth failure classification and relogin prompting.
5. Cost/usage panel split by auth mode.

Out of scope:

1. Adding setup-token as a generic AgentFoundry framework credential mode.
2. Migrating old auth files or compatibility with old app-local secret formats.
3. Supporting cookie/session-token scraping logic in framework core.

---

## 5. Terminology

1. `setup-token`: Anthropic credential obtained through explicit setup flow and persisted by app.
2. `api-key`: standard `ANTHROPIC_API_KEY`.
3. `authMode`: resolved mode for a request (`setup-token` | `api-key` | `none`).
4. `authStatus`: health state for stored setup-token (`unknown` | `valid` | `invalid` | `missing`).

---

## 6. High-Level Architecture (Historical / Deprecated)

Shared module design:

1. Put shared implementation under `examples/shared/anthropic-auth/`.
2. Keep Framework core (`src/`) unchanged.
3. Each app keeps a thin adapter in its own `main/ipc.ts` + preload + UI store.

Shared `AnthropicAuthManager` responsibilities:

1. Credential persistence
2. Model-selection gate checks
3. Request-time auth resolution
4. Error-based invalidation and reauth trigger

Core flow:

1. User selects an Anthropic model.
2. App checks stored setup-token status.
3. If missing, run setup flow before chat continues (or allow skip to API key).
4. On each Anthropic request, app resolves `authMode` deterministically:
   - setup-token valid -> use setup-token
   - else api-key present -> use api-key
   - else -> auth-required UI
5. On auth error, app marks setup-token invalid, prompts re-login, and optionally retries with API key.

---

## 7. Storage and Security (Historical / Deprecated)

## 7.1 Storage Targets

Per app project root:

1. `.research-pilot-v2/auth/anthropic.json`
2. `.personal-assistant-v2/auth/anthropic.json`

Schema:

```json
{
  "provider": "anthropic",
  "mode": "setup-token",
  "tokenRef": "keychain://anthropic/setup-token/<projectId>",
  "status": "valid",
  "lastValidatedAt": "2026-02-07T12:00:00.000Z",
  "lastError": null,
  "updatedAt": "2026-02-07T12:00:00.000Z"
}
```

Token value is stored in OS keychain (or secure store), not plaintext project files.

## 7.2 Secret Handling Rules

1. Never log raw setup-token.
2. Never expose token via renderer IPC response payloads.
3. Main process only handles token read/write.
4. Renderer receives only `authMode`, `authStatus`, and user-safe metadata.

---

## 8. UX Flows (Historical / Deprecated)

## 8.1 First Anthropic Model Selection

When user selects Anthropic model and no valid setup-token exists:

1. Show `Anthropic Setup Required` modal.
2. Provide two options:
   - Setup token now (recommended)
   - Use API key fallback (if available)
3. If setup succeeds, persist token and continue with selected model.
4. If user cancels and no API key exists, keep model switch pending and show actionable error.

## 8.2 App Restart

No repeated setup needed if stored token status is valid.

At startup:

1. Load auth metadata.
2. Lazy-validate on first Anthropic request (or optional background ping).
3. If invalid, prompt re-login at first usage.

## 8.3 Token Revoked/Expired Mid-Usage

On classified auth failure:

1. Mark setup-token `invalid`.
2. Show toast/banner with `Re-authenticate Anthropic`.
3. If API key exists, offer one-click fallback for current run.
4. Keep model selection unchanged; only auth source changes.

---

## 9. Request Path and Fallback (Historical / Deprecated)

## 9.1 Resolver

`resolveAnthropicCredential(model, projectContext)`:

1. Ensure `model` is Anthropic family; otherwise return `not-applicable`.
2. If setup-token exists and status != invalid, return `setup-token`.
3. Else if `ANTHROPIC_API_KEY` exists, return `api-key`.
4. Else return `none`.

## 9.2 Retry Policy

For Anthropic requests in `setup-token` mode:

1. First auth failure -> classify.
2. If auth invalid and API key exists:
   - one automatic retry with API key allowed
   - emit telemetry `auth_fallback_triggered`
3. If still fails or no API key:
   - surface auth action required

No infinite retries.

---

## 10. Error Classification (Historical / Deprecated)

Auth invalidation requires strict classifier:

1. HTTP status 401/403 and provider-auth error code/message.
2. Known invalid token phrases (`unauthorized`, `invalid token`, `authentication failed`).

Do not invalidate token for:

1. 429 rate limit
2. network timeout/reset
3. 5xx transient provider error

Classifier output:

```json
{
  "isAuthInvalid": true,
  "reason": "401 unauthorized",
  "retryableWithApiKey": true
}
```

---

## 11. Billing and Cost Accounting (Historical / Deprecated)

## 11.1 Usage Data

Always record usage tokens if provider returns them:

1. prompt/input tokens
2. completion/output tokens
3. cache-related token fields when available

## 11.2 Dollar Cost Rules

1. `authMode=api-key`: compute dollar estimates normally.
2. `authMode=setup-token`: do not compute dollar estimates in API billing panel.

UI should display:

1. `Billing Source: API Key` or `Billing Source: Setup Token`
2. `Cost: n/a (setup-token mode)` when applicable.

This avoids false precision in API bill estimation for non-API-key auth modes.

---

## 12. Implementation Plan (Historical / Deprecated)

## 12.1 Shared App-Layer Modules

Add one shared module under `examples/shared/anthropic-auth/`:

1. `anthropic-auth-manager.ts`
2. `anthropic-auth-types.ts`
3. `anthropic-auth-classifier.ts`

Capabilities:

1. `getAuthStatus(projectId)`
2. `setupToken(projectId, tokenInput)`
3. `invalidateToken(projectId, reason)`
4. `resolveCredential(projectId, model)`
5. `onProviderError(projectId, error)`

## 12.2 IPC + Preload

Expose minimal safe APIs:

1. `auth.getAnthropicStatus()`
2. `auth.startAnthropicSetup()`
3. `auth.saveAnthropicSetupToken(token)`
4. `auth.clearAnthropicSetupToken()`
5. `auth.retryWithApiKey()`

No raw token returned to renderer.

## 12.3 Coordinator Integration

In each app coordinator initialization:

1. Replace provider-agnostic `apiKey` selection with model-aware resolver.
2. For Anthropic model, inject resolved credential into `createAgent` config.
3. Carry `authMode` into chat result metadata for UI + telemetry.

## 12.4 Renderer Integration

1. Model selector hook:
   - if Anthropic selected and token missing/invalid -> show setup gate modal
2. Status indicator near model display:
   - `Anthropic: setup-token`
   - `Anthropic: api-key fallback`
   - `Anthropic: auth required`
3. Error toast/action:
   - `Token invalid. Re-authenticate` / `Use API key once`

## 12.5 Cost Panel Integration

1. Attach `authMode` to each run usage record.
2. Branch cost display logic by `authMode`.
3. Keep token usage charts independent from dollar charts.

---

## 13. App-Specific Change Map (Historical / Deprecated)

Research Pilot Desktop:

1. Consume shared module from `examples/shared/anthropic-auth/`.
2. `examples/research-pilot-desktop/src/main/ipc.ts` thin adapter + wiring.
3. `examples/research-pilot-desktop/src/main/preload/index.ts` thin bridge.
4. `examples/research-pilot-desktop/src/renderer/stores/ui-store.ts` status + modal state.
5. chat/model selector components and cost panel components.

Personal Assistant:

1. Consume shared module from `examples/shared/anthropic-auth/`.
2. `examples/personal-assistant/src/main/ipc.ts` thin adapter + wiring.
3. `examples/personal-assistant/src/main/preload/index.ts` thin bridge.
4. `examples/personal-assistant/src/renderer/stores/ui-store.ts` status + modal state.
5. chat/model selector components and cost panel components.

---

## 14. Telemetry and Logging (Historical / Deprecated)

Add app logs (stderr + file, aligned with current recommendation):

1. `auth_mode_resolved`
2. `auth_setup_started`
3. `auth_setup_succeeded`
4. `auth_setup_failed`
5. `auth_token_invalidated`
6. `auth_fallback_triggered`

Log fields:

1. `app`
2. `projectId`
3. `model`
4. `authMode`
5. `reasonCode`
6. `runId`

Never include token values.

---

## 15. Rollout Strategy (Historical / Deprecated)

Phase 1:

1. Implement resolver + status UI + setup modal.
2. Keep API key fallback enabled by default.

Phase 2:

1. Enable auth invalidation classifier and retry path.
2. Add cost-panel mode split.

Phase 3:

1. Harden telemetry and edge-case UX.
2. Add integration tests for restart and revocation scenarios.

---

## 16. Test Plan (Historical / Deprecated)

Core test matrix:

1. Anthropic model + valid setup-token -> succeeds in setup-token mode.
2. Anthropic model + missing token + API key -> fallback path works.
3. Anthropic model + missing token + no API key -> setup required error.
4. Token revoked -> classifier marks invalid, prompts reauth.
5. Revoked token + API key present -> one retry with API key works.
6. Restart app with valid token -> no repeated setup prompt.
7. Cost panel in setup-token mode -> token usage visible, dollar cost hidden.
8. Non-Anthropic model -> unaffected behavior.

---

## 17. Risks and Mitigations (Historical / Deprecated)

1. False auth invalidation:
   - mitigate with strict classifier and no invalidation on 429/5xx/timeouts.
2. Secret leakage risk:
   - main-process only secret handling + redacted logs.
3. User confusion on billing:
   - explicit billing source label in UI.
4. Dual-mode complexity:
   - deterministic resolver and single automatic retry cap.

---

## 18. Acceptance Criteria (Historical / Deprecated)

This RFC is complete when all are true:

1. Anthropic model selection triggers setup-token gate on missing token.
2. Anthropic request path defaults to setup-token if valid.
3. API key fallback is functional and explicit.
4. Token revocation is detected and user is prompted to reauthenticate.
5. Cost panel behavior is mode-aware and no longer shows always-zero due to misclassification.
6. Both Research Pilot Desktop and Personal Assistant pass the test matrix.

---

## 19. Open Decisions (Historical / Deprecated)

1. Background validation timing:
   - lazy on first request only, or startup background ping.
2. Auto-retry policy:
   - one retry with API key (recommended default) vs manual-only.
3. Setup UX:
   - direct token paste only, or optional helper command launcher.
