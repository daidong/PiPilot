# Literature review: Execution environments for running large numbers of LLM agents

## Background

Running “many agents” is mostly an orchestration problem. Each agent is a loop that alternates between (1) model inference, (2) tool calls (I/O), and (3) state updates. At small scale this can be a single async process; at large scale it becomes a distributed system that must schedule millions of mostly-I/O-bound steps, enforce rate limits and safety controls, persist per-agent state, and provide observability and replay.

Across the literature and systems landscape, execution environments cluster into a few archetypes: actor-based distributed runtimes, workflow engines, container/serverless orchestration, and purpose-built agent graphs with durable state.

## Key environment archetypes and representative systems

### 1) Actor-based distributed runtimes (Ray)

**Core idea:** represent agents as actors (stateful workers) and schedule their steps as remote tasks. This model maps well to agents because each agent has mutable state and performs repeated asynchronous actions.

Ray’s docs emphasize two primitives that align with agent execution:

- **Tasks** for stateless parallel work.
- **Actors** for stateful, long-running computation.

Ray also positions itself as a general-purpose distributed runtime that can scale from a laptop to a cluster, which makes it a frequent substrate for multi-agent experiments and production services.

**Design considerations:**

- Actor lifetimes vs churn: many agents are cheap state machines; the runtime must handle large numbers of mostly-idle agents without incurring heavy per-process overhead.
- Backpressure: tool calls (web, DB, code execution) are slow compared to scheduling; task queues and rate limiting are first-class.
- Fault tolerance: actor restart semantics and state checkpointing determine whether agents can be recovered deterministically.

### 2) Workflow engines for durable, long-running agents (Temporal)

**Core idea:** treat agent steps as workflow activities with a durable event history. Temporal’s model is built for long-running, failure-prone processes and provides replay, retries, and state persistence as part of the platform.

Temporal’s documentation highlights durable execution: workflows can run for long periods and resume after failures, with recorded history enabling deterministic replay.

This maps cleanly to “agents at scale” when:

- agents must run for days/weeks,
- you need auditability and reproducibility of tool calls,
- you want strong retry semantics and operational visibility.

**Design considerations:**

- Determinism constraints: workflows often require deterministic code paths to support replay.
- Throughput vs history size: fine-grained agent steps increase event history volume.
- Tool execution isolation: activities that run external commands still need sandboxing and secrets management.

### 3) Graph-based agent orchestrators with persistence (LangGraph)

**Core idea:** represent an agent (or multi-agent system) as a stateful graph with nodes for model calls and tools, and persist execution state/checkpoints.

LangGraph’s docs explicitly frame the system as enabling “stateful, multi-actor applications” and emphasize **persistence** and **streaming**, with a “durable execution” mode (LangGraph Platform) for production agent deployments.

This approach is attractive because it combines a readable control structure (graph) with operational features needed for many concurrent agents:

- explicit state schema,
- checkpointing between steps,
- human-in-the-loop interrupts,
- streaming traces.

**Design considerations:**

- State schema design: minimizing state bloat while preserving debuggability.
- Execution model: whether graphs run in-process (dev) or via a durable service (prod).
- Integrations: vector stores, queues, and tool sandboxes are usually external dependencies.

### 4) Agent “frameworks” that rely on an external runtime (AutoGen, Semantic Kernel, LlamaIndex)

Many popular agent frameworks focus on *programming models* rather than the distributed execution environment.

- **AutoGen** emphasizes building multi-agent conversations and providing a runtime for coordinating agent messages and tool use.
- **Semantic Kernel** frames agents as composable capabilities with connectors to models and tools.
- **LlamaIndex** focuses heavily on data/RAG pipelines and agent tool patterns around retrieval.

In practice, these frameworks often run on top of:

- a single Python/Node process for small deployments,
- or are embedded into a larger environment (Kubernetes, Ray, Temporal) for scale.

**Design considerations:**

- Separation of concerns: framework provides agent logic; the execution substrate provides scaling, reliability, and isolation.
- Inter-agent communication: message bus vs shared memory vs event streams.

### 5) Container orchestration / Kubernetes and serverless

**Core idea:** scale agents by running many replicas of an “agent worker” service and using queues/streams to feed work. Kubernetes provides scheduling and isolation boundaries; serverless provides burst scaling for short-lived tasks.

This is the default production path when the main requirement is horizontal scaling and strong isolation, but it typically requires assembling many components:

- queue (SQS/Kafka/PubSub),
- worker services,
- state store (Postgres/Redis),
- vector DB,
- tracing/metrics,
- secrets management.

**Design considerations:**

- Cold start overhead for short-lived agents.
- Coordinating shared state and deduplication across workers.
- Observability: correlating traces across model calls, tool calls, and retries.

## Comparative analysis: what tends to work best at scale

No single “best” environment wins across all axes; the best choice depends on whether your bottleneck is model inference, tool I/O, or durability/governance requirements.

**Actor runtime (Ray)** tends to fit when you need high-throughput parallelism and flexible Python execution, especially for research and systems that mix ML workloads with agent orchestration. It provides a natural abstraction for stateful agents (actors), but you still must build governance (permissions, sandboxing) and durable state carefully.

**Workflow engine (Temporal)** fits when agents are long-running business processes and you need strong correctness, retries, and replayable audit trails. It can be heavier-weight for extremely fine-grained agent steps, but it shines for reliability and traceability.

**Graph orchestrator with persistence (LangGraph / LangGraph Platform)** fits when you want an explicit control structure (graph) plus built-in checkpointing/human-in-the-loop and a path from prototype to production durable execution.

**Kubernetes/serverless** fit when you have strong platform engineering capabilities and want mature isolation and autoscaling. This is often the “most standard” approach, but it shifts complexity to your architecture: queues, state stores, rate limiting, and tracing become your responsibility.

## Key design considerations (cross-cutting)

### Concurrency model and backpressure
Agent workloads are typically I/O-bound and spiky. Environments need async execution, bounded queues, and admission control (per-model, per-tool, per-tenant). Without backpressure, tool calls and model APIs become the failure modes.

### State and checkpointing
At scale, “agent state” must be treated as data:

- explicit schemas,
- checkpointing between steps,
- versioning of prompts/tools,
- ability to replay or at least reconstruct trajectories.

Workflow engines and durable graph orchestrators provide this out of the box; actor/K8s approaches usually require custom persistence.

### Tool execution isolation and security
Once agents can execute code or make network calls, isolation is non-negotiable: per-agent credentials, sandboxing for code execution, network egress restrictions, and audit logs of tool calls. Production environments often combine application-layer permissioning with OS/container sandboxing.

### Memory/RAG at scale
Retrieval is often the dominant cost and latency driver outside the LLM itself. The environment must support:

- caching,
- embedding throughput management,
- vector DB selection and sharding,
- per-agent and shared memory boundaries.

### Observability and evaluation
Debugging many agents requires traces that stitch together model calls, tool calls, and state transitions, plus replay tools and evaluation harnesses. Systems like Temporal (history) and LangGraph (stateful graph execution + streaming) have advantages here.

## Open gaps / future work

1. **Standard semantics for agent state + replay** across frameworks and runtimes. Today, replayability is often vendor/runtime-specific.
2. **First-class multi-tenant governance** (policy, rate limits, secrets, audit) integrated into agent frameworks, not bolted on.
3. **Better cost controls**: batching, speculative execution, model routing, and caching integrated with orchestration.
4. **Tool sandbox standards**: consistent permissioning and isolation patterns for code execution and connectors.

## Limitations of this review

This review is source-driven but not exhaustive. It samples representative runtime categories (Ray, Temporal, LangGraph, and common agent frameworks) and synthesizes common design considerations. A deeper treatment would include more empirical benchmarking studies and more coverage of commercial “agent platforms” that document fewer internal details.
