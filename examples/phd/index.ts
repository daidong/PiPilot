#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getPacket,
  getStatus,
  getMemoryDigest,
  getMemoryEntries,
  initProject,
  listInbox,
  reviewPacket,
  runTurn,
  smokeTest,
  viewArtifact
} from './runtime.js'
import { startPhdServer } from './server.js'
import type { ReviewAction } from './types.js'

interface ParsedArgs {
  command: string
  positionals: string[]
  options: Record<string, string>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_PROJECT = path.join(__dirname, 'demo-project')

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const positionals: string[] = []
  const options: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (!next || next.startsWith('--')) {
      options[key] = 'true'
      continue
    }
    options[key] = next
    i += 1
  }
  return { command, positionals, options }
}

function resolveProjectPath(options: Record<string, string>): string {
  return path.resolve(options.project ?? DEFAULT_PROJECT)
}

function printHelp(): void {
  const lines = [
    'PHD RAM v0.2 CLI',
    '',
    'Usage:',
    '  tsx examples/phd/index.ts <command> [options]',
    '',
    'Commands:',
    '  init [--project <dir>]',
    '  serve [--project <dir>] [--port <n>] [--host <ip>] [--no-open]',
    '  run [--project <dir>]',
    '  inbox [--project <dir>]',
    '  packet <packetId> [--project <dir>]',
    '  artifact <relativePath> [--project <dir>]',
    '  memory [--project <dir>] [--limit <n>] [--digest <n>]',
    '  review <packetId> <approve|request_changes|reject> [--comment "<text>"] [--project <dir>]',
    '  status [--project <dir>]',
    '  smoke-test [--project <dir>]',
    '',
    `Default project: ${DEFAULT_PROJECT}`
  ]
  console.log(lines.join('\n'))
}

function assertReviewAction(value: string): ReviewAction {
  if (value === 'approve' || value === 'request_changes' || value === 'reject') {
    return value
  }
  throw new Error(`Invalid review action: ${value}`)
}

async function handleCommand(parsed: ParsedArgs): Promise<void> {
  const projectRoot = resolveProjectPath(parsed.options)

  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    printHelp()
    return
  }

  if (parsed.command === 'init') {
    const result = await initProject(projectRoot)
    console.log(`Initialized project at ${result.projectRoot}`)
    return
  }

  if (parsed.command === 'serve') {
    const port = Number.parseInt(parsed.options.port ?? '3000', 10)
    const host = parsed.options.host ?? '127.0.0.1'
    const openBrowser = parsed.options['no-open'] !== 'true'
    const server = await startPhdServer({
      projectRoot,
      port: Number.isFinite(port) ? port : 3000,
      host,
      openBrowser
    })
    console.log(`PHD RAM server running at ${server.url}`)
    console.log(`Workspace: ${projectRoot}`)
    console.log('Press Ctrl+C to stop.')

    const shutdown = async () => {
      await server.close()
      process.exit(0)
    }

    process.once('SIGINT', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    return
  }

  if (parsed.command === 'run') {
    const result = await runTurn({
      projectRoot
    })
    console.log([
      `Run completed.`,
      `packet_id: ${result.packet_id}`,
      `event_type: ${result.event_type}`,
      `state: ${result.state}`,
      `task_id: ${result.task_id}`,
      `title: ${result.title}`
    ].join('\n'))
    return
  }

  if (parsed.command === 'inbox') {
    const items = await listInbox(projectRoot)
    if (items.length === 0) {
      console.log('Review inbox is empty.')
      return
    }
    for (const item of items) {
      console.log([
        `- ${item.packet_id}: ${item.title}`,
        `  type=${item.type}, risk=${item.risk}`,
        `  scope=${item.scope_summary}`,
        `  ask=${item.ask_summary}`
      ].join('\n'))
    }
    return
  }

  if (parsed.command === 'packet') {
    const packetId = parsed.positionals[0]
    if (!packetId) throw new Error('packet command requires <packetId>.')
    const packet = await getPacket(projectRoot, packetId)
    if (!packet) throw new Error(`Packet not found: ${packetId}`)
    console.log(JSON.stringify(packet, null, 2))
    return
  }

  if (parsed.command === 'artifact') {
    const artifactPath = parsed.positionals[0]
    if (!artifactPath) throw new Error('artifact command requires <relativePath>.')
    const output = await viewArtifact({ projectRoot, artifactPath })
    console.log(output)
    return
  }

  if (parsed.command === 'memory') {
    const limit = Number.parseInt(parsed.options.limit ?? '40', 10)
    const digestSize = Number.parseInt(parsed.options.digest ?? '8', 10)
    const [entries, digest] = await Promise.all([
      getMemoryEntries(projectRoot, Number.isFinite(limit) ? limit : 40),
      getMemoryDigest(projectRoot, Number.isFinite(digestSize) ? digestSize : 8)
    ])
    console.log(JSON.stringify({ digest, entries }, null, 2))
    return
  }

  if (parsed.command === 'review') {
    const packetId = parsed.positionals[0]
    const actionRaw = parsed.positionals[1]
    if (!packetId || !actionRaw) {
      throw new Error('review command requires <packetId> <approve|request_changes|reject>.')
    }
    const action = assertReviewAction(actionRaw)
    const result = await reviewPacket({
      projectRoot,
      packetId,
      action,
      ...(parsed.options.comment ? { comment: parsed.options.comment } : {})
    })
    console.log([
      `Decision recorded.`,
      `decision_id: ${result.decision_id}`,
      `packet_id: ${result.packet_id}`,
      `action: ${result.action}`,
      `state: ${result.state}`
    ].join('\n'))
    return
  }

  if (parsed.command === 'status') {
    const status = await getStatus(projectRoot)
    console.log(JSON.stringify(status, null, 2))
    return
  }

  if (parsed.command === 'smoke-test') {
    const result = await smokeTest(projectRoot)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error(`Unknown command: ${parsed.command}`)
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  await handleCommand(parsed)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exitCode = 1
})
