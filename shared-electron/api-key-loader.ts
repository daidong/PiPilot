/**
 * Pure logic for the API-key priority rule. Extracted out of ipc-base.ts
 * so tests can import it without pulling in `electron` (which top-level
 * imports `shell`, fatal under plain Node).
 *
 * Priority: **config wins over env**. A value explicitly saved through
 * the Settings UI is the user's authoritative intent and overwrites
 * whatever the launching shell exported. Shell env stays as the
 * fallback for unconfigured keys / CI / scripted launches.
 *
 * To opt back to env-as-source for one launch, clear the saved value
 * in the Settings UI so the config slot is empty — env then takes over
 * via the no-else branch below.
 *
 * Background: shipping v1 with the opposite priority (env > config)
 * caused a silent footgun. A user who saved fresh AWS keys in
 * Settings → Compute → AWS would still get stale shell-exported keys
 * on the next launch, because the loader skipped loading from disk
 * when env was already set. Symptom for AWS Phase 1: Test connection
 * showed three green checks (the stale key was also a valid AWS key,
 * just for a different account), but RunInstances reported the IAM
 * instance profile as "Invalid" — RP was talking to a different AWS
 * account than the user's CLI. See `docs/rfc/009` Phase 1 design
 * note "v2 priority" for the longer rationale.
 */

/**
 * Allowlist of env-var names that the Settings UI's saveApiKey IPC may
 * write. Centralized here so adding a new key is a one-line change.
 * Keep this in lockstep with the UI's input lists in
 * app/src/renderer/components/settings/*.
 */
export const API_KEY_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'BRAVE_API_KEY',
  'OPENROUTER_API_KEY',
  'PAPERCLIP_API_KEY',
  'DEEPSEEK_API_KEY',
  'SEMANTIC_SCHOLAR_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  // RFC-009 §3.1: AWS shared credentials. Provider env-fallback picks
  // these up; settings JSON only carries region + profile.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
] as const

export type ApiKeyName = typeof API_KEY_NAMES[number]

/**
 * Apply config-side keys to an environment record according to the
 * priority rule. The function does not touch disk or process.env; the
 * I/O glue lives in ipc-base.ts.
 */
export function applyApiKeysToEnv(
  apiKeys: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): void {
  if (!apiKeys) return
  for (const key of API_KEY_NAMES) {
    const configVal = (apiKeys[key] || '').trim()
    if (configVal) {
      // Config has a saved value — it wins, regardless of any stale
      // shell env. Inverting this line was the fix for the "saved
      // key silently shadowed by stale env" bug.
      env[key] = configVal
    }
    // No else: when config is empty we leave env untouched so a
    // shell-exported key (or absence) is the fallback.
  }
}
