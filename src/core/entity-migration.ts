/**
 * Entity Migration - RFC-009
 *
 * Migration utilities for upgrading entities from old schema to new.
 *
 * Migration Rules:
 * - pinned=true → projectCard=true
 * - selectedForAI → dropped (runtime only now)
 * - Generate summaryCard if missing
 *
 * Migration is idempotent - safe to run multiple times.
 */

import type {
  MemoryEntity,
  MemoryEntityType,
  EntityProvenance
} from '../types/memory-entity.js'
import {
  hasLegacyFields,
  migrateLegacyFields
} from '../types/memory-entity.js'
import {
  generateSummaryCard
} from './summary-card.js'

// ============ Types ============

/**
 * Legacy entity structure (pre-RFC-009)
 */
export interface LegacyEntity {
  id: string
  type: string
  createdAt: string
  updatedAt: string
  title: string
  tags?: string[]

  // Legacy fields to migrate
  pinned?: boolean
  selectedForAI?: boolean

  // Content (varies by type)
  content?: string
  description?: string
  filePath?: string

  // Other fields
  provenance?: Partial<EntityProvenance>
  [key: string]: unknown
}

/**
 * Migration result for a single entity
 */
export interface MigrationResult {
  id: string
  success: boolean
  migrated: boolean
  changes: string[]
  error?: string
}

/**
 * Batch migration result
 */
export interface BatchMigrationResult {
  total: number
  migrated: number
  skipped: number
  failed: number
  results: MigrationResult[]
}

/**
 * Migration options
 */
export interface MigrationOptions {
  /**
   * Generate summary cards for entities without them
   * Default: true
   */
  generateSummaryCards?: boolean

  /**
   * LLM function for summary generation (optional)
   * If not provided, only deterministic summaries are generated
   */
  llmSummarize?: (prompt: string) => Promise<string>

  /**
   * Dry run - don't actually modify entities
   * Default: false
   */
  dryRun?: boolean

  /**
   * Mark migrated legacy-pinned items for review
   * Default: true
   */
  markForReview?: boolean
}

// ============ Migration Logic ============

/**
 * Check if entity needs migration
 */
export function needsMigration(entity: Record<string, unknown>): boolean {
  // Check for legacy fields
  if (hasLegacyFields(entity)) {
    return true
  }

  // Check for missing required fields
  if (!('projectCard' in entity)) {
    return true
  }

  if (!('summaryCard' in entity) || !entity.summaryCard) {
    return true
  }

  return false
}

/**
 * Extract content from entity for summary generation
 */
function extractContent(entity: LegacyEntity): string {
  // Try various content fields
  if (entity.content && typeof entity.content === 'string') {
    return entity.content
  }

  if (entity.description && typeof entity.description === 'string') {
    return entity.description
  }

  // For documents, use title and file path
  if (entity.filePath) {
    return `Document: ${entity.title}\nFile: ${entity.filePath}`
  }

  // Fallback to title
  return entity.title || ''
}

/**
 * Migrate a single entity to new schema
 */
export async function migrateEntity(
  entity: LegacyEntity,
  options: MigrationOptions = {}
): Promise<{ entity: MemoryEntity; result: MigrationResult }> {
  const {
    generateSummaryCards = true,
    llmSummarize,
    dryRun = false,
    markForReview = true
  } = options

  const changes: string[] = []
  const result: MigrationResult = {
    id: entity.id,
    success: true,
    migrated: false,
    changes: []
  }

  try {
    // Start with a copy
    const migrated: Record<string, unknown> = { ...entity }

    // 1. Migrate legacy fields
    if (hasLegacyFields(entity)) {
      const legacyChanges = migrateLegacyFields(entity)

      if ('projectCard' in legacyChanges) {
        migrated.projectCard = legacyChanges.projectCard
        if (entity.pinned) {
          changes.push('pinned=true → projectCard=true')

          // Mark for review if it was a legacy pinned item
          if (markForReview && !dryRun) {
            migrated._legacyPinned = true
            migrated._needsReview = true
            changes.push('Marked for review (legacy pinned)')
          }
        }
      }

      // Remove legacy fields
      delete migrated.pinned
      delete migrated.selectedForAI

      if ('selectedForAI' in entity) {
        changes.push('selectedForAI dropped (now runtime-only)')
      }
    }

    // 2. Ensure projectCard exists
    if (!('projectCard' in migrated)) {
      migrated.projectCard = false
      changes.push('Added projectCard=false')
    }

    // 3. Generate summary card if missing
    if (generateSummaryCards && (!migrated.summaryCard || migrated.summaryCard === '')) {
      const content = extractContent(entity)
      const entityType = (entity.type || 'note') as MemoryEntityType

      const summaryResult = await generateSummaryCard({
        type: entityType,
        title: entity.title,
        content,
        tags: entity.tags || [],
        llmSummarize
      })

      migrated.summaryCard = summaryResult.summaryCard
      migrated.summaryCardMethod = summaryResult.method
      migrated.summaryCardHash = summaryResult.contentHash
      changes.push(`Generated summaryCard (${summaryResult.method}, ${summaryResult.tokens} tokens)`)
    }

    // 4. Ensure required fields
    if (!migrated.revision) {
      migrated.revision = 1
      changes.push('Added revision=1')
    }

    if (!migrated.tags) {
      migrated.tags = []
    }

    if (!migrated.provenance) {
      migrated.provenance = {
        source: 'system' as const,
        traceId: `migration-${Date.now()}`
      }
      changes.push('Added default provenance')
    }

    // 5. Add canonical path if missing
    if (!migrated.canonicalPath) {
      const type = migrated.type || 'note'
      migrated.canonicalPath = `${type}s/${entity.id}.json`
      changes.push('Added canonicalPath')
    }

    // Record changes
    result.changes = changes
    result.migrated = changes.length > 0

    return {
      entity: migrated as unknown as MemoryEntity,
      result
    }
  } catch (error) {
    result.success = false
    result.error = error instanceof Error ? error.message : String(error)
    return {
      entity: entity as unknown as MemoryEntity,
      result
    }
  }
}

/**
 * Migrate multiple entities
 */
export async function migrateEntities(
  entities: LegacyEntity[],
  options: MigrationOptions = {}
): Promise<BatchMigrationResult> {
  const results: MigrationResult[] = []
  const migratedEntities: MemoryEntity[] = []

  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const entity of entities) {
    // Skip if no migration needed
    if (!needsMigration(entity as Record<string, unknown>)) {
      skipped++
      results.push({
        id: entity.id,
        success: true,
        migrated: false,
        changes: ['No migration needed']
      })
      continue
    }

    const { entity: migratedEntity, result } = await migrateEntity(entity, options)

    results.push(result)

    if (result.success) {
      if (result.migrated) {
        migrated++
        migratedEntities.push(migratedEntity)
      } else {
        skipped++
      }
    } else {
      failed++
    }
  }

  return {
    total: entities.length,
    migrated,
    skipped,
    failed,
    results
  }
}

// ============ Utility Functions ============

/**
 * Create a migration report
 */
export function createMigrationReport(result: BatchMigrationResult): string {
  const lines: string[] = [
    '# Entity Migration Report',
    '',
    `**Total:** ${result.total}`,
    `**Migrated:** ${result.migrated}`,
    `**Skipped:** ${result.skipped}`,
    `**Failed:** ${result.failed}`,
    ''
  ]

  if (result.migrated > 0) {
    lines.push('## Migrated Entities')
    lines.push('')

    for (const r of result.results.filter(r => r.migrated)) {
      lines.push(`### ${r.id}`)
      for (const change of r.changes) {
        lines.push(`- ${change}`)
      }
      lines.push('')
    }
  }

  if (result.failed > 0) {
    lines.push('## Failed Migrations')
    lines.push('')

    for (const r of result.results.filter(r => !r.success)) {
      lines.push(`- **${r.id}**: ${r.error}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Check migration status of an entity
 */
export function getMigrationStatus(entity: Record<string, unknown>): {
  needsMigration: boolean
  hasLegacyPinned: boolean
  hasLegacySelected: boolean
  hasSummaryCard: boolean
  hasProjectCard: boolean
} {
  return {
    needsMigration: needsMigration(entity),
    hasLegacyPinned: 'pinned' in entity,
    hasLegacySelected: 'selectedForAI' in entity,
    hasSummaryCard: 'summaryCard' in entity && !!entity.summaryCard,
    hasProjectCard: 'projectCard' in entity
  }
}
