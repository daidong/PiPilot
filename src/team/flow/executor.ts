/**
 * Flow Executor - Execute FlowSpec with full tracing
 *
 * The executor walks the FlowSpec AST and executes each node,
 * recording all decisions for replay capability.
 */

import type {
  FlowSpec,
  InvokeSpec,
  SeqSpec,
  ParSpec,
  MapSpec,
  ChooseSpec,
  LoopSpec,
  GateSpec,
  RaceSpec,
  SuperviseSpec,
  BranchSpec,
  NoopSpec,
  SelectSpec,
  InputRef,
  MappedInputRef,
  PredicateSpec,
  UntilSpec
} from './ast.js'
import type { ReducerRegistry } from './reducers.js'
import type { Blackboard } from '../state/blackboard.js'
import type { AgentRegistry } from '../agent-registry.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Execution context passed to all flow nodes
 */
export interface ExecutionContext {
  /** Team run ID */
  runId: string
  /** Current step counter */
  step: number
  /** Agent registry */
  agentRegistry: AgentRegistry
  /** Reducer registry */
  reducerRegistry: ReducerRegistry
  /** Shared state */
  state: Blackboard
  /** Initial input */
  initialInput: unknown
  /** Previous step output */
  prevOutput: unknown
  /** Trace recorder */
  trace: TraceRecorder
  /** Agent invoker function */
  invokeAgent: AgentInvoker
  /** Concurrency limit */
  concurrency: number
  /** Abort signal */
  abortSignal?: AbortSignal
}

/**
 * Function to invoke a single agent
 */
export type AgentInvoker = (
  agentId: string,
  input: unknown,
  ctx: ExecutionContext
) => Promise<unknown>

/**
 * Trace recorder interface
 */
export interface TraceRecorder {
  record: (event: unknown) => void
}

/**
 * Flow trace event types
 */
export type FlowTraceEvent =
  | { type: 'flow.node.start'; runId: string; nodeId: string; kind: string; ts: number; name?: string }
  | { type: 'flow.node.end'; runId: string; nodeId: string; kind: string; ts: number; success: boolean; error?: string }
  | { type: 'agent.invoke.start'; runId: string; nodeId: string; agentId: string; ts: number }
  | { type: 'agent.invoke.end'; runId: string; nodeId: string; agentId: string; ts: number; success: boolean; error?: string }
  | { type: 'router.decision'; runId: string; nodeId: string; ts: number; routerType: string; chosen: string; evidence?: unknown }
  | { type: 'join.start'; runId: string; nodeId: string; reducerId: string; ts: number; inputsCount: number }
  | { type: 'join.end'; runId: string; nodeId: string; reducerId: string; ts: number }
  | { type: 'gate.check'; runId: string; nodeId: string; ts: number; gateType: string; passed: boolean; details?: unknown }
  | { type: 'loop.iteration'; runId: string; nodeId: string; ts: number; iteration: number; continuing: boolean }

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean
  output: unknown
  error?: string
}

// ============================================================================
// Flow Executor
// ============================================================================

/**
 * Execute a FlowSpec
 */
export async function executeFlow(
  spec: FlowSpec,
  ctx: ExecutionContext
): Promise<ExecutionResult> {
  const nodeId = spec.id ?? `${spec.kind}-${ctx.step++}`

  ctx.trace.record({
    type: 'flow.node.start',
    runId: ctx.runId,
    nodeId,
    kind: spec.kind,
    ts: Date.now(),
    name: spec.name
  })

  try {
    let result: unknown

    switch (spec.kind) {
      case 'invoke':
        result = await executeInvoke(spec, nodeId, ctx)
        break
      case 'seq':
        result = await executeSeq(spec, nodeId, ctx)
        break
      case 'par':
        result = await executePar(spec, nodeId, ctx)
        break
      case 'map':
        result = await executeMap(spec, nodeId, ctx)
        break
      case 'choose':
        result = await executeChoose(spec, nodeId, ctx)
        break
      case 'loop':
        result = await executeLoop(spec, nodeId, ctx)
        break
      case 'gate':
        result = await executeGate(spec, nodeId, ctx)
        break
      case 'race':
        result = await executeRace(spec, nodeId, ctx)
        break
      case 'supervise':
        result = await executeSupervise(spec, nodeId, ctx)
        break
      case 'branch':
        result = await executeBranch(spec, nodeId, ctx)
        break
      case 'noop':
        result = await executeNoop(spec, ctx)
        break
      case 'select':
        result = await executeSelect(spec, nodeId, ctx)
        break
      default:
        throw new Error(`Unknown flow node kind: ${(spec as FlowSpec).kind}`)
    }

    ctx.trace.record({
      type: 'flow.node.end',
      runId: ctx.runId,
      nodeId,
      kind: spec.kind,
      ts: Date.now(),
      success: true
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    ctx.trace.record({
      type: 'flow.node.end',
      runId: ctx.runId,
      nodeId,
      kind: spec.kind,
      ts: Date.now(),
      success: false,
      error: errorMessage
    })

    return { success: false, output: undefined, error: errorMessage }
  }
}

// ============================================================================
// Node Executors
// ============================================================================

async function executeInvoke(
  spec: InvokeSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Resolve input
  const input = resolveInput(spec.input, ctx)

  ctx.trace.record({
    type: 'agent.invoke.start',
    runId: ctx.runId,
    nodeId,
    agentId: spec.agent,
    ts: Date.now()
  })

  try {
    // Invoke the agent
    const output = await ctx.invokeAgent(spec.agent, input, ctx)

    // Write to state if specified
    if (spec.outputAs) {
      ctx.state.put(spec.outputAs.path, output, {
        runId: ctx.runId,
        trace: ctx.trace
      }, spec.agent)
    }

    // Update prev output
    ctx.prevOutput = output

    ctx.trace.record({
      type: 'agent.invoke.end',
      runId: ctx.runId,
      nodeId,
      agentId: spec.agent,
      ts: Date.now(),
      success: true
    })

    return output
  } catch (error) {
    ctx.trace.record({
      type: 'agent.invoke.end',
      runId: ctx.runId,
      nodeId,
      agentId: spec.agent,
      ts: Date.now(),
      success: false,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function executeSeq(
  spec: SeqSpec,
  _nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  let lastOutput: unknown = ctx.prevOutput

  for (const step of spec.steps) {
    const result = await executeFlow(step, { ...ctx, prevOutput: lastOutput })
    if (!result.success) {
      throw new Error(result.error ?? 'Sequential step failed')
    }
    lastOutput = result.output
  }

  return lastOutput
}

async function executePar(
  spec: ParSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Execute all branches in parallel
  const promises = spec.branches.map((branch, index) =>
    executeFlow(branch, { ...ctx, step: ctx.step + index * 1000 })
  )

  const results = await Promise.all(promises)

  // Check for failures
  const failures = results.filter(r => !r.success)
  if (failures.length > 0) {
    throw new Error(`${failures.length} parallel branches failed: ${failures.map(f => f.error).join('; ')}`)
  }

  // Join results
  const outputs = results.map(r => r.output)

  ctx.trace.record({
    type: 'join.start',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now(),
    inputsCount: outputs.length
  })

  const joinedOutput = ctx.reducerRegistry.apply(
    spec.join.reducerId,
    outputs,
    spec.join.args,
    { runId: ctx.runId, nodeId, trace: ctx.trace }
  )

  // Write to state if specified
  if (spec.join.outputAs) {
    ctx.state.put(spec.join.outputAs.path, joinedOutput, {
      runId: ctx.runId,
      trace: ctx.trace
    })
  }

  ctx.trace.record({
    type: 'join.end',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now()
  })

  return joinedOutput
}

async function executeMap(
  spec: MapSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Resolve items
  const items = resolveInput(spec.items, ctx) as unknown[]
  if (!Array.isArray(items)) {
    throw new Error('Map items must be an array')
  }

  const concurrency = spec.concurrency ?? ctx.concurrency

  // Execute workers with concurrency limit
  const outputs: unknown[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const promises = batch.map((item, index) =>
      executeFlow(spec.worker, {
        ...ctx,
        prevOutput: item,
        step: ctx.step + (i + index) * 1000
      })
    )

    const results = await Promise.all(promises)

    // Check for failures
    const failures = results.filter(r => !r.success)
    if (failures.length > 0) {
      throw new Error(`${failures.length} map workers failed`)
    }

    outputs.push(...results.map(r => r.output))
  }

  // Join results
  ctx.trace.record({
    type: 'join.start',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now(),
    inputsCount: outputs.length
  })

  const joinedOutput = ctx.reducerRegistry.apply(
    spec.join.reducerId,
    outputs,
    spec.join.args,
    { runId: ctx.runId, nodeId, trace: ctx.trace }
  )

  if (spec.join.outputAs) {
    ctx.state.put(spec.join.outputAs.path, joinedOutput, {
      runId: ctx.runId,
      trace: ctx.trace
    })
  }

  ctx.trace.record({
    type: 'join.end',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now()
  })

  return joinedOutput
}

async function executeChoose(
  spec: ChooseSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  let chosenRoute: string | undefined

  if (spec.router.type === 'rule') {
    // Evaluate rules in order
    for (const rule of spec.router.rules) {
      if (evaluatePredicate(rule.when, ctx)) {
        chosenRoute = rule.route
        break
      }
    }
  } else if (spec.router.type === 'llm') {
    // LLM routing - invoke router agent
    const routerInput = resolveInput(spec.router.promptRef, ctx)
    const routerOutput = await ctx.invokeAgent(spec.router.agent, routerInput, ctx)
    chosenRoute = (routerOutput as Record<string, unknown>)[spec.router.outputKey] as string
  }

  // Fall back to default
  if (!chosenRoute && spec.defaultBranch) {
    chosenRoute = spec.defaultBranch
  }

  if (!chosenRoute || !spec.branches[chosenRoute]) {
    throw new Error(`No matching route found and no default branch`)
  }

  ctx.trace.record({
    type: 'router.decision',
    runId: ctx.runId,
    nodeId,
    ts: Date.now(),
    routerType: spec.router.type,
    chosen: chosenRoute
  })

  // Execute chosen branch
  const chosenBranch = spec.branches[chosenRoute]
  if (!chosenBranch) {
    throw new Error(`Branch not found: ${chosenRoute}`)
  }
  const result = await executeFlow(chosenBranch, ctx)
  if (!result.success) {
    throw new Error(result.error ?? 'Chosen branch failed')
  }

  return result.output
}

async function executeLoop(
  spec: LoopSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  let lastOutput: unknown = ctx.prevOutput
  let iteration = 0

  while (iteration < spec.maxIters) {
    iteration++

    // Execute body
    const result = await executeFlow(spec.body, { ...ctx, prevOutput: lastOutput })
    if (!result.success) {
      throw new Error(result.error ?? 'Loop body failed')
    }
    lastOutput = result.output

    // Check until condition with updated prevOutput
    const shouldStop = evaluateUntil(spec.until, { ...ctx, prevOutput: lastOutput }, iteration)

    ctx.trace.record({
      type: 'loop.iteration',
      runId: ctx.runId,
      nodeId,
      ts: Date.now(),
      iteration,
      continuing: !shouldStop
    })

    if (shouldStop) {
      break
    }
  }

  return lastOutput
}

async function executeGate(
  spec: GateSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  let passed = false
  let details: unknown

  switch (spec.gate.type) {
    case 'predicate':
      passed = evaluatePredicate(spec.gate.predicate, ctx)
      break

    case 'validator': {
      // TODO: Implement validator lookup
      passed = true
      break
    }

    case 'policy': {
      // TODO: Implement policy check
      passed = true
      break
    }

    case 'human': {
      // TODO: Implement human approval
      console.warn('Human gate not implemented, auto-passing')
      passed = true
      break
    }
  }

  ctx.trace.record({
    type: 'gate.check',
    runId: ctx.runId,
    nodeId,
    ts: Date.now(),
    gateType: spec.gate.type,
    passed,
    details
  })

  const branch = passed ? spec.onPass : spec.onFail
  const result = await executeFlow(branch, ctx)
  if (!result.success) {
    throw new Error(result.error ?? 'Gate branch failed')
  }

  return result.output
}

async function executeRace(
  spec: RaceSpec,
  _nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Create abort controller for cancellation
  const abortController = new AbortController()

  const promises = spec.contenders.map(async (contender, index) => {
    try {
      const result = await executeFlow(contender, {
        ...ctx,
        step: ctx.step + index * 1000,
        abortSignal: abortController.signal
      })
      return { index, result }
    } catch (error) {
      return { index, result: { success: false, output: undefined, error: String(error) } }
    }
  })

  if (spec.winner.type === 'firstSuccess' || spec.winner.type === 'firstComplete') {
    // Race for first success/completion
    const winner = await Promise.race(
      promises.map(async p => {
        const { result } = await p
        if (spec.winner.type === 'firstSuccess' && !result.success) {
          // Keep waiting for others
          return new Promise(() => {}) // Never resolves
        }
        return result
      })
    ) as ExecutionResult

    abortController.abort()

    if (!winner.success) {
      throw new Error(winner.error ?? 'Race winner failed')
    }

    return winner.output
  }

  // For highestScore, wait for all and pick best
  const allResults = await Promise.all(promises)
  abortController.abort()

  const successResults = allResults.filter(r => r.result.success)
  if (successResults.length === 0) {
    throw new Error('All race contenders failed')
  }

  // TODO: Implement score extraction from path
  const firstSuccess = successResults[0]
  if (!firstSuccess) {
    throw new Error('All race contenders failed')
  }
  return firstSuccess.result.output
}

async function executeSupervise(
  spec: SuperviseSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // First, invoke supervisor to get plan
  const supervisorResult = await executeFlow(spec.supervisor, ctx)
  if (!supervisorResult.success) {
    throw new Error(supervisorResult.error ?? 'Supervisor failed')
  }

  // Execute workers based on strategy
  const workersResult = await executeFlow(spec.workers, {
    ...ctx,
    prevOutput: supervisorResult.output
  })
  if (!workersResult.success) {
    throw new Error(workersResult.error ?? 'Workers failed')
  }

  // Join supervisor output with workers output
  ctx.trace.record({
    type: 'join.start',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now(),
    inputsCount: 2
  })

  const joinedOutput = ctx.reducerRegistry.apply(
    spec.join.reducerId,
    [supervisorResult.output, workersResult.output],
    spec.join.args,
    { runId: ctx.runId, nodeId, trace: ctx.trace }
  )

  if (spec.join.outputAs) {
    ctx.state.put(spec.join.outputAs.path, joinedOutput, {
      runId: ctx.runId,
      trace: ctx.trace
    })
  }

  ctx.trace.record({
    type: 'join.end',
    runId: ctx.runId,
    nodeId,
    reducerId: spec.join.reducerId,
    ts: Date.now()
  })

  return joinedOutput
}

async function executeBranch(
  spec: BranchSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Get current state for condition evaluation
  // Strip namespace from toObject to make condition evaluation simpler
  const stateObj = getStateWithoutNamespace(ctx)
  const conditionInput = { ...stateObj, _prev: ctx.prevOutput }

  // Evaluate condition
  const shouldTakeThenBranch = spec.condition(conditionInput)

  ctx.trace.record({
    type: 'router.decision',
    runId: ctx.runId,
    nodeId,
    ts: Date.now(),
    routerType: 'branch',
    chosen: shouldTakeThenBranch ? 'then' : 'else'
  })

  // Execute the appropriate branch
  const branch = shouldTakeThenBranch ? spec.then : spec.else
  const result = await executeFlow(branch, ctx)

  if (!result.success) {
    throw new Error(result.error ?? 'Branch execution failed')
  }

  return result.output
}

async function executeNoop(
  _spec: NoopSpec,
  ctx: ExecutionContext
): Promise<unknown> {
  // Noop simply passes through the previous output
  return ctx.prevOutput
}

async function executeSelect(
  spec: SelectSpec,
  nodeId: string,
  ctx: ExecutionContext
): Promise<unknown> {
  // Get current state for selector evaluation
  // Strip namespace from toObject to make selector evaluation simpler
  const stateObj = getStateWithoutNamespace(ctx)
  const selectorInput = { ...stateObj, _prev: ctx.prevOutput }

  // Evaluate selector
  const branchKey = spec.selector(selectorInput)

  ctx.trace.record({
    type: 'router.decision',
    runId: ctx.runId,
    nodeId,
    ts: Date.now(),
    routerType: 'select',
    chosen: branchKey
  })

  // Find the branch to execute
  let branch = spec.branches[branchKey]
  if (!branch) {
    if (spec.default) {
      branch = spec.default
    } else {
      throw new Error(`No branch found for selector value '${branchKey}' and no default branch`)
    }
  }

  const result = await executeFlow(branch, ctx)

  if (!result.success) {
    throw new Error(result.error ?? 'Select branch execution failed')
  }

  return result.output
}

// ============================================================================
// Helper Functions
// ============================================================================

function resolveInput(ref: InputRef, ctx: ExecutionContext): unknown {
  switch (ref.ref) {
    case 'initial':
      return ctx.initialInput
    case 'prev':
      return ctx.prevOutput
    case 'state':
      return ctx.state.getTree(ref.path)
    case 'const':
      return ref.value
    case 'mapped': {
      // Resolve the source first, then apply transform
      const mappedRef = ref as MappedInputRef
      const sourceValue = resolveInput(mappedRef.source, ctx)
      return mappedRef.transform(sourceValue)
    }
    default:
      throw new Error(`Unknown input ref type: ${(ref as InputRef).ref}`)
  }
}

function evaluatePredicate(pred: PredicateSpec, ctx: ExecutionContext): boolean {
  const getValue = (path: string): unknown => {
    // First try direct state access
    const directValue = ctx.state.getTree(path)
    if (directValue !== undefined) return directValue

    // If not found, try to access nested path within state (without namespace)
    // e.g., 'result.approved' might be 'approved' within 'result' object
    const stateObj = getStateWithoutNamespace(ctx)
    const nestedStateValue = getNestedValue(stateObj, path)
    if (nestedStateValue !== undefined) return nestedStateValue

    // Finally, try nested path in prevOutput
    return getNestedValue(ctx.prevOutput, path)
  }

  switch (pred.op) {
    case 'eq':
      return getValue(pred.path) === pred.value
    case 'neq':
      return getValue(pred.path) !== pred.value
    case 'gt':
      return (getValue(pred.path) as number) > pred.value
    case 'gte':
      return (getValue(pred.path) as number) >= pred.value
    case 'lt':
      return (getValue(pred.path) as number) < pred.value
    case 'lte':
      return (getValue(pred.path) as number) <= pred.value
    case 'contains':
      return String(getValue(pred.path)).includes(pred.value)
    case 'regex':
      return new RegExp(pred.pattern).test(String(getValue(pred.path)))
    case 'exists':
      return getValue(pred.path) !== undefined
    case 'empty': {
      const val = getValue(pred.path)
      return val === undefined || val === null || val === '' ||
        (Array.isArray(val) && val.length === 0)
    }
    case 'and':
      return pred.clauses.every(c => evaluatePredicate(c, ctx))
    case 'or':
      return pred.clauses.some(c => evaluatePredicate(c, ctx))
    case 'not':
      return !evaluatePredicate(pred.clause, ctx)
    default:
      throw new Error(`Unknown predicate op: ${(pred as PredicateSpec).op}`)
  }
}

function evaluateUntil(until: UntilSpec, ctx: ExecutionContext, iteration?: number): boolean {
  const getStateValue = (path: string): unknown => {
    // First try direct state access
    const directValue = ctx.state.getTree(path)
    if (directValue !== undefined) return directValue

    // If not found, try to access nested path within state (without namespace)
    // e.g., 'result.approved' might be 'approved' within 'result' object
    const stateObj = getStateWithoutNamespace(ctx)
    const nestedStateValue = getNestedValue(stateObj, path)
    if (nestedStateValue !== undefined) return nestedStateValue

    // Finally, try nested path in prevOutput
    return getNestedValue(ctx.prevOutput, path)
  }

  switch (until.type) {
    // Legacy conditions (for backward compatibility)
    case 'predicate':
      return evaluatePredicate(until.predicate, ctx)

    case 'noCriticalIssues': {
      const reviews = ctx.state.getTree(until.path) as unknown
      if (!reviews) return true
      if (Array.isArray(reviews)) {
        return !reviews.some((r: { severity?: string }) =>
          r.severity === 'critical' || r.severity === 'major'
        )
      }
      return true
    }

    case 'noProgress':
      // TODO: Implement progress detection
      return false

    case 'budgetExceeded':
      // TODO: Implement budget tracking
      return false

    // Business-semantic conditions (preferred)
    case 'field-eq': {
      const value = getStateValue(until.path)
      return value === until.value
    }

    case 'field-neq': {
      const value = getStateValue(until.path)
      return value !== until.value
    }

    case 'field-truthy': {
      const value = getStateValue(until.path)
      return Boolean(value)
    }

    case 'field-falsy': {
      const value = getStateValue(until.path)
      return !value
    }

    case 'field-compare': {
      const value = getStateValue(until.path) as number
      if (typeof value !== 'number') return false
      switch (until.comparator) {
        case 'gt': return value > until.value
        case 'gte': return value >= until.value
        case 'lt': return value < until.value
        case 'lte': return value <= until.value
      }
      return false
    }

    case 'validator': {
      const value = getStateValue(until.path)
      if (value === undefined) return false
      try {
        const validated = until.schema.parse(value)
        return until.check(validated)
      } catch {
        return false
      }
    }

    case 'max-iterations':
      return (iteration ?? 0) >= until.count

    case 'no-progress':
      // TODO: Implement progress detection with window
      return false

    case 'budget-exceeded':
      // TODO: Implement budget tracking
      return false

    case 'all':
      return until.conditions.every(cond => evaluateUntil(cond, ctx, iteration))

    case 'any':
      return until.conditions.some(cond => evaluateUntil(cond, ctx, iteration))

    default:
      throw new Error(`Unknown until type: ${(until as UntilSpec).type}`)
  }
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current = obj

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

/**
 * Get state object without namespace prefix
 * Blackboard stores values with namespace prefix (e.g., 'test.taskType'),
 * but we want conditions to access values without prefix (e.g., 'taskType')
 */
function getStateWithoutNamespace(ctx: ExecutionContext): Record<string, unknown> {
  const fullStateObj = ctx.state.toObject?.() ?? {}
  const namespace = ctx.state.namespace

  // If namespace exists and state has it as a key, return its contents
  if (namespace && fullStateObj[namespace] && typeof fullStateObj[namespace] === 'object') {
    return fullStateObj[namespace] as Record<string, unknown>
  }

  // Otherwise return as-is
  return fullStateObj
}
