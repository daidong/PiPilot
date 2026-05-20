/**
 * Shared AWS credentials layer — RFC-009 §3.1.
 *
 * Single source of truth for "where are my AWS keys?" across every
 * Layer A backend (EC2), Layer B provider (Bedrock, deferred), and
 * Layer C tool factory (S3). Resolution priority (highest wins):
 *
 *   1. Explicit settings    — Compute tab → AWS section
 *   2. Environment          — AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
 *   3. ~/.aws/credentials   — when AWS_PROFILE is set or [default] exists
 *   4. Instance metadata    — only meaningful if the app runs on EC2 itself
 *
 * Validation is a single sts:GetCallerIdentity call, cached for 5 min
 * keyed by accessKeyId+region so flipping the region forces a re-check.
 *
 * The credentials object is intentionally JSON-serializable: backends
 * and tools pass it through ComputeContext.getCredentials() / tool
 * factory arguments without any class instances crossing the boundary.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  profile?: string
}

export type AwsCredentialSource = 'settings' | 'env' | 'profile' | 'instance-metadata'

export interface AwsCredentialResolution {
  source: AwsCredentialSource
  credentials: AwsCredentials
  validatedAt?: string
  accountId?: string
  arn?: string
}

export interface AwsValidationResult {
  valid: boolean
  accountId?: string
  arn?: string
  error?: string
}

export interface SettingsCredentialInput {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  region?: string
  profile?: string
}

// ---------------------------------------------------------------------------
// ~/.aws/credentials parser — small enough to inline; avoids an extra dep.
// ---------------------------------------------------------------------------

interface ProfileMap {
  [profile: string]: Record<string, string>
}

function parseIniFile(content: string): ProfileMap {
  const out: ProfileMap = {}
  let current: string | null = null
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/[#;].*$/, '').trim()
    if (!line) continue
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      current = section[1].trim()
      if (!out[current]) out[current] = {}
      continue
    }
    if (!current) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    out[current][key] = value
  }
  return out
}

function readProfileFile(filePath: string): ProfileMap {
  try {
    if (!fs.existsSync(filePath)) return {}
    return parseIniFile(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
}

function loadProfileCredentials(profileName: string): AwsCredentials | null {
  const home = os.homedir()
  const credsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials')
  const configPath = process.env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config')
  const creds = readProfileFile(credsPath)[profileName]
  // ~/.aws/config sections are prefixed with `profile ` for non-default.
  const configKey = profileName === 'default' ? 'default' : `profile ${profileName}`
  const cfg = readProfileFile(configPath)[configKey] ?? {}
  if (!creds?.aws_access_key_id || !creds?.aws_secret_access_key) return null
  const region = cfg.region || creds.region || ''
  if (!region) return null
  return {
    accessKeyId: creds.aws_access_key_id,
    secretAccessKey: creds.aws_secret_access_key,
    sessionToken: creds.aws_session_token || undefined,
    region,
    profile: profileName,
  }
}

// ---------------------------------------------------------------------------
// AwsCredentialProvider — singleton with a 5-min validation cache.
// ---------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number
  result: AwsValidationResult
}

const VALIDATION_CACHE_MS = 5 * 60_000

export class AwsCredentialProvider {
  private readonly validationCache = new Map<string, CacheEntry>()
  private readonly getSettings: () => SettingsCredentialInput

  constructor(opts: { getSettings: () => SettingsCredentialInput }) {
    this.getSettings = opts.getSettings
  }

  /**
   * Resolve a usable credential bundle. Throws if no source supplies a
   * complete (accessKey + secretKey + region) triple.
   *
   * Region and keys are resolved INDEPENDENTLY across sources — region
   * may come from settings while keys come from env, or vice versa.
   * This matters because the Settings UI saves region in the settings
   * JSON but routes the sensitive accessKey/secretKey through the
   * existing saveApiKey IPC (which only sets process.env.*). Coupling
   * them to the same source would force the user to type their secrets
   * into the settings JSON in plaintext, defeating the encrypted
   * storage path Modal already uses.
   */
  resolve(opts?: { region?: string }): AwsCredentialResolution {
    const settings = this.getSettings() ?? {}
    const override = opts?.region

    // Region: explicit override > settings > env (AWS_REGION or AWS_DEFAULT_REGION)
    const region =
      override ||
      settings.region ||
      (process.env.AWS_REGION ?? '').trim() ||
      (process.env.AWS_DEFAULT_REGION ?? '').trim()

    // 1. Settings keys (explicit accessKeyId + secretAccessKey set in settings)
    if (settings.accessKeyId && settings.secretAccessKey && region) {
      return {
        source: 'settings',
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
          sessionToken: settings.sessionToken || undefined,
          region,
          profile: settings.profile || undefined,
        },
      }
    }

    // 2. Environment keys — the saveApiKey IPC path. Region may still
    // come from settings, since `saveApiKey` doesn't touch AWS_REGION.
    const envAccess = (process.env.AWS_ACCESS_KEY_ID ?? '').trim()
    const envSecret = (process.env.AWS_SECRET_ACCESS_KEY ?? '').trim()
    if (envAccess && envSecret && region) {
      return {
        source: 'env',
        credentials: {
          accessKeyId: envAccess,
          secretAccessKey: envSecret,
          sessionToken: (process.env.AWS_SESSION_TOKEN ?? '').trim() || undefined,
          region,
        },
      }
    }

    // 3. ~/.aws/credentials profile
    const profileName = settings.profile || (process.env.AWS_PROFILE ?? '').trim() || 'default'
    const fromProfile = loadProfileCredentials(profileName)
    if (fromProfile) {
      return {
        source: 'profile',
        credentials: override ? { ...fromProfile, region: override } : fromProfile,
      }
    }

    // 4. Surface a precise diagnostic so the user knows which piece is
    // missing. The generic "no credentials" wording hid two distinct
    // failure modes: keys present but region empty, or region present
    // but keys empty. Each calls for a different fix.
    const settingsHasKeys = !!(settings.accessKeyId && settings.secretAccessKey)
    const envHasKeys = !!(envAccess && envSecret)
    const hasRegion = !!region
    const diagnostic = JSON.stringify({
      settings_has_region: !!settings.region,
      settings_has_keys: settingsHasKeys,
      env_AWS_REGION_set: !!(process.env.AWS_REGION ?? '').trim(),
      env_AWS_DEFAULT_REGION_set: !!(process.env.AWS_DEFAULT_REGION ?? '').trim(),
      env_AWS_ACCESS_KEY_ID_set: !!envAccess,
      env_AWS_SECRET_ACCESS_KEY_set: !!envSecret,
      profile_attempted: profileName,
      profile_found: false,
    })
    if (!hasRegion && (settingsHasKeys || envHasKeys)) {
      throw new Error(
        `AWS region is not set, but keys are. Settings → Compute → AWS → Default region must be a non-empty string (e.g. "us-east-1"). Diagnostic: ${diagnostic}`,
      )
    }
    if (hasRegion && !settingsHasKeys && !envHasKeys) {
      throw new Error(
        `AWS region is set but no access keys were found in settings or environment. Save them in Settings → Compute → AWS, then click Test connection again. Diagnostic: ${diagnostic}`,
      )
    }
    throw new Error(
      `No AWS credentials available. Configure access key + secret + region in Settings → Compute → AWS, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION as env vars, or create ~/.aws/credentials with a [default] profile. Diagnostic: ${diagnostic}`,
    )
  }

  /**
   * Validate a credential bundle by calling sts:GetCallerIdentity.
   * Cached for 5 minutes keyed by accessKeyId+region — flipping the
   * region invalidates the cache so cross-region misconfigurations
   * surface promptly.
   *
   * The STS client is loaded dynamically so this module doesn't pin
   * a hard dependency at type-check time for tooling paths that never
   * touch validation (e.g. unit tests that mock the provider entirely).
   */
  async validate(creds: AwsCredentials): Promise<AwsValidationResult> {
    const cacheKey = `${creds.accessKeyId}::${creds.region}`
    const cached = this.validationCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.result

    let result: AwsValidationResult
    try {
      const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts')
      const client = new STSClient({
        region: creds.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      })
      const resp = await client.send(new GetCallerIdentityCommand({}))
      result = { valid: true, accountId: resp.Account, arn: resp.Arn }
    } catch (err) {
      result = {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    this.validationCache.set(cacheKey, { expiresAt: Date.now() + VALIDATION_CACHE_MS, result })
    return result
  }

  /** Drop cached validation so the next `validate()` re-issues a real STS call. */
  invalidate(): void {
    this.validationCache.clear()
  }
}

// ---------------------------------------------------------------------------
// AWS SDK client-credentials helper
// ---------------------------------------------------------------------------

/**
 * Convert an AwsCredentials bundle into the shape every `@aws-sdk/client-*`
 * client expects under its `credentials` constructor argument. Kept in
 * this module so every backend / tool reaches for the same helper and
 * the AwsCredentials field names stay encapsulated.
 */
export function toSdkCredentials(creds: AwsCredentials): {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
} {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  }
}
