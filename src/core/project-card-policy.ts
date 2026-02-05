/**
 * Project Card Policy - Auto-pin + Auto-demote
 *
 * General, framework-level heuristic policy for Project Cards.
 * - Auto-pin: promote entities that look like core decisions/constraints.
 * - Auto-demote: demote auto-pinned entities that are stale/low-signal.
 *
 * This policy is intentionally simple and deterministic so apps can run it
 * during indexing without LLM calls.
 */

export type ProjectCardSource = 'auto' | 'manual'

export interface ProjectCardCandidate {
  id: string
  title?: string
  tags?: string[]
  summaryCard?: string
  content?: string
  projectCard?: boolean
  projectCardSource?: ProjectCardSource
  createdAt?: string
  updatedAt?: string
  provenance?: { source?: 'user' | 'agent' | 'import' | 'system' }
}

export interface ProjectCardPolicyConfig {
  autoPin?: {
    enabled?: boolean
    minScore?: number
  }
  autoDemote?: {
    enabled?: boolean
    /** Demote auto cards older than this (days) when score is low */
    maxAgeDays?: number
    /** Hard cap on auto-pinned cards (lowest scores demote first) */
    maxAutoCards?: number
  }
  keywords?: string[]
}

/** Fully resolved config with all values guaranteed */
interface ResolvedPolicyConfig {
  autoPin: { enabled: boolean; minScore: number }
  autoDemote: { enabled: boolean; maxAgeDays: number; maxAutoCards: number }
  keywords: string[]
}

export interface ProjectCardScore {
  score: number
  reasons: string[]
}

export interface ProjectCardChange {
  id: string
  action: 'promote' | 'demote'
  score: number
  reason: string
}

const DEFAULT_KEYWORDS = [
  'decision',
  'constraint',
  'requirement',
  'assumption',
  'scope',
  'goal',
  'milestone',
  'deadline',
  'risk',
  'policy',
  'must',
  'should',
  'need to',
  'do not',
  'avoid',
  'priority'
]

const DEFAULT_POLICY: ResolvedPolicyConfig = {
  autoPin: { enabled: true, minScore: 0.55 },
  autoDemote: { enabled: true, maxAgeDays: 30, maxAutoCards: 30 },
  keywords: DEFAULT_KEYWORDS
}

function normalizeConfig(config: ProjectCardPolicyConfig = {}): ResolvedPolicyConfig {
  return {
    autoPin: { ...DEFAULT_POLICY.autoPin, ...config.autoPin },
    autoDemote: { ...DEFAULT_POLICY.autoDemote, ...config.autoDemote },
    keywords: config.keywords && config.keywords.length > 0 ? config.keywords : DEFAULT_POLICY.keywords
  }
}

function tokenize(text: string): string {
  return text.toLowerCase()
}

export function scoreProjectCard(entity: ProjectCardCandidate, config: ProjectCardPolicyConfig = {}): ProjectCardScore {
  const cfg = normalizeConfig(config)
  const reasons: string[] = []

  const tags = (entity.tags ?? []).map(t => t.toLowerCase())
  const title = entity.title ? tokenize(entity.title) : ''
  const body = tokenize([entity.summaryCard, entity.content].filter(Boolean).join(' '))

  const keywordHitsInTags = cfg.keywords.filter(k => tags.includes(k))
  const keywordHitsInTitle = cfg.keywords.filter(k => title.includes(k))
  const keywordHitsInBody = cfg.keywords.filter(k => body.includes(k))

  let score = 0

  if (keywordHitsInTags.length > 0) {
    score += 0.4
    reasons.push(`tags:${keywordHitsInTags.slice(0, 3).join(',')}`)
  }

  if (keywordHitsInTitle.length > 0) {
    score += 0.2
    reasons.push(`title:${keywordHitsInTitle.slice(0, 3).join(',')}`)
  }

  if (keywordHitsInBody.length > 0) {
    score += 0.2
    reasons.push(`content:${keywordHitsInBody.slice(0, 3).join(',')}`)
  }

  if (entity.provenance?.source === 'agent') {
    score += 0.1
    reasons.push('source:agent')
  }

  const contentLen = body.length
  if (contentLen > 800) {
    score += 0.1
    reasons.push('long-content')
  }

  score = Math.min(score, 1)
  return { score, reasons }
}

function getAgeDays(entity: ProjectCardCandidate, now: Date): number | null {
  const ts = entity.updatedAt || entity.createdAt
  if (!ts) return null
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return null
  const diff = now.getTime() - date.getTime()
  return Math.max(0, diff / (1000 * 60 * 60 * 24))
}

/**
 * Apply auto-pin/auto-demote policy to a list of entities.
 *
 * Mutates entities in place and returns the list of changes.
 */
export function applyProjectCardPolicy<T extends ProjectCardCandidate>(
  entities: T[],
  config: ProjectCardPolicyConfig = {},
  now: Date = new Date()
): { changes: ProjectCardChange[] } {
  const cfg = normalizeConfig(config)
  const changes: ProjectCardChange[] = []

  const scored = entities.map(e => {
    const { score, reasons } = scoreProjectCard(e, cfg)
    return { entity: e, score, reasons }
  })

  for (const item of scored) {
    const entity = item.entity
    const isManual = entity.projectCardSource === 'manual'
      || (entity.projectCard === true && !entity.projectCardSource)
    if (isManual) continue

    if (cfg.autoPin.enabled && !entity.projectCard && item.score >= cfg.autoPin.minScore) {
      entity.projectCard = true
      entity.projectCardSource = 'auto'
      changes.push({
        id: entity.id,
        action: 'promote',
        score: item.score,
        reason: item.reasons.join(';') || 'score-threshold'
      })
    }

    if (cfg.autoDemote.enabled && entity.projectCard && entity.projectCardSource === 'auto') {
      const ageDays = getAgeDays(entity, now)
      const tooOld = ageDays !== null && ageDays > cfg.autoDemote.maxAgeDays
      if (tooOld && item.score < cfg.autoPin.minScore) {
        entity.projectCard = false
        changes.push({
          id: entity.id,
          action: 'demote',
          score: item.score,
          reason: `stale>${cfg.autoDemote.maxAgeDays}d`
        })
      }
    }
  }

  if (cfg.autoDemote.enabled && cfg.autoDemote.maxAutoCards > 0) {
    const autoCards = scored
      .filter(s => s.entity.projectCard && s.entity.projectCardSource === 'auto')
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score
        const ageA = getAgeDays(a.entity, now) ?? 0
        const ageB = getAgeDays(b.entity, now) ?? 0
        return ageB - ageA
      })

    while (autoCards.length > cfg.autoDemote.maxAutoCards) {
      const demote = autoCards.shift()
      if (!demote) break
      demote.entity.projectCard = false
      changes.push({
        id: demote.entity.id,
        action: 'demote',
        score: demote.score,
        reason: `auto-cap>${cfg.autoDemote.maxAutoCards}`
      })
    }
  }

  return { changes }
}

export const DEFAULT_PROJECT_CARD_POLICY = DEFAULT_POLICY
