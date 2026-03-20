/**
 * AgentFoundry API Server Example
 *
 * Exposes an AgentFoundry agent as a REST API via Express.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx   # or ANTHROPIC_API_KEY
 *   npx tsx index.ts
 */

import express from 'express'
import { createAgent } from '../../src/index.js'
import type { Agent } from '../../src/types/agent.js'

const PORT = parseInt(process.env.PORT || '3000', 10)

// ---------------------------------------------------------------------------
// Agent setup
// ---------------------------------------------------------------------------

let agent: Agent

async function initAgent(): Promise<void> {
  agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    identity: 'You are a helpful AI assistant exposed via an HTTP API.',
    constraints: ['Be concise and factual.'],
    maxSteps: 20,
    trace: { export: { enabled: false } },
  })
  await agent.ensureInit()
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())

// CORS middleware
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (_req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', agentId: agent?.id ?? null })
})

// ---------------------------------------------------------------------------
// POST /api/chat  — synchronous request/response
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const { prompt, model } = req.body ?? {}

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "prompt" field (string required).' })
    return
  }

  try {
    // If a model override is requested, create a one-off agent.
    // Otherwise use the shared instance.
    let target = agent
    if (model && typeof model === 'string') {
      target = createAgent({
        projectPath: process.cwd(),
        skipConfigFile: true,
        model,
        identity: 'You are a helpful AI assistant exposed via an HTTP API.',
        constraints: ['Be concise and factual.'],
        maxSteps: 20,
        trace: { export: { enabled: false } },
      })
    }

    const result = await target.run(prompt)

    res.json({
      response: result.output,
      steps: result.steps,
      success: result.success,
      durationMs: result.durationMs,
      usage: result.usage ?? null,
    })

    // Clean up one-off agent
    if (target !== agent) {
      await target.destroy()
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/chat] Error:', message)
    res.status(500).json({ error: message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/chat/stream  — Server-Sent Events
// ---------------------------------------------------------------------------

app.post('/api/chat/stream', async (req, res) => {
  const { prompt, model } = req.body ?? {}

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "prompt" field (string required).' })
    return
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    const streamAgent = createAgent({
      projectPath: process.cwd(),
      skipConfigFile: true,
      model: typeof model === 'string' ? model : undefined,
      identity: 'You are a helpful AI assistant exposed via an HTTP API.',
      constraints: ['Be concise and factual.'],
      maxSteps: 20,
      trace: { export: { enabled: false } },
      onStream: (chunk: string) => {
        res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk })}\n\n`)
      },
      onToolCall: (tool: string, input: unknown) => {
        res.write(`data: ${JSON.stringify({ type: 'tool_call', tool, input })}\n\n`)
      },
      onToolResult: (tool: string, result: unknown) => {
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool, result })}\n\n`)
      },
    })

    const result = await streamAgent.run(prompt)

    // Send final summary event
    res.write(`data: ${JSON.stringify({
      type: 'done',
      response: result.output,
      steps: result.steps,
      success: result.success,
      durationMs: result.durationMs,
      usage: result.usage ?? null,
    })}\n\n`)

    res.end()
    await streamAgent.destroy()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/chat/stream] Error:', message)
    res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`)
    res.end()
  }
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Initializing agent...')
  await initAgent()

  app.listen(PORT, () => {
    console.log(`AgentFoundry API server listening on http://localhost:${PORT}`)
    console.log('')
    console.log('Endpoints:')
    console.log(`  GET  http://localhost:${PORT}/api/health`)
    console.log(`  POST http://localhost:${PORT}/api/chat`)
    console.log(`  POST http://localhost:${PORT}/api/chat/stream`)
  })
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
