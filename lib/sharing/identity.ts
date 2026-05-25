/**
 * RFC-013 §6 — local collaborator identity. A lightweight tag (actorId +
 * displayName), NOT a git config or an account. Stored local-only at
 * `.research-pilot/identity.json` (gitignored by the asymmetric rule), so each
 * member keeps their own and it never travels in the repo.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from '../telemetry/ulid.js'
import { PATHS, type Actor } from '../types.js'

const IDENTITY_REL = join('.research-pilot', 'identity.json')

/**
 * Per-actor subdir slug (§6.1): lowercase, spaces→hyphens, strip anything not
 * `[a-z0-9-]`, collapse repeats. Empty input falls back to a short id.
 */
export function slugifyDisplayName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'member'
}

export function getLocalIdentity(projectPath: string): Actor | null {
  try {
    const raw = readFileSync(join(projectPath, IDENTITY_REL), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Actor>
    if (parsed.id && parsed.displayName) return { id: parsed.id, displayName: parsed.displayName }
    return null
  } catch {
    return null
  }
}

function writeIdentity(projectPath: string, actor: Actor): void {
  const file = join(projectPath, IDENTITY_REL)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(actor, null, 2), 'utf-8')
}

/**
 * Return the local identity, creating it on first use. `displayName` (from the
 * Share / Join prompt) seeds it; an existing identity keeps its actorId and only
 * updates the displayName when a new non-empty one is supplied.
 */
export function ensureLocalIdentity(projectPath: string, displayName?: string): Actor {
  const existing = getLocalIdentity(projectPath)
  if (existing) {
    if (displayName && displayName.trim() && displayName.trim() !== existing.displayName) {
      const updated = { id: existing.id, displayName: displayName.trim() }
      writeIdentity(projectPath, updated)
      return updated
    }
    return existing
  }
  const actor: Actor = { id: ulid(), displayName: (displayName ?? '').trim() || 'Me' }
  writeIdentity(projectPath, actor)
  return actor
}

export function hasLocalIdentity(projectPath: string): boolean {
  return existsSync(join(projectPath, IDENTITY_REL))
}

/**
 * Resolve the local actor for a shared project, including the stable per-actor
 * directory slug. This is intentionally derived from the shared roster in
 * project.json so artifact placement and the agent's soft file-placement prompt
 * agree about collision handling.
 */
export function getSharedLocalActor(projectPath: string): Actor | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(projectPath, PATHS.project), 'utf-8')) as {
      share?: unknown
      members?: Array<{ actorId?: string; displayName?: string }>
    }
    if (!cfg.share) return undefined
    const me = getLocalIdentity(projectPath)
    if (!me) return undefined

    const base = slugifyDisplayName(me.displayName)
    const collision = (cfg.members ?? []).some(
      (m) => m.actorId && m.actorId !== me.id && m.displayName && slugifyDisplayName(m.displayName) === base
    )
    const slug = collision ? `${base}-${me.id.slice(-4).toLowerCase()}` : base
    return { id: me.id, displayName: me.displayName, slug }
  } catch {
    return undefined
  }
}
