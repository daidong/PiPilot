/**
 * Research Tools — main factory that assembles all research tools.
 *
 * All tools register as native pi-mono AgentTool; there is no longer a
 * ResearchTool↔AgentTool adapter shim.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { context } from '@opentelemetry/api'
import { TOOL_CALL_KEY } from '../telemetry/context-keys.js'
import type { ResearchToolContext } from './types.js'
import { createResearchMemoryTools } from './entity-tools.js'
import { createMemoryTools } from '../memory/memory-tools.js'
import { createWebSearchTool, createWebFetchTool } from './web-tools.js'
import { createLiteratureSearchTool } from './literature-search.js'
import { createFetchFulltextTool } from './fetch-fulltext.js'
import { createConvertDocumentTool } from './convert-document.js'
import { createDataAnalyzeTool } from './data-analyze.js'
import { createGenerateDiagramTool } from './generate-diagram.js'
import { createComputeTools } from '../compute/tools.js'
import { createS3Tools } from './s3-tools.js'
import { createWikiLookupTool } from '../wiki/tool.js'
import { createWikiTools } from '../wiki/wiki-tools.js'

/**
 * Create all research tools for the coordinator agent.
 *
 * @param ctx - Research tool context (workspace, session, LLM, callbacks)
 * @returns tools array + destroy function for cleanup of long-lived resources
 */
export function createResearchTools(ctx: ResearchToolContext): {
  tools: AgentTool[]
  destroy: () => Promise<void>
} {
  const tools: AgentTool[] = []
  const destroyers: Array<() => Promise<void>> = []

  // Web tools
  tools.push(createWebSearchTool(ctx))
  tools.push(createWebFetchTool(ctx))

  // Research tools
  tools.push(createLiteratureSearchTool(ctx))
  tools.push(createFetchFulltextTool(ctx))
  tools.push(createConvertDocumentTool(ctx))
  tools.push(createDataAnalyzeTool(ctx))
  tools.push(createGenerateDiagramTool(ctx))

  // Artifact tools
  tools.push(...createResearchMemoryTools({
    sessionId: ctx.sessionId,
    projectPath: ctx.projectPath,
    getTurnId: ctx.getTurnId
  }))

  // Structured memory tools (save-memory, delete-memory)
  tools.push(...createMemoryTools(ctx.projectPath, ctx.getTurnId))

  // RFC-005 memory tools: wiki_search / wiki_get / wiki_coverage / wiki_facets / wiki_neighbors / wiki_source
  // Always registered; each tool returns "Wiki not available" at execute time if the wiki doesn't exist
  tools.push(...createWikiTools())

  // Legacy wiki_lookup compatibility shim (RFC-003). Scheduled for removal one release after RFC-005 lands.
  tools.push(createWikiLookupTool())

  // Compute tools (RFC-008 §4): generic compute_plan + list_compute_backends,
  // plus per-backend execute/wait/status/stop. Sourced from a ComputeRegistry
  // built by the coordinator from registered backends. Backends destroy
  // themselves when the coordinator tears down (Registry.destroy() called
  // from coordinator's destroy).
  if (ctx.computeRegistry) {
    tools.push(...createComputeTools({
      registry: ctx.computeRegistry,
      workspacePath: ctx.workspacePath,
      getTurnId: ctx.getTurnId,
    }))
  }

  // S3 tools (RFC-009 Phase 1, §4.3): registered when an AwsCredentialProvider
  // is plumbed through. Phase 1 ships read-side tools only (download / list /
  // presigned_url) — the EC2 backend's contract is "script writes to S3,
  // agent reads from S3" so mutation tools are deferred.
  if (ctx.awsCredentialProvider) {
    tools.push(...createS3Tools({
      workspacePath: ctx.workspacePath,
      projectPath: ctx.projectPath,
      credentialProvider: ctx.awsCredentialProvider,
    }))
  }

  // Publish the active tool-call id on the OTel context for the whole lifetime
  // of every tool's execute(). Any artifact write that funnels through the
  // memory-v2 store / artifact ledger — regardless of which tool, artifact
  // type, or how many awaits deep — then reads this back (see buildRow in
  // artifact-ledger.ts) and stamps the row with its creator, so the audit graph
  // can draw a `creates` edge generically. One uniform wrap over every research
  // tool; no per-tool threading, no enumeration of "download" tools.
  const withToolCallContext = (t: AgentTool): AgentTool => ({
    ...t,
    execute: (toolCallId, params, signal, onUpdate) =>
      context.with(
        context.active().setValue(TOOL_CALL_KEY, toolCallId),
        () => t.execute(toolCallId, params, signal, onUpdate),
      ),
  })

  return {
    tools: tools.map(withToolCallContext),
    destroy: async () => {
      for (const d of destroyers) {
        await d().catch(() => {})
      }
    },
  }
}

export type { ResearchToolContext } from './types.js'
