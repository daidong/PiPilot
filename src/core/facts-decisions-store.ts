/**
 * FactsDecisionsStore - Storage for long-term facts and decisions
 *
 * Facts: Learned preferences, constraints, and knowledge
 * Decisions: Commitments with lifecycle (active → deprecated → superseded)
 *
 * Storage structure:
 * .agent-foundry/memory/
 * ├── facts.json       # All facts
 * └── decisions.json   # All decisions
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  Fact,
  Decision,
  FactsData,
  DecisionsData,
  FactsDecisionsStore,
  FactFilter,
  DecisionFilter
} from '../types/session.js'
import { generateFactId, generateDecisionId } from '../types/session.js'

/**
 * Simple tokenizer for search
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2)
}

/**
 * File-based facts and decisions store implementation
 */
export class FileFactsDecisionsStore implements FactsDecisionsStore {
  private basePath: string
  private factsPath: string
  private decisionsPath: string
  private factsData: FactsData | null = null
  private decisionsData: DecisionsData | null = null
  private initialized = false

  constructor(projectPath: string) {
    this.basePath = path.join(projectPath, '.agent-foundry', 'memory')
    this.factsPath = path.join(this.basePath, 'facts.json')
    this.decisionsPath = path.join(this.basePath, 'decisions.json')
  }

  async init(): Promise<void> {
    if (this.initialized) return

    // Ensure directory exists
    await fs.mkdir(this.basePath, { recursive: true })

    // Load or create facts
    try {
      const content = await fs.readFile(this.factsPath, 'utf-8')
      this.factsData = JSON.parse(content)
    } catch {
      this.factsData = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        facts: []
      }
      await this.saveFacts()
    }

    // Load or create decisions
    try {
      const content = await fs.readFile(this.decisionsPath, 'utf-8')
      this.decisionsData = JSON.parse(content)
    } catch {
      this.decisionsData = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        decisions: []
      }
      await this.saveDecisions()
    }

    this.initialized = true
  }

  async close(): Promise<void> {
    if (this.factsData) {
      await this.saveFacts()
    }
    if (this.decisionsData) {
      await this.saveDecisions()
    }
    this.initialized = false
  }

  private async saveFacts(): Promise<void> {
    if (!this.factsData) return
    this.factsData.updatedAt = new Date().toISOString()
    await fs.writeFile(this.factsPath, JSON.stringify(this.factsData, null, 2), 'utf-8')
  }

  private async saveDecisions(): Promise<void> {
    if (!this.decisionsData) return
    this.decisionsData.updatedAt = new Date().toISOString()
    await fs.writeFile(this.decisionsPath, JSON.stringify(this.decisionsData, null, 2), 'utf-8')
  }

  // ============ Facts CRUD ============

  async addFact(factData: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<Fact> {
    await this.init()

    const now = new Date().toISOString()
    const fact: Fact = {
      ...factData,
      id: generateFactId(),
      createdAt: now,
      updatedAt: now
    }

    this.factsData!.facts.push(fact)
    await this.saveFacts()

    return fact
  }

  async updateFact(
    id: string,
    updates: Partial<Pick<Fact, 'content' | 'topics' | 'confidence'>>
  ): Promise<Fact | null> {
    await this.init()

    const factIndex = this.factsData!.facts.findIndex(f => f.id === id)
    if (factIndex === -1) return null

    const fact = this.factsData!.facts[factIndex]!
    const updatedFact: Fact = {
      ...fact,
      ...updates,
      updatedAt: new Date().toISOString()
    }

    this.factsData!.facts[factIndex] = updatedFact
    await this.saveFacts()

    return updatedFact
  }

  async getFact(id: string): Promise<Fact | null> {
    await this.init()
    return this.factsData!.facts.find(f => f.id === id) ?? null
  }

  async getFacts(filter?: FactFilter): Promise<Fact[]> {
    await this.init()

    let facts = [...this.factsData!.facts]

    // Filter by topics
    if (filter?.topics && filter.topics.length > 0) {
      facts = facts.filter(f =>
        filter.topics!.some(topic => f.topics.includes(topic))
      )
    }

    // Filter by confidence
    if (filter?.confidence && filter.confidence !== 'all') {
      facts = facts.filter(f => f.confidence === filter.confidence)
    }

    // Filter by query
    if (filter?.query) {
      const queryTokens = tokenize(filter.query)
      facts = facts.filter(f => {
        const contentTokens = tokenize(f.content)
        return queryTokens.some(qt => contentTokens.some(ct => ct.includes(qt)))
      })
    }

    // Sort by creation date (newest first)
    facts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    // Apply limit
    if (filter?.limit) {
      facts = facts.slice(0, filter.limit)
    }

    return facts
  }

  async deleteFact(id: string): Promise<boolean> {
    await this.init()

    const initialLength = this.factsData!.facts.length
    this.factsData!.facts = this.factsData!.facts.filter(f => f.id !== id)

    if (this.factsData!.facts.length < initialLength) {
      await this.saveFacts()
      return true
    }

    return false
  }

  // ============ Decisions CRUD ============

  async addDecision(decisionData: Omit<Decision, 'id' | 'createdAt'>): Promise<Decision> {
    await this.init()

    const decision: Decision = {
      ...decisionData,
      id: generateDecisionId(),
      createdAt: new Date().toISOString()
    }

    this.decisionsData!.decisions.push(decision)
    await this.saveDecisions()

    return decision
  }

  async updateDecision(
    id: string,
    updates: Partial<Pick<Decision, 'content' | 'status'>>
  ): Promise<Decision | null> {
    await this.init()

    const decisionIndex = this.decisionsData!.decisions.findIndex(d => d.id === id)
    if (decisionIndex === -1) return null

    const decision = this.decisionsData!.decisions[decisionIndex]!
    const updatedDecision: Decision = {
      ...decision,
      ...updates
    }

    this.decisionsData!.decisions[decisionIndex] = updatedDecision
    await this.saveDecisions()

    return updatedDecision
  }

  async deprecateDecision(
    id: string,
    reason: string,
    supersededBy?: string
  ): Promise<Decision | null> {
    await this.init()

    const decisionIndex = this.decisionsData!.decisions.findIndex(d => d.id === id)
    if (decisionIndex === -1) return null

    const decision = this.decisionsData!.decisions[decisionIndex]!
    const now = new Date().toISOString()

    const deprecatedDecision: Decision = {
      ...decision,
      status: supersededBy ? 'superseded' : 'deprecated',
      deprecatedAt: now,
      deprecationReason: reason,
      supersededBy
    }

    this.decisionsData!.decisions[decisionIndex] = deprecatedDecision
    await this.saveDecisions()

    return deprecatedDecision
  }

  async getDecision(id: string): Promise<Decision | null> {
    await this.init()
    return this.decisionsData!.decisions.find(d => d.id === id) ?? null
  }

  async getDecisions(filter?: DecisionFilter): Promise<Decision[]> {
    await this.init()

    let decisions = [...this.decisionsData!.decisions]

    // Filter by status
    if (filter?.status && filter.status !== 'all') {
      decisions = decisions.filter(d => d.status === filter.status)
    }

    // Filter by query
    if (filter?.query) {
      const queryTokens = tokenize(filter.query)
      decisions = decisions.filter(d => {
        const contentTokens = tokenize(d.content)
        return queryTokens.some(qt => contentTokens.some(ct => ct.includes(qt)))
      })
    }

    // Sort by creation date (newest first)
    decisions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    // Apply limit
    if (filter?.limit) {
      decisions = decisions.slice(0, filter.limit)
    }

    return decisions
  }

  // ============ Utilities ============

  async getStats(): Promise<{
    totalFacts: number
    factsByConfidence: Record<string, number>
    factsByTopic: Record<string, number>
    totalDecisions: number
    decisionsByStatus: Record<string, number>
  }> {
    await this.init()

    const factsByConfidence: Record<string, number> = {
      confirmed: 0,
      inferred: 0
    }
    const factsByTopic: Record<string, number> = {}

    for (const fact of this.factsData!.facts) {
      factsByConfidence[fact.confidence] = (factsByConfidence[fact.confidence] ?? 0) + 1
      for (const topic of fact.topics) {
        factsByTopic[topic] = (factsByTopic[topic] ?? 0) + 1
      }
    }

    const decisionsByStatus: Record<string, number> = {
      active: 0,
      deprecated: 0,
      superseded: 0
    }

    for (const decision of this.decisionsData!.decisions) {
      decisionsByStatus[decision.status] = (decisionsByStatus[decision.status] ?? 0) + 1
    }

    return {
      totalFacts: this.factsData!.facts.length,
      factsByConfidence,
      factsByTopic,
      totalDecisions: this.decisionsData!.decisions.length,
      decisionsByStatus
    }
  }
}
