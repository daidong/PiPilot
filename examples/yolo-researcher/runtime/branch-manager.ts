import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { YoloStage } from './types.js'
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from './utils.js'

export interface BranchNode {
  nodeId: string
  branchId: string
  parentNodeId?: string
  stage: YoloStage
  hypothesisIds: string[]
  openRisks: string[]
  evidenceDebt: string[]
  confidenceBand: 'high' | 'medium' | 'low'
  status: 'active' | 'paused' | 'merged' | 'pruned' | 'invalidated'
  summary: string
  mergedFrom?: string[]
  createdByTurn?: number
  createdByAttempt?: number
}

interface BranchTreeIndex {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodeIds: string[]
}

export class DegenerateBranchManager {
  readonly branchesDir: string
  readonly nodesDir: string
  readonly treePath: string

  constructor(
    private readonly sessionDir: string
  ) {
    this.branchesDir = path.join(sessionDir, 'branches')
    this.nodesDir = path.join(this.branchesDir, 'nodes')
    this.treePath = path.join(this.branchesDir, 'tree.json')
  }

  async init(initialStage: YoloStage = 'S1'): Promise<{ tree: BranchTreeIndex; activeNode: BranchNode }> {
    await ensureDir(this.nodesDir)

    if (await fileExists(this.treePath)) {
      const tree = await readJsonFile<BranchTreeIndex>(this.treePath)
      const activeNode = await this.getNode(tree.activeNodeId)
      if (!activeNode) {
        throw new Error(`active node ${tree.activeNodeId} missing`)
      }
      return { tree, activeNode }
    }

    const rootNode: BranchNode = {
      nodeId: 'N-001',
      branchId: 'B-001',
      stage: initialStage,
      hypothesisIds: [],
      openRisks: [],
      evidenceDebt: [],
      confidenceBand: 'medium',
      status: 'active',
      summary: 'initial node',
      createdByTurn: 0,
      createdByAttempt: 0
    }

    const tree: BranchTreeIndex = {
      activeBranchId: rootNode.branchId,
      activeNodeId: rootNode.nodeId,
      rootNodeId: rootNode.nodeId,
      nodeIds: [rootNode.nodeId]
    }

    await this.writeNode(rootNode)
    await writeJsonFile(this.treePath, tree)
    return { tree, activeNode: rootNode }
  }

  async getTree(): Promise<BranchTreeIndex> {
    return readJsonFile<BranchTreeIndex>(this.treePath)
  }

  async getNode(nodeId: string): Promise<BranchNode | undefined> {
    const nodePath = this.nodePath(nodeId)
    if (!(await fileExists(nodePath))) return undefined
    return readJsonFile<BranchNode>(nodePath)
  }

  async getActiveNode(): Promise<BranchNode> {
    const tree = await this.getTree()
    const activeNode = await this.getNode(tree.activeNodeId)
    if (!activeNode) throw new Error(`active node ${tree.activeNodeId} missing`)
    return activeNode
  }

  async advance(input: {
    stage: YoloStage
    summary: string
    hypothesisIds?: string[]
    openRisks?: string[]
    evidenceDebt?: string[]
    createdByTurn?: number
    createdByAttempt?: number
  }): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    const tree = await this.getTree()
    const previousNode = await this.getActiveNode()
    const nextNodeId = this.nextNodeId(tree.nodeIds)

    const nextNode: BranchNode = {
      nodeId: nextNodeId,
      branchId: tree.activeBranchId,
      parentNodeId: previousNode.nodeId,
      stage: input.stage,
      hypothesisIds: input.hypothesisIds ?? previousNode.hypothesisIds,
      openRisks: input.openRisks ?? previousNode.openRisks,
      evidenceDebt: input.evidenceDebt ?? previousNode.evidenceDebt,
      confidenceBand: previousNode.confidenceBand,
      status: 'active',
      summary: input.summary,
      createdByTurn: input.createdByTurn,
      createdByAttempt: input.createdByAttempt
    }

    const pausedPreviousNode: BranchNode = { ...previousNode, status: 'paused' }

    await this.writeNode(pausedPreviousNode)
    await this.writeNode(nextNode)

    const nextTree: BranchTreeIndex = {
      ...tree,
      activeNodeId: nextNodeId,
      nodeIds: [...tree.nodeIds, nextNodeId]
    }
    await writeJsonFile(this.treePath, nextTree)

    return { previousNode: pausedPreviousNode, nextNode }
  }

  async fork(input?: {
    stage?: YoloStage
    summary?: string
    targetNodeId?: string
    sourceNodeStatus?: 'paused' | 'invalidated'
    hypothesisIds?: string[]
    openRisks?: string[]
    evidenceDebt?: string[]
    createdByTurn?: number
    createdByAttempt?: number
  }): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    if (!input?.stage) throw new Error('fork requires stage')
    if (!input.summary?.trim()) throw new Error('fork requires summary')

    const tree = await this.getTree()
    const previousNode = await this.getActiveNode()
    const forkFromNode = input.targetNodeId
      ? await this.requireNode(input.targetNodeId)
      : previousNode

    const nextNode: BranchNode = {
      nodeId: this.nextNodeId(tree.nodeIds),
      branchId: this.nextBranchId(await this.getAllNodes(tree)),
      parentNodeId: forkFromNode.nodeId,
      stage: input.stage,
      hypothesisIds: input.hypothesisIds ?? forkFromNode.hypothesisIds,
      openRisks: input.openRisks ?? forkFromNode.openRisks,
      evidenceDebt: input.evidenceDebt ?? forkFromNode.evidenceDebt,
      confidenceBand: forkFromNode.confidenceBand,
      status: 'active',
      summary: input.summary,
      createdByTurn: input.createdByTurn,
      createdByAttempt: input.createdByAttempt
    }

    const sourceNodeStatus = input.sourceNodeStatus ?? 'paused'
    const updatedPreviousNode: BranchNode = { ...previousNode, status: sourceNodeStatus }
    await this.writeNode(updatedPreviousNode)
    await this.writeNode(nextNode)

    const nextTree: BranchTreeIndex = {
      ...tree,
      activeBranchId: nextNode.branchId,
      activeNodeId: nextNode.nodeId,
      nodeIds: [...tree.nodeIds, nextNode.nodeId]
    }
    await writeJsonFile(this.treePath, nextTree)

    return { previousNode: updatedPreviousNode, nextNode }
  }

  async revisit(input?: {
    targetNodeId?: string
    allowInvalidatedOverride?: boolean
  }): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    if (!input?.targetNodeId) throw new Error('revisit requires targetNodeId')

    const tree = await this.getTree()
    const previousNode = await this.getActiveNode()
    const targetNode = await this.requireNode(input.targetNodeId)
    this.ensureReactivatable(targetNode, 'revisit', input.allowInvalidatedOverride ?? false)

    const pausedPreviousNode: BranchNode = { ...previousNode, status: 'paused' }
    const activeTargetNode: BranchNode = { ...targetNode, status: 'active' }

    await this.writeNode(pausedPreviousNode)
    await this.writeNode(activeTargetNode)
    await writeJsonFile(this.treePath, {
      ...tree,
      activeBranchId: activeTargetNode.branchId,
      activeNodeId: activeTargetNode.nodeId
    })

    return { previousNode: pausedPreviousNode, nextNode: activeTargetNode }
  }

  async merge(input?: {
    targetNodeId?: string
    allowInvalidatedOverride?: boolean
    stage?: YoloStage
    summary?: string
    createdByTurn?: number
    createdByAttempt?: number
  }): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    if (!input?.targetNodeId) throw new Error('merge requires targetNodeId')
    if (!input.stage) throw new Error('merge requires stage')
    if (!input.summary?.trim()) throw new Error('merge requires summary')

    const tree = await this.getTree()
    const previousNode = await this.getActiveNode()
    const targetNode = await this.requireNode(input.targetNodeId)
    this.ensureReactivatable(targetNode, 'merge', input.allowInvalidatedOverride ?? false)

    if (targetNode.nodeId === previousNode.nodeId) {
      throw new Error('merge target must differ from active node')
    }

    const nextNode: BranchNode = {
      nodeId: this.nextNodeId(tree.nodeIds),
      branchId: targetNode.branchId,
      parentNodeId: targetNode.nodeId,
      stage: input.stage,
      hypothesisIds: this.union(previousNode.hypothesisIds, targetNode.hypothesisIds),
      openRisks: this.union(previousNode.openRisks, targetNode.openRisks),
      evidenceDebt: this.union(previousNode.evidenceDebt, targetNode.evidenceDebt),
      confidenceBand: targetNode.confidenceBand,
      status: 'active',
      summary: input.summary,
      mergedFrom: [previousNode.nodeId],
      createdByTurn: input.createdByTurn,
      createdByAttempt: input.createdByAttempt
    }

    const mergedPreviousNode: BranchNode = { ...previousNode, status: 'merged' }
    const pausedTargetNode: BranchNode = { ...targetNode, status: 'paused' }

    await this.writeNode(mergedPreviousNode)
    await this.writeNode(pausedTargetNode)
    await this.writeNode(nextNode)
    await writeJsonFile(this.treePath, {
      ...tree,
      activeBranchId: nextNode.branchId,
      activeNodeId: nextNode.nodeId,
      nodeIds: [...tree.nodeIds, nextNode.nodeId]
    })

    return { previousNode: mergedPreviousNode, nextNode }
  }

  async prune(input: {
    targetNodeId?: string
    allowInvalidatedOverride?: boolean
  } = {}): Promise<{ previousNode: BranchNode; nextNode: BranchNode }> {
    const tree = await this.getTree()
    const previousNode = await this.getActiveNode()

    let targetNodeId = input.targetNodeId
    if (!targetNodeId) {
      targetNodeId = previousNode.parentNodeId
    }
    if (!targetNodeId) {
      throw new Error('cannot prune root node without explicit target')
    }

    const targetNode = await this.requireNode(targetNodeId)
    this.ensureReactivatable(targetNode, 'prune', input.allowInvalidatedOverride ?? false)

    const prunedNode: BranchNode = { ...previousNode, status: 'pruned' }
    const activeTargetNode: BranchNode = { ...targetNode, status: 'active' }

    await this.writeNode(prunedNode)
    await this.writeNode(activeTargetNode)
    await writeJsonFile(this.treePath, {
      ...tree,
      activeBranchId: activeTargetNode.branchId,
      activeNodeId: activeTargetNode.nodeId
    })

    return { previousNode: prunedNode, nextNode: activeTargetNode }
  }

  async removeNodesForTurns(turnNumbers: number[]): Promise<string[]> {
    const tree = await this.getTree()
    const removed: string[] = []
    const allNodes = await this.getAllNodes(tree)
    const turns = new Set(turnNumbers)
    const removableNodeIds = allNodes
      .filter((node) => typeof node.createdByTurn === 'number' && turns.has(node.createdByTurn))
      .map((node) => node.nodeId)

    for (const nodeId of removableNodeIds) {
      if (!tree.nodeIds.includes(nodeId)) continue
      await fs.rm(this.nodePath(nodeId), { force: true })
      removed.push(path.join('branches', 'nodes', `${nodeId}.json`))
    }

    if (removed.length > 0) {
      const removedSet = new Set(removed.map((entry) => entry.replace(/^.*\//, '').replace(/\.json$/, '')))
      const keptNodeIds = tree.nodeIds.filter((id) => !removedSet.has(id))
      const fallbackActiveNodeId = keptNodeIds[keptNodeIds.length - 1] ?? tree.rootNodeId
      const fallbackActiveNode = await this.getNode(fallbackActiveNodeId)
      if (fallbackActiveNode) {
        await this.writeNode({ ...fallbackActiveNode, status: 'active' })
      }

      const nextTree: BranchTreeIndex = {
        ...tree,
        nodeIds: keptNodeIds,
        activeNodeId: fallbackActiveNodeId
      }
      await writeJsonFile(this.treePath, nextTree)
    }

    return removed
  }

  private nodePath(nodeId: string): string {
    return path.join(this.nodesDir, `${nodeId}.json`)
  }

  private async writeNode(node: BranchNode): Promise<void> {
    await writeJsonFile(this.nodePath(node.nodeId), node)
  }

  private async requireNode(nodeId: string): Promise<BranchNode> {
    const node = await this.getNode(nodeId)
    if (!node) throw new Error(`branch node not found: ${nodeId}`)
    return node
  }

  private ensureReactivatable(
    node: BranchNode,
    action: 'revisit' | 'merge' | 'prune',
    allowInvalidatedOverride: boolean
  ): void {
    if (node.status === 'invalidated' && !allowInvalidatedOverride) {
      throw new Error(`cannot ${action} to node ${node.nodeId} with status invalidated (override decision required)`)
    }
    if (node.status === 'pruned' || node.status === 'merged') {
      throw new Error(`cannot ${action} to node ${node.nodeId} with status ${node.status}`)
    }
  }

  private nextNodeId(nodeIds: string[]): string {
    const max = nodeIds.reduce((acc, id) => Math.max(acc, this.extractNumericSuffix(id)), 0)
    return `N-${(max + 1).toString().padStart(3, '0')}`
  }

  private nextBranchId(nodes: BranchNode[]): string {
    const max = nodes.reduce((acc, node) => Math.max(acc, this.extractNumericSuffix(node.branchId)), 0)
    return `B-${(max + 1).toString().padStart(3, '0')}`
  }

  private extractNumericSuffix(value: string): number {
    const match = value.match(/-(\d+)$/)
    if (!match) return 0
    return Number.parseInt(match[1], 10) || 0
  }

  private union(left: string[], right: string[]): string[] {
    return [...new Set([...left, ...right])]
  }

  private async getAllNodes(tree: BranchTreeIndex): Promise<BranchNode[]> {
    const nodes = await Promise.all(tree.nodeIds.map((nodeId) => this.getNode(nodeId)))
    return nodes.filter((node): node is BranchNode => Boolean(node))
  }
}
