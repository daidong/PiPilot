import { countTokens } from '../utils/tokenizer.js'
import type {
  KernelV2TelemetryEvent,
  KernelV2ResolvedConfig,
  V2ContextAssemblyInput,
  V2ContextAssemblyResult,
  V2LogicalTurn,
  V2TaskAnchor,
  V2TurnRecord
} from './types.js'
import { BudgetPlannerV2 } from './budget-planner-v2.js'
import { KernelV2Storage } from './storage.js'

function toLogicalTurns(turns: V2TurnRecord[]): V2LogicalTurn[] {
  const logicalTurns: V2LogicalTurn[] = []
  let current: V2LogicalTurn | null = null

  for (const turn of turns) {
    if (turn.role === 'user') {
      if (current) logicalTurns.push(current)
      current = {
        user: turn,
        followups: [],
        fromIndex: turn.index,
        toIndex: turn.index
      }
      continue
    }

    if (!current) {
      continue
    }

    current.followups.push(turn)
    current.toIndex = turn.index
  }

  if (current) logicalTurns.push(current)
  return logicalTurns
}

function renderLogicalTurn(turn: V2LogicalTurn, includeToolMessages: boolean): string {
  const lines: string[] = []
  lines.push(`**User**: ${turn.user.content}`)

  for (const item of turn.followups) {
    if (item.role === 'tool' && !includeToolMessages) continue
    const role = item.role === 'assistant' ? 'Assistant' : 'Tool'
    lines.push(`**${role}**: ${item.content}`)
  }

  return lines.join('\n')
}

function takeByBudget(blocks: string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (const block of blocks) {
    const t = countTokens(block)
    if (used + t > budget) break
    out.push(block)
    used += t
  }
  return out
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length > 2)
}

function scoreByKeywords(queryTokens: string[], hay: string): number {
  if (queryTokens.length === 0) return 1
  const hayTokens = new Set(tokenize(hay))
  const matched = queryTokens.filter(t => hayTokens.has(t))
  return matched.length / queryTokens.length
}

function selectProtectedBlocksByTokenBudget(blocks: string[], targetTokens: number): { selected: string[]; dropped: number } {
  if (blocks.length === 0) return { selected: [], dropped: 0 }
  if (targetTokens <= 0) {
    return { selected: [blocks[blocks.length - 1]!], dropped: Math.max(0, blocks.length - 1) }
  }

  const selectedReversed: string[] = []
  let used = 0

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    const tokens = countTokens(block)
    if (selectedReversed.length === 0) {
      selectedReversed.push(block)
      used += tokens
      continue
    }
    if (used + tokens > targetTokens) {
      continue
    }
    selectedReversed.push(block)
    used += tokens
  }

  const selected = selectedReversed.reverse()
  return {
    selected,
    dropped: Math.max(0, blocks.length - selected.length)
  }
}

function emptyAnchor(): V2TaskAnchor {
  return {
    currentGoal: 'Not set yet',
    nowDoing: 'Understanding current request',
    blockedBy: [],
    nextAction: 'Clarify next concrete step'
  }
}

export class ContextAssemblerV2 {
  private readonly planner = new BudgetPlannerV2()

  constructor(
    private readonly storage: KernelV2Storage,
    private readonly config: KernelV2ResolvedConfig,
    private readonly telemetry?: (event: KernelV2TelemetryEvent) => void
  ) {}

  private emit(event: string, payload: Record<string, unknown>, message: string): void {
    this.telemetry?.({ event, payload, message })
  }

  private buildMemoryLinesFromResults(results: Awaited<ReturnType<KernelV2Storage['searchMemoryItems']>>): string[] {
    return results
      .slice(0, 30)
      .map(result => `- ${result.item.namespace}:${result.item.key} -> ${result.item.valueText ?? JSON.stringify(result.item.value).slice(0, 240)}`)
  }

  private buildEvidenceLinesFromResults(results: Awaited<ReturnType<KernelV2Storage['searchArtifacts']>>): string[] {
    return results
      .slice(0, 20)
      .map(result => `- [${result.artifact.type}] ${result.artifact.summary} (ref: ${result.artifact.sourceRef})`)
  }

  private async retrieveCards(projectId: string, query: string): Promise<{ memoryBlocks: string[]; evidenceBlocks: string[] }> {
    const chain = this.config.retrieval.fallbackChain
    const attemptedModes: string[] = []
    let selectedMode = 'raw-file-scan'
    let fallbackDepth = 0
    let rawScanTruncated = false
    let memoryBlocks: string[] = []
    let evidenceBlocks: string[] = []

    for (const mode of chain) {
      attemptedModes.push(mode)
      try {
        if (mode === 'vector-only') {
          throw new Error('vector index unavailable')
        }

        if (mode === 'raw-file-scan') {
          selectedMode = mode
          const facts = await this.storage.listLatestMemoryFactsByKey()
          const artifacts = await this.storage.listArtifacts(projectId)
          const queryTokens = tokenize(query)
          const candidates: Array<{ type: 'memory' | 'evidence'; text: string; score: number }> = []

          for (const fact of facts) {
            if (fact.status === 'superseded' || fact.status === 'deprecated') continue
            const text = `${fact.namespace}:${fact.key} ${fact.valueText ?? JSON.stringify(fact.value)}`
            candidates.push({
              type: 'memory',
              text: `- ${fact.namespace}:${fact.key} -> ${fact.valueText ?? JSON.stringify(fact.value).slice(0, 240)}`,
              score: scoreByKeywords(queryTokens, text)
            })
          }

          for (const artifact of artifacts) {
            const text = `${artifact.summary} ${artifact.sourceRef} ${artifact.path}`
            candidates.push({
              type: 'evidence',
              text: `- [${artifact.type}] ${artifact.summary} (ref: ${artifact.sourceRef})`,
              score: scoreByKeywords(queryTokens, text)
            })
          }

          candidates.sort((a, b) => b.score - a.score)

          const limit = this.config.retrieval.rawScanLimitTokens
          let used = 0
          for (const candidate of candidates) {
            const tokens = countTokens(candidate.text)
            if (used + tokens > limit) {
              rawScanTruncated = true
              continue
            }
            used += tokens
            if (candidate.type === 'memory') {
              if (memoryBlocks.length < 30) memoryBlocks.push(candidate.text)
            } else if (evidenceBlocks.length < 20) {
              evidenceBlocks.push(candidate.text)
            }
          }

          break
        }

        const [memoryResults, artifactResults] = await Promise.all([
          this.storage.searchMemoryItems(query, { limit: 30, includeDeprecated: false, sensitivity: 'all' }),
          this.storage.searchArtifacts(projectId, query, 20)
        ])
        selectedMode = mode
        memoryBlocks = this.buildMemoryLinesFromResults(memoryResults)
        evidenceBlocks = this.buildEvidenceLinesFromResults(artifactResults)
        break
      } catch {
        fallbackDepth += 1
      }
    }

    this.emit('retrieval.hybrid.stats', {
      profile: this.config.profile,
      mode: selectedMode,
      attemptedModes,
      fallbackDepth,
      memoryCandidates: memoryBlocks.length,
      evidenceCandidates: evidenceBlocks.length,
      rawScanTruncated,
      queryTokens: tokenize(query).length
    }, `retrieval profile=${this.config.profile} mode=${selectedMode} memory=${memoryBlocks.length} evidence=${evidenceBlocks.length}`)

    return { memoryBlocks, evidenceBlocks }
  }

  async assemble(sessionId: string, projectId: string, input: V2ContextAssemblyInput): Promise<V2ContextAssemblyResult> {
    const isLegacyProfile = this.config.profile === 'legacy'

    const turns = await this.storage.getSessionTurns(sessionId)
    const segments = await this.storage.listCompactSegments(sessionId)
    const compactedRanges = segments.map(s => s.turnRange)
    const visibleTurns = turns.filter(turn => !compactedRanges.some(([from, to]) => turn.index >= from && turn.index <= to))
    const logicalTurns = toLogicalTurns(visibleTurns)
    const totalTurns = logicalTurns.length
    const k = Math.max(1, this.config.context.protectedRecentTurns)

    const protectedTurns = logicalTurns.slice(Math.max(0, totalTurns - k))
    const nonProtectedTurns = logicalTurns.slice(0, Math.max(0, totalTurns - k))

    let taskAnchor: V2TaskAnchor = emptyAnchor()
    let taskAnchorBlock = ''
    if (isLegacyProfile) {
      const tasks = await this.storage.listTasks(projectId)
      const activeTask = tasks.find(t => t.status !== 'done') ?? tasks[0]
      taskAnchor = activeTask
        ? {
            currentGoal: activeTask.currentGoal,
            nowDoing: activeTask.nowDoing,
            blockedBy: activeTask.blockedBy,
            nextAction: activeTask.nextAction
          }
        : emptyAnchor()

      taskAnchorBlock = [
        '## Task Anchor',
        `CurrentGoal: ${taskAnchor.currentGoal}`,
        `NowDoing: ${taskAnchor.nowDoing}`,
        `BlockedBy: ${taskAnchor.blockedBy.length > 0 ? taskAnchor.blockedBy.join('; ') : 'None'}`,
        `NextAction: ${taskAnchor.nextAction}`
      ].join('\n')
    }

    const retrievalQuery = input.query?.trim()
      ? input.query
      : `${taskAnchor.currentGoal} ${taskAnchor.nowDoing} ${taskAnchor.nextAction}`.trim()

    let memoryBlocks: string[] = []
    let evidenceBlocks: string[] = []
    if (isLegacyProfile) {
      ({ memoryBlocks, evidenceBlocks } = await this.retrieveCards(projectId, retrievalQuery))
    } else {
      this.emit(
        'retrieval.profile.skipped',
        { profile: this.config.profile, queryTokens: tokenize(retrievalQuery).length },
        `retrieval skipped profile=${this.config.profile}`
      )
    }

    const memoryCardsBlock = isLegacyProfile
      ? (memoryBlocks.length > 0 ? `## Memory Cards\n${memoryBlocks.join('\n')}` : '## Memory Cards\n- none')
      : ''
    const evidenceCardsBlock = isLegacyProfile
      ? (evidenceBlocks.length > 0 ? `## Evidence Cards\n${evidenceBlocks.join('\n')}` : '## Evidence Cards\n- none')
      : ''

    const nonProtectedBlocks = nonProtectedTurns.map(t => renderLogicalTurn(t, this.config.context.includeToolMessagesInProtectedZone))
    const protectedBlocks = protectedTurns.map(t => renderLogicalTurn(t, this.config.context.includeToolMessagesInProtectedZone))

    const optionalExpansionBlock = input.selectedContext
      ? `## Optional Expansion\n${input.selectedContext}`
      : ''

    const requiredProtectedBlock = protectedBlocks.length > 0
      ? `## Protected Recent Turns\n${protectedBlocks.join('\n\n')}`
      : '## Protected Recent Turns\n- none'

    const requiredTokens = {
      protectedTurns: countTokens(requiredProtectedBlock),
      taskAnchor: isLegacyProfile ? countTokens(taskAnchorBlock) : 0
    }

    const desiredOptionalTokens = {
      memoryCards: isLegacyProfile ? countTokens(memoryCardsBlock) : 0,
      evidenceCards: isLegacyProfile ? countTokens(evidenceCardsBlock) : 0,
      nonProtectedTurns: countTokens(nonProtectedBlocks.join('\n\n')),
      optionalExpansion: optionalExpansionBlock ? countTokens(optionalExpansionBlock) : 0
    }

    const budgetPlan = this.planner.plan({
      contextWindow: this.config.contextWindow,
      outputReserve: this.config.budget.reserveOutput.intermediate,
      fixedTokens: input.systemPromptTokens + input.toolSchemasTokens,
      requiredTokens,
      desiredOptionalTokens
    })

    const selectedNonProtected = takeByBudget(
      nonProtectedBlocks.slice().reverse(),
      budgetPlan.allocations.nonProtectedTurns
    ).reverse()

    const selectedMemory = isLegacyProfile
      ? takeByBudget(memoryBlocks, budgetPlan.allocations.memoryCards)
      : []

    const selectedEvidence = isLegacyProfile
      ? takeByBudget(evidenceBlocks, budgetPlan.allocations.evidenceCards)
      : []

    let selectedExpansion = ''
    if (optionalExpansionBlock && budgetPlan.allocations.optionalExpansion > 0) {
      const expansionTokens = countTokens(optionalExpansionBlock)
      selectedExpansion = expansionTokens <= budgetPlan.allocations.optionalExpansion
        ? optionalExpansionBlock
        : ''
    }

    const memorySection = selectedMemory.length > 0
      ? `## Memory Cards\n${selectedMemory.join('\n')}`
      : '## Memory Cards\n- none'

    const evidenceSection = selectedEvidence.length > 0
      ? `## Evidence Cards\n${selectedEvidence.join('\n')}`
      : '## Evidence Cards\n- none'

    const historySection = selectedNonProtected.length > 0
      ? `## Non-Protected History\n${selectedNonProtected.join('\n\n')}`
      : '## Non-Protected History\n- none'

    const continuityRecords = this.config.continuity.injectPreviousSessionSummary
      ? await this.storage.listRecentContinuity(projectId, sessionId, this.config.continuity.maxPreviousSessions)
      : []
    const continuityBlock = continuityRecords.length > 0
      ? `## Continuity\n${continuityRecords.map(c => `- ${c.summary}`).join('\n')}`
      : '## Continuity\n- none'

    const protectedSelection = selectProtectedBlocksByTokenBudget(
      protectedBlocks,
      budgetPlan.protectedTurnsTarget
    )

    const parts = [continuityBlock, historySection]

    if (isLegacyProfile) {
      parts.splice(1, 0, memorySection, evidenceSection)
    }

    if (selectedExpansion) {
      parts.push(selectedExpansion)
    }

    parts.push(`## Protected Recent Turns\n${protectedSelection.selected.length > 0 ? protectedSelection.selected.join('\n\n') : '- none'}`)

    if (isLegacyProfile && this.config.context.tailTaskAnchor) {
      parts.push(taskAnchorBlock)
    }

    const assembled = parts.join('\n\n')
    const wrapped = '<working-context>\n'
      + 'The following is runtime-assembled project/session context. Use it as reference, prioritize the latest user request.\n\n'
      + assembled
      + '\n</working-context>'

    return {
      workingContextBlock: `\n\n${wrapped}`,
      taskAnchor,
      promptTokensEstimate: countTokens(assembled),
      protectedTurnsRequested: protectedTurns.length,
      protectedTurnsKept: protectedSelection.selected.length,
      protectedTurnsDropped: protectedSelection.dropped,
      degradedZones: budgetPlan.degradedZones,
      failSafeMode: budgetPlan.failSafeMode
    }
  }
}
