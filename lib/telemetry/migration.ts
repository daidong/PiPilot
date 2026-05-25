/**
 * ProjectConfig migration helper (§14.1).
 *
 * Idempotent. Crash-safe (atomic temp+rename). Runs on every project load before any
 * other PiPilot code touches the config.
 *
 * Procedure:
 *   1. Read project.json.
 *   2. If `configSchemaVersion` is missing or < target (2):
 *      a. If `id` is missing, generate a ULID.
 *      b. v2: telemetry config moved to the LOCAL `preferences.json` (RFC-013 —
 *         keep it out of the shared project.json). If a legacy `telemetry` block
 *         exists, seed the local prefs from it once (preserving the user's prior
 *         opt-in/out), then delete it from project.json. New projects have none;
 *         prefs default to disabled (opt-in).
 *      c. Set `configSchemaVersion = 2`, write project.json atomically.
 *      d. Append a row to .research-pilot/tracing-state.jsonl.
 *   3. Else: skip (already migrated).
 *
 * Idempotent: running twice is a no-op.
 * Crash-safe: temp+rename atomicity means a partial write leaves the old config intact.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { PATHS, PROJECT_CONFIG_SCHEMA_VERSION, type ProjectConfig } from '../types.js'
import { ulid } from './ulid.js'
import { createTracingStateLogger } from './tracing-state.js'
import { hasTelemetryPrefs, writeTelemetryPrefs } from './telemetry-prefs.js'

export interface MigrationResult {
  migrated: boolean
  fromVersion: number
  toVersion: number
  config: ProjectConfig
}

/**
 * Migrate project.json in place if needed.
 *
 * Throws only on disk errors (file unreadable, write fails after retry). The caller
 * is responsible for surfacing those to the user — they indicate a real problem
 * (e.g., read-only volume) rather than a routine telemetry hiccup.
 */
export function migrateProjectConfig(projectPath: string): MigrationResult {
  const projectFile = join(projectPath, PATHS.project)

  if (!existsSync(projectFile)) {
    throw new Error(`project.json not found at ${projectFile}`)
  }

  const raw = readFileSync(projectFile, 'utf8')
  const config = JSON.parse(raw) as ProjectConfig

  const currentVersion = config.configSchemaVersion ?? 0
  const targetVersion = PROJECT_CONFIG_SCHEMA_VERSION

  if (currentVersion >= targetVersion) {
    return {
      migrated: false,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      config
    }
  }

  // ----- Apply migration to v2 -----
  // v2: telemetry config moves to the LOCAL preferences.json (read side already
  // prefers it). Seed it from any legacy block once, guarded so a manual prefs
  // edit isn't clobbered and re-runs are safe. This write is local-only.
  if (config.telemetry && !hasTelemetryPrefs(projectPath)) {
    writeTelemetryPrefs(projectPath, config.telemetry)
  }

  // RFC-013: project.json is the single SHARED file. NEVER rewrite it as a side
  // effect of opening a shared project — that dirties every collaborator's clone
  // the instant they join (the v1→v2 telemetry strip + schema bump showed up as
  // "uncommitted changes" right after Clone & join) and churns the shared file's
  // history. For shared projects the migration is READ-ONLY: telemetry stays as
  // inert legacy in the file (ignored — local prefs are authoritative) and the
  // schema version is left as-is. Schema upkeep of the shared file is not a
  // member-on-open concern.
  if (config.share) {
    return { migrated: false, fromVersion: currentVersion, toVersion: currentVersion, config }
  }

  // Solo (unshared) project: safe to clean up fully and advance the schema.
  if (!config.id) {
    config.id = ulid()
  }
  delete config.telemetry
  config.configSchemaVersion = targetVersion

  // ----- Atomic write: temp + rename -----
  const tmpFile = `${projectFile}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmpFile, projectFile)

  // ----- Best-effort tracing-state log (do not fail migration on log error) -----
  try {
    const tracingStateDir = dirname(join(projectPath, PATHS.tracingState))
    if (!existsSync(tracingStateDir)) {
      mkdirSync(tracingStateDir, { recursive: true })
    }
    // Synchronous append to keep migration atomic from caller's POV.
    const logger = createTracingStateLogger(projectPath)
    // Fire-and-forget: log writer is async but errors are swallowed internally.
    void logger.append({
      kind: 'config-migration',
      fromState: currentVersion,
      toState: targetVersion,
      actor: 'system',
      reason: `config-schema-migrate-v${currentVersion}-to-v${targetVersion}`
    })
  } catch {
    // Migration succeeded; tracing-state is informational. Swallow.
  }

  return {
    migrated: true,
    fromVersion: currentVersion,
    toVersion: targetVersion,
    config
  }
}
