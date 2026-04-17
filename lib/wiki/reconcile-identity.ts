/**
 * Wiki Identity Reconcile — one-shot repair for pre-existing identity drift.
 *
 * Scanner pre-pass (identity-migration.ts + scanner.ts) blocks new drift at
 * the write path, but the wiki already has ~58 drift groups and 2 legacy
 * bogus-arxiv slugs from before the pre-pass existed. This module walks the
 * on-disk state, groups slugs by normalized H1 title, picks a keep-winner
 * per group, and calls applyIdentityMigration to collapse the rest.
 *
 * Keep-winner policy: arXiv > DOI > title (based on the *canonical key
 * prefix* stored in processed.jsonl, not the slug name). Ties broken by
 * most recent processedAt. Bogus arXiv keys (where isValidArxivId returns
 * false on the embedded id) are treated as title fallbacks regardless of
 * their slug prefix.
 *
 * Supports a dry-run mode: returns the planned IdentityChange list and a
 * migration summary WITHOUT touching the filesystem. Callers should show
 * this to the user and ask for explicit confirmation before committing.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getWikiRoot, isValidArxivId, type ProcessedEntry } from './types.js'
import { safeReadFile } from './io.js'
import { withWikiLock } from './lock.js'
import { applyIdentityMigration, type IdentityChange, type MigrationResult } from './identity-migration.js'
import { pruneSidecarStatus } from './sidecar-status.js'

// ── Policy helpers ─────────────────────────────────────────────────────────

type KeyTier = 'doi' | 'arxiv' | 'title' | 'bogus'

/**
 * Classify a canonicalKey into its effective tier. A bogus arxiv id (e.g.
 * `arxiv:912`) demotes to `bogus` so the reconcile keeps a real arXiv or
 * title entry over it.
 */
function classifyKey(canonicalKey: string): KeyTier {
  if (canonicalKey.startsWith('doi:')) return 'doi'
  if (canonicalKey.startsWith('arxiv:')) {
    const id = canonicalKey.slice('arxiv:'.length)
    return isValidArxivId(id) ? 'arxiv' : 'bogus'
  }
  if (canonicalKey.startsWith('title:')) return 'title'
  return 'title'  // unknown — treat as lowest priority but not bogus
}

const TIER_RANK: Record<KeyTier, number> = {
  doi:   3,  // DOI > arXiv > title — matches computeCanonicalKey priority
  arxiv: 2,
  title: 1,
  bogus: 0,
}

// ── Drift detection ────────────────────────────────────────────────────────

interface DriftCandidate {
  slug: string
  canonicalKey: string
  tier: KeyTier
  processedAt: string
  title: string  // extracted H1
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function extractH1(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : fallback
}

/**
 * Walk papers/*.md and processed.jsonl to build per-group drift candidates.
 * A "group" is a set of slugs sharing the same normalized H1 title.
 */
function findDriftGroups(): DriftCandidate[][] {
  const root = getWikiRoot()
  const papersDir = join(root, 'papers')
  if (!existsSync(papersDir)) return []

  // Load processed.jsonl keyed by slug
  const processedPath = join(root, '.state', 'processed.jsonl')
  const processedContent = safeReadFile(processedPath) || ''
  const slugToEntry = new Map<string, ProcessedEntry>()
  for (const line of processedContent.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as ProcessedEntry
      if (e.slug) slugToEntry.set(e.slug, e)
    } catch { /* skip */ }
  }

  // Build candidates from every .md file (even ones without a watermark entry —
  // they're orphans and should still be surfaced)
  const byTitle = new Map<string, DriftCandidate[]>()
  for (const f of readdirSync(papersDir)) {
    if (!f.endsWith('.md')) continue
    const slug = f.slice(0, -3)
    const content = safeReadFile(join(papersDir, f))
    if (!content) continue
    const title = extractH1(content, slug)
    const entry = slugToEntry.get(slug)
    const canonicalKey = entry?.canonicalKey ?? `unknown:${slug}`
    const candidate: DriftCandidate = {
      slug,
      canonicalKey,
      tier: classifyKey(canonicalKey),
      processedAt: entry?.processedAt ?? '',
      title,
    }
    const key = normTitle(title)
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key)!.push(candidate)
  }

  return Array.from(byTitle.values()).filter(group => group.length > 1)
}

/**
 * Within a drift group, pick the slug to KEEP and return IdentityChange
 * entries that would migrate each loser onto the winner.
 *
 * Ranking: higher tier wins; ties broken by most recent processedAt; ties
 * after that broken by slug lexicographic order (deterministic).
 */
function pickWinnerAndLosers(group: DriftCandidate[]): IdentityChange[] {
  const sorted = [...group].sort((a, b) => {
    const rankDiff = TIER_RANK[b.tier] - TIER_RANK[a.tier]
    if (rankDiff !== 0) return rankDiff
    if (a.processedAt !== b.processedAt) return b.processedAt.localeCompare(a.processedAt)
    return a.slug.localeCompare(b.slug)
  })
  const winner = sorted[0]
  return sorted.slice(1).map(loser => ({
    oldKey: loser.canonicalKey,
    oldSlug: loser.slug,
    newKey: winner.canonicalKey,
    newSlug: winner.slug,
  }))
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReconcilePlanGroup {
  title: string
  winner: { slug: string; canonicalKey: string; tier: KeyTier }
  losers: { slug: string; canonicalKey: string; tier: KeyTier }[]
}

export interface ReconcileReport {
  dryRun: boolean
  groupCount: number
  changesPlanned: number
  changesApplied: number
  groups: ReconcilePlanGroup[]
  migrationTotals: MigrationResult
  sidecarStatusRowsPruned: number
  perChangeResults?: { change: IdentityChange; result: MigrationResult }[]
}

function emptyMigrationTotals(): MigrationResult {
  return {
    mode: 'noop',
    renamedPage: false,
    deletedOldPage: false,
    processedEntriesMigrated: 0,
    processedEntriesDeleted: 0,
    provenanceEntriesRewritten: 0,
    provenanceEntriesDeduped: 0,
    conceptPagesTouched: [],
    conceptMarkerBlocksRenamed: 0,
    conceptMarkerBlocksDeleted: 0,
  }
}

function mergeInto(total: MigrationResult, r: MigrationResult): void {
  total.processedEntriesMigrated += r.processedEntriesMigrated
  total.processedEntriesDeleted += r.processedEntriesDeleted
  total.provenanceEntriesRewritten += r.provenanceEntriesRewritten
  total.provenanceEntriesDeduped += r.provenanceEntriesDeduped
  total.conceptMarkerBlocksRenamed += r.conceptMarkerBlocksRenamed
  total.conceptMarkerBlocksDeleted += r.conceptMarkerBlocksDeleted
  if (r.renamedPage) total.renamedPage = true
  if (r.deletedOldPage) total.deletedOldPage = true
  for (const f of r.conceptPagesTouched) {
    if (!total.conceptPagesTouched.includes(f)) total.conceptPagesTouched.push(f)
  }
}

/**
 * Scan the wiki for identity drift groups and either report or apply
 * migrations. Always runs under withWikiLock so concurrent agent ticks
 * are serialized.
 */
export async function reconcileIdentityDrift(
  opts: { dryRun: boolean } = { dryRun: true },
): Promise<ReconcileReport> {
  return withWikiLock(async () => {
    const groups = findDriftGroups()
    const migrationTotals = emptyMigrationTotals()
    const planGroups: ReconcilePlanGroup[] = []
    const perChangeResults: { change: IdentityChange; result: MigrationResult }[] = []
    let changesPlanned = 0
    let changesApplied = 0

    for (const group of groups) {
      const changes = pickWinnerAndLosers(group)
      if (changes.length === 0) continue
      const winnerSlug = changes[0].newSlug
      const winner = group.find(g => g.slug === winnerSlug)!
      planGroups.push({
        title: winner.title,
        winner: { slug: winner.slug, canonicalKey: winner.canonicalKey, tier: winner.tier },
        losers: changes.map(c => {
          const src = group.find(g => g.slug === c.oldSlug)!
          return { slug: src.slug, canonicalKey: src.canonicalKey, tier: src.tier }
        }),
      })

      changesPlanned += changes.length
      if (opts.dryRun) continue

      for (const change of changes) {
        const result = applyIdentityMigration(change)
        mergeInto(migrationTotals, result)
        perChangeResults.push({ change, result })
        changesApplied++
      }
    }

    // After collapses, sidecar_status.jsonl may hold rows for slugs whose
    // .md files we just deleted. Drop them so the repair pass doesn't have
    // to walk dead entries every cycle.
    let sidecarStatusRowsPruned = 0
    if (!opts.dryRun) {
      const papersDir = join(getWikiRoot(), 'papers')
      const liveSlugs = new Set<string>()
      if (existsSync(papersDir)) {
        for (const f of readdirSync(papersDir)) {
          if (f.endsWith('.md')) liveSlugs.add(f.slice(0, -3))
        }
      }
      sidecarStatusRowsPruned = pruneSidecarStatus(liveSlugs)
    }

    return {
      dryRun: opts.dryRun,
      groupCount: planGroups.length,
      changesPlanned,
      changesApplied,
      groups: planGroups,
      migrationTotals,
      sidecarStatusRowsPruned,
      perChangeResults: opts.dryRun ? undefined : perChangeResults,
    }
  })
}
