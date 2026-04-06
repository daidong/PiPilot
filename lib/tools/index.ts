/**
 * Research Tools — main factory that assembles all research tools.
 *
 * Combines:
 * - Web tools (search + fetch) — already return AgentTool
 * - Literature search — already returns AgentTool
 * - Convert document — already returns AgentTool
 * - Data analysis — already returns AgentTool
 * - Entity/artifact tools — return ResearchTool, wrapped via adapter
 */

import { Type } from '@sinclair/typebox'
import type { TSchema } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ResearchToolContext } from './types.js'
import { toAgentResult, toolError } from './tool-utils.js'
import { type ResearchTool, createResearchMemoryTools } from './entity-tools.js'
import { createMemoryTools } from '../memory/memory-tools.js'
import { createWebSearchTool, createWebFetchTool } from './web-tools.js'
import { createLiteratureSearchTool } from './literature-search.js'
import { createConvertDocumentTool } from './convert-document.js'
import { createDataAnalyzeTool } from './data-analyze.js'
import { createLocalComputeTools } from '../local-compute/tools.js'

// ---------------------------------------------------------------------------
// ResearchTool -> AgentTool adapter
// ---------------------------------------------------------------------------

/**
 * Wrap a ResearchTool (simple JSON Schema interface) into pi-mono's AgentTool format.
 * This is less invasive than rewriting entity-tools.ts to return AgentTool directly.
 */
function wrapResearchTool(tool: ResearchTool): AgentTool {
  // Build TypeBox schema from JSON Schema properties
  const properties: Record<string, TSchema> = {}
  const jsonProps = (tool.parameters as {
    properties?: Record<string, { type?: string; description?: string; enum?: string[]; items?: { type?: string } }>
  }).properties ?? {}
  const requiredFields = (tool.parameters as { required?: string[] }).required ?? []

  for (const [key, prop] of Object.entries(jsonProps)) {
    const isRequired = requiredFields.includes(key)
    let schema: TSchema

    if (prop.enum) {
      schema = Type.Union(prop.enum.map(v => Type.Literal(v)))
    } else if (prop.type === 'number') {
      schema = Type.Number({ description: prop.description })
    } else if (prop.type === 'array') {
      schema = Type.Array(Type.String(), { description: prop.description })
    } else {
      schema = Type.String({ description: prop.description })
    }

    properties[key] = isRequired ? schema : Type.Optional(schema)
  }

  const parametersSchema = Type.Object(properties)

  return {
    name: tool.name,
    description: tool.description,
    label: tool.name,
    parameters: parametersSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult> => {
      try {
        const result = await tool.execute(params as Record<string, unknown>)
        // Pass through structured error fields (error_code, suggestions, etc.) from ResearchTool results
        return toAgentResult(tool.name, result)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return toAgentResult(tool.name, toolError('EXECUTION_FAILED', errorMsg, {
          retryable: false,
          suggestions: ['Check tool parameters and try again.'],
        }))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

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

  // Web tools (already AgentTool)
  tools.push(createWebSearchTool(ctx))
  tools.push(createWebFetchTool(ctx))

  // Research tools (already AgentTool)
  tools.push(createLiteratureSearchTool(ctx))
  tools.push(createConvertDocumentTool(ctx))
  tools.push(createDataAnalyzeTool(ctx))

  // Artifact tools (ResearchTool -> AgentTool via wrapper)
  const artifactTools = createResearchMemoryTools({
    sessionId: ctx.sessionId,
    projectPath: ctx.projectPath
  })
  for (const tool of artifactTools) {
    tools.push(wrapResearchTool(tool))
  }

  // Structured memory tools (save-memory, delete-memory)
  const structuredMemoryTools = createMemoryTools(ctx.projectPath)
  for (const tool of structuredMemoryTools) {
    tools.push(wrapResearchTool(tool))
  }

  // Local compute tools (long-running sandboxed execution)
  // Gated behind ENABLE_LOCAL_COMPUTE env var for gradual rollout
  if (process.env.ENABLE_LOCAL_COMPUTE === '1') {
    const compute = createLocalComputeTools(ctx)
    tools.push(...compute.tools)
    destroyers.push(compute.destroy)
  }

  return {
    tools,
    destroy: async () => {
      for (const d of destroyers) {
        await d().catch(() => {})
      }
    },
  }
}

export type { ResearchToolContext } from './types.js'
