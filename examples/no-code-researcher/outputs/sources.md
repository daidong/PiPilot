# Sources (with evidence notes)

## Distributed runtimes / actor model

1. **Ray documentation — Tasks and Actors**
   - URL: https://docs.ray.io/en/latest/ray-core/tasks.html
   - Evidence notes: Ray Core defines *tasks* (stateless remote functions) and *actors* (stateful workers). Actors are a natural mapping for “agents” that maintain state across steps.

2. **Ray documentation — Actors**
   - URL: https://docs.ray.io/en/latest/ray-core/actors.html
   - Evidence notes: Details actor lifecycle and stateful execution model; relevant to long-lived or many concurrent agent loops.

## Workflow engines / durable execution

3. **Temporal documentation — Workflows and Activities (concepts)**
   - URL: https://docs.temporal.io/workflows
   - Evidence notes: Temporal positions workflows as durable, long-running executions with recorded history and strong retry semantics, which maps to long-running agent processes.

## Agent graph orchestrators

4. **LangGraph documentation — Overview / persistence**
   - URL: https://langchain-ai.github.io/langgraph/
   - Evidence notes: LangGraph describes building stateful, multi-actor applications; includes persistence/checkpointing concepts and a production platform for durable execution.

## Agent frameworks (programming model; often needs external runtime to scale)

5. **Microsoft Semantic Kernel — Agents**
   - URL: https://learn.microsoft.com/en-us/semantic-kernel/agents/
   - Evidence notes: Describes agent abstractions and integration patterns; relevant as a programming model rather than a distributed runtime by itself.

6. **LlamaIndex documentation — Agents**
   - URL: https://developers.llamaindex.ai/python/framework/understanding/agent/
   - Evidence notes: Covers building agents and tool-using patterns in a retrieval-centric framework.

7. **AutoGen (Microsoft Research) — project documentation**
   - URL: https://microsoft.github.io/autogen/
   - Evidence notes: Multi-agent conversation framework; useful for agent coordination patterns. Execution at scale typically requires an external substrate (queues/containers/runtimes).

## Infrastructure archetype (Kubernetes/serverless)

8. **Kubernetes documentation — Concepts (Workloads / controllers)**
   - URL: https://kubernetes.io/docs/concepts/workloads/
   - Evidence notes: Baseline for horizontally scaling “agent worker” services with isolation and scheduling, typically paired with queues and external state stores.
