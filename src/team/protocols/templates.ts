/**
 * Protocol Templates - Pre-built multi-agent collaboration patterns
 *
 * These templates provide common patterns for multi-agent workflows.
 * Users can use them directly or customize them for their needs.
 */

import type { FlowSpec } from '../flow/ast.js'
import {
  invoke,
  seq,
  par,
  loop,
  gate,
  race,
  supervise,
  input,
  until,
  pred,
  join
} from '../flow/combinators.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Protocol template definition
 */
export interface ProtocolTemplate {
  /** Unique protocol ID */
  id: string
  /** Human-readable name */
  name: string
  /** Description of the pattern */
  description: string
  /** Required agent roles */
  requiredRoles: string[]
  /** Optional agent roles */
  optionalRoles?: string[]
  /** Default configuration */
  defaults?: Record<string, unknown>
  /** Generate the flow specification */
  build: (config: ProtocolConfig) => FlowSpec
}

/**
 * Configuration for building a protocol
 */
export interface ProtocolConfig {
  /** Agent ID mapping: role -> agentId */
  agents: Record<string, string>
  /** Protocol-specific options */
  options?: Record<string, unknown>
}

// ============================================================================
// Pipeline Protocol
// ============================================================================

/**
 * Sequential pipeline - agents process in order, passing output forward
 *
 * Pattern: A -> B -> C -> ...
 *
 * @example
 * pipeline.build({
 *   agents: { stages: ['researcher', 'drafter', 'reviewer'] }
 * })
 */
export const pipeline: ProtocolTemplate = {
  id: 'pipeline',
  name: 'Sequential Pipeline',
  description: 'Process data through a sequence of agents, each receiving the previous output',
  requiredRoles: ['stages'],
  build: (config) => {
    const stages = config.agents['stages']
    if (!stages || !Array.isArray(stages)) {
      throw new Error('Pipeline requires stages array')
    }

    if (stages.length === 0) {
      throw new Error('Pipeline requires at least one stage')
    }

    if (stages.length === 1) {
      return invoke(stages[0], input.initial())
    }

    const steps: FlowSpec[] = stages.map((agentId, index) =>
      invoke(agentId, index === 0 ? input.initial() : input.prev())
    )

    return seq(...steps)
  }
}

// ============================================================================
// Fan-Out / Fan-In Protocol
// ============================================================================

/**
 * Fan-out/fan-in - parallel processing with result aggregation
 *
 * Pattern:
 *        -> Worker1 ->
 * Input  -> Worker2 ->  Merge -> Output
 *        -> Worker3 ->
 *
 * @example
 * fanOutFanIn.build({
 *   agents: { workers: ['analyst1', 'analyst2', 'analyst3'] },
 *   options: { reducer: 'merge' }
 * })
 */
export const fanOutFanIn: ProtocolTemplate = {
  id: 'fan-out-fan-in',
  name: 'Fan-Out / Fan-In',
  description: 'Distribute work to parallel workers and merge results',
  requiredRoles: ['workers'],
  defaults: { reducer: 'merge' },
  build: (config) => {
    const workers = config.agents['workers']
    if (!workers || !Array.isArray(workers)) {
      throw new Error('Fan-out/fan-in requires workers array')
    }

    const reducer = (config.options?.['reducer'] as string) ?? 'merge'

    const branches = workers.map(agentId =>
      invoke(agentId, input.initial())
    )

    return par(branches, join(reducer))
  }
}

// ============================================================================
// Supervisor Protocol
// ============================================================================

/**
 * Supervisor - one agent orchestrates others
 *
 * Pattern:
 * Supervisor plans -> Workers execute -> Supervisor reviews
 *
 * @example
 * supervisor.build({
 *   agents: {
 *     supervisor: 'manager',
 *     workers: ['dev1', 'dev2']
 *   },
 *   options: { strategy: 'parallel' }
 * })
 */
export const supervisorProtocol: ProtocolTemplate = {
  id: 'supervisor',
  name: 'Supervisor',
  description: 'A supervisor agent orchestrates worker agents',
  requiredRoles: ['supervisor', 'workers'],
  defaults: { strategy: 'parallel', reducer: 'merge' },
  build: (config) => {
    const supervisorId = config.agents['supervisor']
    const workers = config.agents['workers']

    if (!supervisorId || typeof supervisorId !== 'string') {
      throw new Error('Supervisor protocol requires supervisor agent')
    }
    if (!workers || !Array.isArray(workers)) {
      throw new Error('Supervisor protocol requires workers array')
    }

    const strategy = (config.options?.['strategy'] as 'sequential' | 'parallel' | 'dynamic') ?? 'parallel'
    const reducer = (config.options?.['reducer'] as string) ?? 'merge'

    let workersFlow: FlowSpec

    if (strategy === 'sequential') {
      const steps = workers.map((agentId, index) =>
        invoke(agentId, index === 0 ? input.prev() : input.prev())
      )
      workersFlow = seq(...steps)
    } else {
      const branches = workers.map(agentId =>
        invoke(agentId, input.prev())
      )
      workersFlow = par(branches, join(reducer))
    }

    return supervise(
      invoke(supervisorId, input.initial()),
      workersFlow,
      join(reducer),
      strategy
    )
  }
}

// ============================================================================
// Critic-Refine Loop Protocol
// ============================================================================

/**
 * Critic-refine loop - iterative improvement until quality threshold
 *
 * Pattern:
 * Producer -> Critic -> (if issues) Refiner -> Critic -> ...
 *
 * @example
 * criticRefineLoop.build({
 *   agents: {
 *     producer: 'writer',
 *     critic: 'reviewer',
 *     refiner: 'editor'
 *   },
 *   options: { maxIterations: 3 }
 * })
 */
export const criticRefineLoop: ProtocolTemplate = {
  id: 'critic-refine-loop',
  name: 'Critic-Refine Loop',
  description: 'Iteratively refine output until critic approval',
  requiredRoles: ['producer', 'critic', 'refiner'],
  defaults: { maxIterations: 3, reviewsPath: 'reviews' },
  build: (config) => {
    const producerId = config.agents['producer']
    const criticId = config.agents['critic']
    const refinerId = config.agents['refiner']

    if (!producerId || !criticId || !refinerId) {
      throw new Error('Critic-refine loop requires producer, critic, and refiner agents')
    }

    const maxIterations = (config.options?.['maxIterations'] as number) ?? 3
    const reviewsPath = (config.options?.['reviewsPath'] as string) ?? 'reviews'

    return seq(
      // Initial production
      invoke(producerId, input.initial(), { outputAs: { path: 'draft' } }),

      // Refine loop
      loop(
        seq(
          invoke(criticId, input.state('draft'), { outputAs: { path: reviewsPath } }),
          invoke(refinerId, input.prev(), { outputAs: { path: 'draft' } })
        ),
        until.noCriticalIssues(reviewsPath),
        { maxIters: maxIterations }
      )
    )
  }
}

// ============================================================================
// Debate Protocol
// ============================================================================

/**
 * Debate - multiple agents argue perspectives, judge decides
 *
 * Pattern:
 * Debaters (parallel) -> Judge -> Decision
 *
 * @example
 * debate.build({
 *   agents: {
 *     debaters: ['proponent', 'opponent'],
 *     judge: 'arbitrator'
 *   }
 * })
 */
export const debate: ProtocolTemplate = {
  id: 'debate',
  name: 'Debate',
  description: 'Multiple agents present arguments, a judge makes the final decision',
  requiredRoles: ['debaters', 'judge'],
  defaults: { rounds: 1 },
  build: (config) => {
    const debaters = config.agents['debaters']
    const judgeId = config.agents['judge']

    if (!debaters || !Array.isArray(debaters) || debaters.length < 2) {
      throw new Error('Debate requires at least 2 debaters')
    }
    if (!judgeId || typeof judgeId !== 'string') {
      throw new Error('Debate requires a judge')
    }

    const rounds = (config.options?.['rounds'] as number) ?? 1

    // Build debate rounds
    const debaterBranches = debaters.map(agentId =>
      invoke(agentId, input.initial())
    )

    const debateRound = par(debaterBranches, join('collect'))

    if (rounds === 1) {
      return seq(
        debateRound,
        invoke(judgeId, input.prev())
      )
    }

    // Multiple rounds
    return seq(
      loop(
        debateRound,
        until.predicate(pred.gte('round', rounds)),
        { maxIters: rounds }
      ),
      invoke(judgeId, input.prev())
    )
  }
}

// ============================================================================
// Voting Protocol
// ============================================================================

/**
 * Voting - multiple agents vote, majority wins
 *
 * Pattern:
 * Voters (parallel) -> Vote reducer -> Winner
 *
 * @example
 * voting.build({
 *   agents: { voters: ['expert1', 'expert2', 'expert3'] }
 * })
 */
export const voting: ProtocolTemplate = {
  id: 'voting',
  name: 'Voting',
  description: 'Multiple agents vote on a decision',
  requiredRoles: ['voters'],
  build: (config) => {
    const voters = config.agents['voters']

    if (!voters || !Array.isArray(voters) || voters.length < 2) {
      throw new Error('Voting requires at least 2 voters')
    }

    const voterBranches = voters.map(agentId =>
      invoke(agentId, input.initial())
    )

    return par(voterBranches, join('vote'))
  }
}

// ============================================================================
// Race Protocol
// ============================================================================

/**
 * Race - first successful result wins
 *
 * Pattern:
 * Racers (parallel) -> First success -> Winner
 *
 * @example
 * raceProtocol.build({
 *   agents: { racers: ['fast', 'accurate', 'creative'] }
 * })
 */
export const raceProtocol: ProtocolTemplate = {
  id: 'race',
  name: 'Race',
  description: 'Multiple agents race to complete, first success wins',
  requiredRoles: ['racers'],
  build: (config) => {
    const racers = config.agents['racers']

    if (!racers || !Array.isArray(racers) || racers.length < 2) {
      throw new Error('Race requires at least 2 racers')
    }

    const racerBranches = racers.map(agentId =>
      invoke(agentId, input.initial())
    )

    return race(racerBranches, { type: 'firstSuccess' })
  }
}

// ============================================================================
// Gated Pipeline Protocol
// ============================================================================

/**
 * Gated pipeline - pipeline with approval gates
 *
 * Pattern:
 * Stage1 -> Gate1 -> Stage2 -> Gate2 -> ...
 *
 * @example
 * gatedPipeline.build({
 *   agents: {
 *     stages: ['drafter', 'reviewer', 'publisher'],
 *     validators: ['quality-check', 'compliance-check']
 *   }
 * })
 */
export const gatedPipeline: ProtocolTemplate = {
  id: 'gated-pipeline',
  name: 'Gated Pipeline',
  description: 'Pipeline with validation gates between stages',
  requiredRoles: ['stages'],
  optionalRoles: ['validators', 'fallback'],
  build: (config) => {
    const stages = config.agents['stages']
    const validators = config.agents['validators'] as string[] | undefined
    const fallbackId = config.agents['fallback'] as string | undefined

    if (!stages || !Array.isArray(stages) || stages.length === 0) {
      throw new Error('Gated pipeline requires stages array')
    }

    const steps: FlowSpec[] = []

    stages.forEach((agentId, index) => {
      // Add stage
      steps.push(invoke(agentId, index === 0 ? input.initial() : input.prev()))

      // Add gate after stage (except last)
      if (validators && index < stages.length - 1) {
        const validatorId = validators[index % validators.length]
        if (validatorId) {
          const fallback = fallbackId
            ? invoke(fallbackId, input.prev())
            : invoke(agentId, input.prev()) // Re-run same stage as fallback

          steps.push(
            gate(
              { type: 'validator', validatorId, input: input.prev() },
              invoke(stages[index + 1] ?? agentId, input.prev()),
              fallback
            )
          )
        }
      }
    })

    return seq(...steps)
  }
}

// ============================================================================
// Protocol Registry
// ============================================================================

/**
 * All built-in protocol templates
 */
export const builtinProtocols: ProtocolTemplate[] = [
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline
]

/**
 * Protocol registry
 */
export class ProtocolRegistry {
  private protocols = new Map<string, ProtocolTemplate>()

  constructor() {
    // Register built-in protocols
    for (const protocol of builtinProtocols) {
      this.register(protocol)
    }
  }

  /**
   * Register a protocol template
   */
  register(protocol: ProtocolTemplate): void {
    if (this.protocols.has(protocol.id)) {
      throw new Error(`Protocol already registered: ${protocol.id}`)
    }
    this.protocols.set(protocol.id, protocol)
  }

  /**
   * Get a protocol by ID
   */
  get(id: string): ProtocolTemplate | undefined {
    return this.protocols.get(id)
  }

  /**
   * Build a flow from a protocol
   */
  build(protocolId: string, config: ProtocolConfig): FlowSpec {
    const protocol = this.protocols.get(protocolId)
    if (!protocol) {
      throw new Error(`Protocol not found: ${protocolId}`)
    }

    // Validate required roles
    for (const role of protocol.requiredRoles) {
      if (!config.agents[role]) {
        throw new Error(`Protocol ${protocolId} requires agent for role: ${role}`)
      }
    }

    // Merge defaults
    const mergedConfig: ProtocolConfig = {
      agents: config.agents,
      options: { ...protocol.defaults, ...config.options }
    }

    return protocol.build(mergedConfig)
  }

  /**
   * List all protocol IDs
   */
  list(): string[] {
    return Array.from(this.protocols.keys())
  }

  /**
   * Check if protocol exists
   */
  has(id: string): boolean {
    return this.protocols.has(id)
  }
}

/**
 * Create a protocol registry with built-in protocols
 */
export function createProtocolRegistry(): ProtocolRegistry {
  return new ProtocolRegistry()
}
