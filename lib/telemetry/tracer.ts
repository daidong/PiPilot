/**
 * Tracer — thin wrapper around `@opentelemetry/api` (§3.2).
 *
 * Single-init point for the PiPilot tracing subsystem. Owns:
 *   - The TracerProvider with Resource attributes per §5.4 (process/build identity).
 *   - The AsyncLocalStorageContextManager (default for sdk-trace-node, but pinned here
 *     so we don't accidentally lose context propagation if a future OTel default changes).
 *   - The TraceStore SpanProcessor.
 *   - Project-scoped attribute defaults (project.id, session.id, etc. — §4.1).
 *
 * Lifecycle:
 *   - One TracerProvider per Electron main process (matches the actual process model).
 *   - Resource = process/build identity ONLY. Per-project / per-session attributes go
 *     on each span via `withProjectScope()` (§5.4).
 *   - `shutdown()` drains the TraceStore and flushes pending JSONL appends (5s budget,
 *     §5.1).
 */

import { context, trace, type Tracer as OtelTracer, type Span, type Context, SpanKind, type Attributes } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { SCHEMA_URL, validatePipilotAttribute } from './semantic-registry.js'
import { TraceStore } from './trace-store.js'
import { TraceDigestProcessor } from './digest.js'
import { LiveSpanProcessor, type LiveSpanSubscriber } from './live-processor.js'
import { ulid } from './ulid.js'

export interface TracerInitOptions {
  /** Project root path. The TraceStore writes under `<projectPath>/.research-pilot/traces/`. */
  projectPath: string
  /** App version (`app/package.json` → `version`). */
  serviceVersion: string
  /** App build commit (git rev-parse HEAD at build time). */
  appBuildCommit: string
  /** Project ULID for this initialization. Goes onto every span as `pipilot.project.id`. */
  projectId: string
  /** Session id from `session.json`. Goes onto every span as `gen_ai.conversation.id`. */
  sessionId: string
  /** Free-form project tag (optional). Goes onto every span as `pipilot.project.tag`. */
  projectTag?: string
  /** Coordinator profile id (varies across coordinators in one process). */
  agentProfile?: string
  /** Workspace git commit, per-project. */
  workspaceCommit?: string
  /** Wiki manifest version, per-project. */
  memoryIndexVersion?: string
  /** Default ring queue capacity (1024 per §5.1). */
  bufferCapacity?: number
  /** Override TraceStore for tests. */
  traceStore?: TraceStore
}

export interface ProjectScope {
  projectId: string
  sessionId: string
  projectTag?: string
  agentProfile?: string
  workspaceCommit?: string
  memoryIndexVersion?: string
}

/**
 * Helper: stamp every span created within a callback with project-scoped attributes.
 *
 * Usage:
 *   await tracer.withProjectScope({ projectId, sessionId }, async () => {
 *     const span = tracer.startSpan('chat foo')
 *     // span automatically carries pipilot.project.id, gen_ai.conversation.id, ...
 *   })
 */
const PROJECT_SCOPE_KEY = Symbol.for('pipilot.telemetry.projectScope')

/**
 * Process-level reference to the most recently constructed PipilotTracer.
 *
 * Used by code paths that don't have a direct way to thread a tracer through
 * (e.g., the diagram backends that issue their own HTTP calls outside the
 * pi-ai surface). When zero or multiple windows are open, this returns the
 * latest one created — good enough for project-scoped context propagation
 * since OTel's AsyncLocalStorage carries the active span across the same
 * call chain regardless of which tracer minted it.
 *
 * Returns null when no PipilotTracer has been instantiated.
 */
let _activeTracer: PipilotTracer | null = null
export function getActiveTracer(): PipilotTracer | null {
  return _activeTracer
}

export class PipilotTracer {
  readonly provider: NodeTracerProvider
  readonly store: TraceStore
  /** Live span fan-out — used by main process to forward spans to renderer. */
  readonly live: LiveSpanProcessor
  private readonly tracer: OtelTracer
  private readonly defaultScope: ProjectScope

  constructor(opts: TracerInitOptions) {
    const resource = new Resource({
      'service.name': 'research-copilot',
      'service.version': opts.serviceVersion,
      'service.instance.id': ulid(),
      'process.runtime.name': 'node',
      'process.runtime.version': process.version,
      'os.type': process.platform,
      'pipilot.runtime.app_build_commit': opts.appBuildCommit
    })

    this.store =
      opts.traceStore ??
      new TraceStore({
        projectPath: opts.projectPath,
        bufferCapacity: opts.bufferCapacity ?? 1024
      })

    const digestProcessor = new TraceDigestProcessor(opts.projectPath)
    this.live = new LiveSpanProcessor()
    this.provider = new NodeTracerProvider({
      resource,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spanProcessors: [this.store as any, digestProcessor as any, this.live as any]
    })

    // Pin AsyncLocalStorageContextManager. (sdk-trace-node uses it by default but we
    // make it explicit so future OTel defaults can't silently demote propagation.)
    const ctxMgr = new AsyncLocalStorageContextManager()
    ctxMgr.enable()
    context.setGlobalContextManager(ctxMgr)

    // Get the per-instance Tracer (NOT the global one — see trace-store tests).
    this.tracer = this.provider.getTracer('pipilot', opts.serviceVersion, { schemaUrl: SCHEMA_URL })

    this.defaultScope = {
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      projectTag: opts.projectTag,
      agentProfile: opts.agentProfile,
      workspaceCommit: opts.workspaceCommit,
      memoryIndexVersion: opts.memoryIndexVersion
    }

    // Publish to process-level accessor for code paths that can't thread the
    // tracer (diagram backends, future external instrumentation).
    _activeTracer = this
  }

  /** Run callback with project-scoped attribute defaults active. */
  withProjectScope<T>(scope: Partial<ProjectScope>, fn: () => T): T {
    const merged: ProjectScope = { ...this.defaultScope, ...scope }
    const ctx = context.active().setValue(PROJECT_SCOPE_KEY, merged)
    return context.with(ctx, fn)
  }

  /** Read the active project scope (default scope if none was set). */
  currentScope(): ProjectScope {
    const fromContext = context.active().getValue(PROJECT_SCOPE_KEY) as ProjectScope | undefined
    return fromContext ?? this.defaultScope
  }

  /**
   * Start a span with project-scoped attribute defaults baked in.
   *
   * Span attributes (§5.4):
   *   - pipilot.project.id           = scope.projectId
   *   - gen_ai.conversation.id       = scope.sessionId
   *   - pipilot.project.tag          = scope.projectTag (if set)
   *   - pipilot.runtime.agent_profile, .workspace_commit, .memory_index_version
   */
  startSpan(name: string, kind: SpanKind = SpanKind.INTERNAL, parent?: Context): Span {
    const scope = this.currentScope()
    const attrs: Attributes = {
      'pipilot.project.id': scope.projectId,
      'gen_ai.conversation.id': scope.sessionId
    }
    if (scope.projectTag) attrs['pipilot.project.tag'] = scope.projectTag
    if (scope.agentProfile) attrs['pipilot.runtime.agent_profile'] = scope.agentProfile
    if (scope.workspaceCommit) attrs['pipilot.runtime.workspace_commit'] = scope.workspaceCommit
    if (scope.memoryIndexVersion) attrs['pipilot.runtime.memory_index_version'] = scope.memoryIndexVersion

    // Validate every pipilot.* key in dev mode.
    for (const k of Object.keys(attrs)) validatePipilotAttribute(k)

    return this.tracer.startSpan(name, { kind, attributes: attrs }, parent ?? context.active())
  }

  /** Shut down: flush + drain TraceStore + shut down exporter. 5s budget per §5.1. */
  async shutdown(): Promise<void> {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
    await Promise.race([this.store.shutdown(), timeout])
    await Promise.race([this.provider.shutdown(), timeout])
    if (_activeTracer === this) _activeTracer = null
  }

  /** Underlying OTel Tracer (for advanced/explicit use). */
  rawTracer(): OtelTracer {
    return this.tracer
  }

  /** Convenience: wrap an async callback in a span; ends span on completion/error. */
  async runInSpan<T>(name: string, kind: SpanKind, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.startSpan(name, kind)
    const ctxWithSpan = trace.setSpan(context.active(), span)
    try {
      const result = await context.with(ctxWithSpan, () => fn(span))
      span.end()
      return result
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({ code: 2, message: (err as Error).message }) // SpanStatusCode.ERROR = 2
      span.end()
      throw err
    }
  }
}
