import { createServer, type Server as HttpServer } from 'node:http'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import express, { type Request, type Response } from 'express'
import { WebSocket, WebSocketServer } from 'ws'

import {
  getAllPackets,
  getDecisions,
  getEvidence,
  getMemoryDigest,
  getMemoryEntries,
  getPacket,
  getStatus,
  getTaskboard,
  initProject,
  listInbox,
  reviewPacket,
  runTurn,
  viewArtifact
} from './runtime.js'
import type { ReviewAction } from './types.js'

const exec = promisify(execCallback)

export interface StartPhdServerOptions {
  projectRoot: string
  port?: number
  host?: string
  openBrowser?: boolean
}

export interface RunningPhdServer {
  url: string
  close: () => Promise<void>
}

interface RuntimeState {
  running: boolean
  lastError: string | null
}

type ServerEvent =
  | { type: 'snapshot'; data: Record<string, unknown> }
  | { type: 'agent_run_started'; data: Record<string, unknown> }
  | { type: 'agent_run_finished'; data: Record<string, unknown> }
  | { type: 'agent_run_failed'; data: Record<string, unknown> }
  | { type: 'decision_applied'; data: Record<string, unknown> }
  | { type: 'info'; data: Record<string, unknown> }

function nowIso(): string {
  return new Date().toISOString()
}

function parsePort(value: unknown, fallback = 3000): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed
    }
  }
  return fallback
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return fallback
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeAction(action: string): ReviewAction {
  if (action === 'approve' || action === 'request_changes' || action === 'reject') return action
  throw new Error(`Invalid action: ${action}`)
}

function resolveArtifactAbsolutePath(projectRoot: string, artifactPath: string): string {
  const root = path.resolve(projectRoot)
  const target = path.resolve(root, artifactPath)
  if (target === root) return target
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${artifactPath}`)
  }
  return target
}

function encodeArtifactPath(artifactPath: string): string {
  return artifactPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function tryOpenBrowser(url: string): Promise<void> {
  const platform = process.platform
  try {
    if (platform === 'darwin') {
      await exec(`open "${url}"`)
      return
    }
    if (platform === 'win32') {
      await exec(`start "" "${url}"`)
      return
    }
    await exec(`xdg-open "${url}"`)
  } catch {
    // best effort only
  }
}

async function sendJsonError(res: Response, error: unknown, statusCode = 500): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  res.status(statusCode).json({ error: message })
}

function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.webp') || lower.endsWith('.svg')
}

function isLikelyTextExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.endsWith('.txt')
    || lower.endsWith('.md')
    || lower.endsWith('.json')
    || lower.endsWith('.jsonl')
    || lower.endsWith('.yaml')
    || lower.endsWith('.yml')
    || lower.endsWith('.csv')
    || lower.endsWith('.log')
    || lower.endsWith('.ts')
    || lower.endsWith('.js')
    || lower.endsWith('.sh')
    || lower.endsWith('.py')
  )
}

export async function startPhdServer(options: StartPhdServerOptions): Promise<RunningPhdServer> {
  const projectRoot = path.resolve(options.projectRoot)
  const port = parsePort(options.port, 3000)
  const host = options.host ?? '127.0.0.1'
  const openBrowser = options.openBrowser !== false

  await initProject(projectRoot)

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const uiDir = path.join(__dirname, 'ui')

  app.use('/ui', express.static(uiDir))
  app.get('/', (_req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'))
  })

  const httpServer: HttpServer = createServer(app)
  const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' })
  const runtimeState: RuntimeState = {
    running: false,
    lastError: null
  }

  async function buildSnapshot(): Promise<Record<string, unknown>> {
    const [status, inbox] = await Promise.all([
      getStatus(projectRoot),
      listInbox(projectRoot)
    ])
    return {
      projectRoot,
      status,
      pending_packets: inbox.length,
      running: runtimeState.running,
      last_error: runtimeState.lastError,
      timestamp: nowIso()
    }
  }

  function broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    for (const client of wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  async function broadcastSnapshot(): Promise<void> {
    const snapshot = await buildSnapshot()
    broadcast({ type: 'snapshot', data: snapshot })
  }

  wsServer.on('connection', async (socket: WebSocket) => {
    const snapshot = await buildSnapshot()
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot } satisfies ServerEvent))
  })

  let runCounter = 0
  function scheduleRun(trigger: 'start' | 'message', payload: { topic?: string, userMessage?: string }): string {
    if (runtimeState.running) {
      throw new Error('Agent is already running.')
    }
    runtimeState.running = true
    runtimeState.lastError = null
    runCounter += 1
    const runId = `run-${Date.now()}-${runCounter}`

    void (async () => {
      try {
        broadcast({ type: 'agent_run_started', data: { runId, trigger, ...payload, timestamp: nowIso() } })
        await broadcastSnapshot()
        const result = await runTurn({
          projectRoot,
          ...(payload.topic ? { topic: payload.topic } : {}),
          ...(payload.userMessage ? { userMessage: payload.userMessage } : {})
        })
        broadcast({ type: 'agent_run_finished', data: { runId, trigger, result, timestamp: nowIso() } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        runtimeState.lastError = message
        broadcast({ type: 'agent_run_failed', data: { runId, trigger, error: message, timestamp: nowIso() } })
      } finally {
        runtimeState.running = false
        await broadcastSnapshot()
      }
    })()

    return runId
  }

  app.get('/api/state', async (_req, res) => {
    try {
      const snapshot = await buildSnapshot()
      res.json(snapshot)
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/taskboard', async (_req, res) => {
    try {
      const board = await getTaskboard(projectRoot)
      res.json(board)
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/packets', async (req, res) => {
    try {
      const includeAll = String(req.query.all ?? '') === '1'
      const pending = await listInbox(projectRoot)
      if (!includeAll) {
        res.json({ pending })
        return
      }
      const all = await getAllPackets(projectRoot)
      res.json({ pending, all })
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/packets/:id', async (req, res) => {
    try {
      const packet = await getPacket(projectRoot, req.params.id)
      if (!packet) {
        res.status(404).json({ error: `Packet not found: ${req.params.id}` })
        return
      }
      res.json(packet)
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/evidence', async (_req, res) => {
    try {
      const records = await getEvidence(projectRoot)
      res.json(records)
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/decisions', async (_req, res) => {
    try {
      const records = await getDecisions(projectRoot)
      res.json(records)
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/memory', async (req, res) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 120)
      const digestSize = parsePositiveInt(req.query.digest, 8)
      const [entries, digest] = await Promise.all([
        getMemoryEntries(projectRoot, limit),
        getMemoryDigest(projectRoot, digestSize)
      ])
      res.json({ entries, digest })
    } catch (error) {
      await sendJsonError(res, error)
    }
  })

  app.get('/api/artifact', async (req, res) => {
    try {
      const artifactPath = asString(req.query.path)
      if (!artifactPath.trim()) {
        res.status(400).json({ error: 'Query parameter "path" is required.' })
        return
      }
      const preview = await viewArtifact({ projectRoot, artifactPath })
      const rawUrl = `/artifacts/${encodeArtifactPath(artifactPath)}`
      res.json({
        path: artifactPath,
        preview,
        raw_url: rawUrl,
        is_image: isImagePath(artifactPath)
      })
    } catch (error) {
      await sendJsonError(res, error, 400)
    }
  })

  app.get(/^\/api\/artifacts\/(.+)$/, async (req, res) => {
    try {
      const artifactPath = decodeURIComponent(String(req.params[0] ?? ''))
      if (!artifactPath.trim()) {
        res.status(400).json({ error: 'Artifact path is required.' })
        return
      }
      const preview = await viewArtifact({ projectRoot, artifactPath })
      const rawUrl = `/artifacts/${encodeArtifactPath(artifactPath)}`
      res.json({
        path: artifactPath,
        preview,
        raw_url: rawUrl,
        is_image: isImagePath(artifactPath)
      })
    } catch (error) {
      await sendJsonError(res, error, 400)
    }
  })

  app.get(/^\/artifacts\/(.+)$/, async (req: Request, res: Response) => {
    try {
      const artifactPath = decodeURIComponent(String(req.params[0] ?? ''))
      const absolute = resolveArtifactAbsolutePath(projectRoot, artifactPath)
      await fs.access(absolute)
      if (isLikelyTextExtension(artifactPath)) {
        res.type('text/plain; charset=utf-8')
      }
      res.sendFile(absolute)
    } catch (error) {
      await sendJsonError(res, error, 404)
    }
  })

  async function handleDecision(action: ReviewAction, req: Request, res: Response): Promise<void> {
    try {
      const packetId = req.params.id
      const comment = asString(req.body?.comment)
      const result = await reviewPacket({
        projectRoot,
        packetId,
        action,
        ...(comment ? { comment } : {})
      })
      broadcast({ type: 'decision_applied', data: { action, packet_id: packetId, result, timestamp: nowIso() } })
      await broadcastSnapshot()
      res.json(result)
    } catch (error) {
      await sendJsonError(res, error, 400)
    }
  }

  app.post('/api/packets/:id/approve', async (req, res) => {
    await handleDecision('approve', req, res)
  })

  app.post('/api/packets/:id/request-changes', async (req, res) => {
    await handleDecision('request_changes', req, res)
  })

  app.post('/api/packets/:id/reject', async (req, res) => {
    await handleDecision('reject', req, res)
  })

  app.post('/api/agent/start', async (req, res) => {
    try {
      const topic = asString(req.body?.topic).trim()
      if (!topic) {
        res.status(400).json({ error: '"topic" is required.' })
        return
      }
      const runId = scheduleRun('start', { topic, userMessage: topic })
      res.status(202).json({ accepted: true, run_id: runId })
    } catch (error) {
      await sendJsonError(res, error, 409)
    }
  })

  app.post('/api/agent/message', async (req, res) => {
    try {
      const message = asString(req.body?.message).trim()
      if (!message) {
        res.status(400).json({ error: '"message" is required.' })
        return
      }
      const runId = scheduleRun('message', { userMessage: message })
      res.status(202).json({ accepted: true, run_id: runId })
    } catch (error) {
      await sendJsonError(res, error, 409)
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const url = `http://${host}:${port}`
  broadcast({ type: 'info', data: { message: `Server started at ${url}`, timestamp: nowIso() } })

  if (openBrowser) {
    void tryOpenBrowser(url)
  }

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => wsServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
  }
}
