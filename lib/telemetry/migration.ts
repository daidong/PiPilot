/**
 * ProjectConfig migration helper (§14.1).
 *
 * Idempotent. Crash-safe (atomic temp+rename). Runs on every project load before any
 * other PiPilot code touches the config.
 *
 * Procedure:
 *   1. Read project.json.
 *   2. If `configSchemaVersion` is missing or < 1:
 *      a. If `id` is missing, generate a ULID, set `configSchemaVersion = 1`.
 *      b. If `telemetry` is missing, set { tracingMode: 'disabled', bufferCapacity: 1024 }.
 *         New projects start with telemetry off; user opts in via Settings →
 *         Telemetry. Existing projects with explicit `tracingMode: 'enabled'`
 *         keep their value (we don't override what the user already opted into).
 *      c. Write project.json atomically (temp + rename).
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

  // ----- Apply v0 → v1 migration -----
  if (!config.id) {
    config.id = ulid()
  }
  if (!config.telemetry) {
    // Opt-in default: new projects start with telemetry disabled. Users
    // enable via Settings → Telemetry. Existing projects that already have
    // an explicit `telemetry.tracingMode` (including 'enabled') are not
    // touched — that branch is gated by the `if (!config.telemetry)` above.
    config.telemetry = {
      tracingMode: 'disabled',
      bufferCapacity: 1024
    }
  }
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
      reason: 'first-run-on-v0.7'
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
