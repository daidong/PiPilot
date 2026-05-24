/**
 * Telemetry config storage (schema v2). tracingMode + bufferCapacity live in the
 * LOCAL, gitignored `.research-pilot/preferences.json` (under a `telemetry` key)
 * rather than the shared `project.json`, so each collaborator decides
 * independently and telemetry on/off is never propagated between members
 * (RFC-013 §8 — fixes the "PI toggles tracing → students get flipped" footgun).
 *
 * Reads/writes are merge-preserving so they coexist with the model/effort prefs
 * managed by `shared-electron/ipc-base.ts`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATHS, type ProjectTelemetryConfig } from '../types.js'

const DEFAULTS: Required<ProjectTelemetryConfig> = { tracingMode: 'disabled', bufferCapacity: 1024 }

function prefsFile(projectPath: string): string {
  return join(projectPath, PATHS.root, 'preferences.json')
}

function readPrefs(projectPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(prefsFile(projectPath), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalize(t: Partial<ProjectTelemetryConfig> | undefined): Required<ProjectTelemetryConfig> {
  return {
    tracingMode: t?.tracingMode === 'enabled' ? 'enabled' : 'disabled',
    bufferCapacity: typeof t?.bufferCapacity === 'number' ? t.bufferCapacity : DEFAULTS.bufferCapacity,
  }
}

/** Telemetry config for this project, with defaults (opt-in: disabled). */
export function readTelemetryPrefs(projectPath: string): Required<ProjectTelemetryConfig> {
  return normalize(readPrefs(projectPath).telemetry as Partial<ProjectTelemetryConfig> | undefined)
}

/** True when preferences.json already carries a telemetry block (migration guard). */
export function hasTelemetryPrefs(projectPath: string): boolean {
  return readPrefs(projectPath).telemetry != null
}

/**
 * Merge a partial telemetry config into preferences.json, preserving every other
 * key (selectedModel, reasoningEffort, …). Returns the resolved config.
 */
export function writeTelemetryPrefs(
  projectPath: string,
  partial: Partial<ProjectTelemetryConfig>
): Required<ProjectTelemetryConfig> {
  const prefs = readPrefs(projectPath)
  const current = normalize(prefs.telemetry as Partial<ProjectTelemetryConfig> | undefined)
  const next: Required<ProjectTelemetryConfig> = {
    tracingMode: partial.tracingMode ?? current.tracingMode,
    bufferCapacity: partial.bufferCapacity ?? current.bufferCapacity,
  }
  prefs.telemetry = next
  prefs.updatedAt = new Date().toISOString()
  const file = prefsFile(projectPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(prefs, null, 2))
  return next
}

/** Whether tracing is on for this project (convenience for the tracer gate). */
export function isTracingEnabled(projectPath: string): boolean {
  return readTelemetryPrefs(projectPath).tracingMode === 'enabled'
}
