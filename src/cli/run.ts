/**
 * run CLI Command
 *
 * Runs an agent task once or in autonomous loop mode.
 */

import * as readline from 'node:readline'
import { createAgent } from '../agent/create-agent.js'
import { tryLoadConfig } from '../config/index.js'

export interface RunOptions {
  prompt: string
  projectPath?: string
  model?: string
  interactive?: boolean
  mode?: 'single' | 'autonomous'
  maxTurns?: number
  stopCondition?: string
  continuePrompt?: string
  additionalInstructions?: string
  quiet?: boolean
}

/**
 * Extract a brief summary from tool input args for log display.
 */
function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const args = input as Record<string, unknown>

  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return String(args.path ?? args.file_path ?? '')
    case 'glob':
      return String(args.pattern ?? '')
    case 'grep':
      return String(args.pattern ?? '')
    case 'bash': {
      const cmd = String(args.command ?? '')
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
    }
    case 'skill-script-run':
      return [args.skillId, args.script].filter(Boolean).join('/')
    case 'kv-get':
    case 'kv-set':
    case 'kv-delete':
      return String(args.key ?? '')
    case 'todo-add':
    case 'todo-update':
      return String(args.text ?? args.id ?? '')
    case 'fetch':
      return String(args.url ?? '')
    default: {
      const fallback = args.path ?? args.file_path ?? args.name ?? args.id
      return typeof fallback === 'string' ? fallback : ''
    }
  }
}

const TOOL_ERROR_LIMIT = 160

function compactAndLimit(text: string, limit: number = TOOL_ERROR_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= limit) return compact
  return `${compact.slice(0, limit)}...`
}

function formatStructuredToolError(rawError: string): string | undefined {
  try {
    const parsed = JSON.parse(rawError) as {
      error?: { category?: unknown; source?: unknown; data?: { reason?: unknown } }
      guidance?: unknown
    }
    const category = typeof parsed.error?.category === 'string' ? parsed.error.category : undefined
    const source = typeof parsed.error?.source === 'string' ? parsed.error.source : undefined
    const reason = typeof parsed.error?.data?.reason === 'string' ? parsed.error.data.reason : undefined
    const guidance = typeof parsed.guidance === 'string' ? parsed.guidance : undefined
    const parts = [category, source, reason, guidance].filter((item): item is string => Boolean(item))
    if (parts.length === 0) return undefined
    return compactAndLimit(parts.join(' | '))
  } catch {
    return undefined
  }
}

function extractResultOutputHint(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const sourceText = stderr.trim() ? stderr : stdout
  const compact = compactAndLimit(sourceText)
  return compact || undefined
}

/**
 * Format a tool result log line for stderr output.
 */
function formatToolResultLog(
  tool: string,
  result: unknown,
  args?: unknown
): string {
  const summary = summarizeToolInput(tool, args)
  const detail = summary ? ` ${summary}` : ''
  const res = result as { success?: boolean; error?: unknown; data?: unknown } | undefined

  if (res?.success === false) {
    const structured = typeof res.error === 'string' ? formatStructuredToolError(res.error) : undefined
    const raw = typeof res.error === 'string' ? compactAndLimit(res.error) : undefined
    const outputHint = extractResultOutputHint(res.data)
    let errorText = structured ?? raw
    if (!errorText && res.error !== undefined && res.error !== null) {
      errorText = compactAndLimit(String(res.error))
    }
    if (!errorText && outputHint) {
      errorText = outputHint
    } else if (errorText && outputHint && /^Command exited with code\s+\d+\s*$/.test(errorText)) {
      errorText = compactAndLimit(`${errorText}: ${outputHint}`)
    }
    const errMsg = errorText ? ` -- ${errorText}` : ''
    return `  \u2717 ${tool}${detail}${errMsg}\n`
  }
  return `  \u2713 ${tool}${detail}\n`
}

export function parseRunArgs(args: string[]): RunOptions {
  const options: Partial<RunOptions> = {}
  const promptParts: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    switch (arg) {
      case '--project':
      case '--project-path':
      case '-C':
        if (args[i + 1]) {
          options.projectPath = args[++i]
        }
        break

      case '--model':
      case '-m':
        if (args[i + 1]) {
          options.model = args[++i]
        }
        break

      case '--interactive':
      case '-i':
        options.interactive = true
        break

      case '--mode':
        if (args[i + 1] === 'single' || args[i + 1] === 'autonomous') {
          options.mode = args[++i] as 'single' | 'autonomous'
        }
        break

      case '--single':
      case '-s':
        options.mode = 'single'
        break

      case '--autonomous':
      case '-a':
        options.mode = 'autonomous'
        break

      case '--max-turns':
        if (args[i + 1]) {
          const parsed = parseInt(args[++i]!, 10)
          if (!Number.isNaN(parsed)) options.maxTurns = parsed
        }
        break

      case '--stop':
        if (args[i + 1]) {
          options.stopCondition = args[++i]
        }
        break

      case '--continue':
        if (args[i + 1]) {
          options.continuePrompt = args[++i]
        }
        break

      case '--instructions':
      case '--additional-instructions':
        if (args[i + 1]) {
          options.additionalInstructions = args[++i]
        }
        break

      case '--quiet':
      case '-q':
        options.quiet = true
        break

      default:
        if (!arg.startsWith('-')) {
          promptParts.push(arg)
        }
        break
    }
  }

  const prompt = promptParts.join(' ').trim()

  // If no prompt provided, enter interactive mode
  if (!prompt) {
    options.interactive = true
  }

  return {
    prompt: prompt || '',
    ...options
  } as RunOptions
}

/**
 * Run interactive REPL mode: reads prompts from stdin, runs agent, prints response.
 */
async function runInteractive(options: RunOptions): Promise<void> {
  const projectPath = options.projectPath ?? process.cwd()
  const verbose = !options.quiet

  const agentOpts: Record<string, unknown> = {
    projectPath,
    configDir: projectPath,
    onToolCall: verbose
      ? (tool: string, input: unknown) => {
          const summary = summarizeToolInput(tool, input)
          const detail = summary ? ` ${summary}` : ''
          process.stderr.write(`  \u25B8 ${tool}${detail}\n`)
        }
      : undefined,
    onToolResult: verbose
      ? (tool: string, result: unknown, args?: unknown) => {
          process.stderr.write(formatToolResultLog(tool, result, args))
        }
      : undefined
  }
  if (options.model) {
    agentOpts.model = options.model
  }

  const agent = createAgent(agentOpts as Parameters<typeof createAgent>[0])

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\nagent> '
  })

  console.error('AgentFoundry interactive mode. Type your prompt and press Enter.')
  console.error('Type "exit" or press Ctrl+D to quit.\n')
  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }
    if (input === 'exit' || input === 'quit') {
      rl.close()
      return
    }

    try {
      const result = await agent.run(input)
      process.stdout.write(result.output)
      if (!result.output.endsWith('\n')) process.stdout.write('\n')
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
    }
    rl.prompt()
  })

  await new Promise<void>((resolve) => {
    rl.on('close', resolve)
  })

  await agent.destroy()
}

export async function runAgentTask(options: RunOptions): Promise<void> {
  // Interactive mode: no prompt provided or --interactive flag
  if (options.interactive && !options.prompt) {
    await runInteractive(options)
    return
  }

  const projectPath = options.projectPath ?? process.cwd()
  const yamlConfig = tryLoadConfig(projectPath)
  const runner = yamlConfig?.runner ?? {}

  const mode = options.mode ?? runner.mode ?? 'single'
  const maxTurns = options.maxTurns ?? runner.maxTurns ?? 50
  const stopCondition = options.stopCondition ?? runner.stopCondition ?? 'TASK_COMPLETE'
  const continuePrompt = options.continuePrompt ?? runner.continuePrompt ?? 'Continue your work.'
  const baseInstructions = options.additionalInstructions ?? runner.additionalInstructions

  const verbose = !options.quiet

  const agentOpts: Record<string, unknown> = {
    projectPath,
    configDir: projectPath,
    onToolCall: verbose
      ? (tool: string, input: unknown) => {
          const summary = summarizeToolInput(tool, input)
          const detail = summary ? ` ${summary}` : ''
          process.stderr.write(`  \u25B8 ${tool}${detail}\n`)
        }
      : undefined,
    onToolResult: verbose
      ? (tool: string, result: unknown, args?: unknown) => {
          process.stderr.write(formatToolResultLog(tool, result, args))
        }
      : undefined
  }
  if (options.model) {
    agentOpts.model = options.model
  }

  const agent = createAgent(agentOpts as Parameters<typeof createAgent>[0])

  try {
    if (mode === 'single') {
      if (verbose) {
        process.stderr.write(`\n\u2500\u2500 single run \u2500\u2500\n`)
      }
      const result = await agent.run(options.prompt, {
        additionalInstructions: baseInstructions
      })
      process.stdout.write(result.output)
      if (!result.output.endsWith('\n')) process.stdout.write('\n')
      return
    }

    const autonomousInstructions = [
      baseInstructions,
      `Autonomous mode: if the task is fully complete, output exactly "${stopCondition}" on its own line at the end.`,
      `If not complete, continue working and propose the next concrete action.`
    ].filter(Boolean).join('\n\n')

    let prompt = options.prompt
    let completed = false

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (verbose) {
        process.stderr.write(`\n\u2500\u2500 turn ${turn}/${maxTurns} \u2500\u2500\n`)
      }

      const result = await agent.run(prompt, {
        additionalInstructions: autonomousInstructions
      })

      process.stdout.write(result.output)
      if (!result.output.endsWith('\n')) process.stdout.write('\n')

      const lines = result.output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)

      if (lines.includes(stopCondition)) {
        completed = true
        if (verbose) {
          process.stderr.write(`\n\u2500\u2500 completed \u2500\u2500\n`)
        }
        break
      }

      prompt = continuePrompt
    }

    if (!completed) {
      throw new Error(`Autonomous run reached maxTurns (${maxTurns}) without stopCondition "${stopCondition}"`)
    }
  } finally {
    await agent.destroy()
  }
}

export function printRunHelp(): void {
  console.log(`
run - Execute a task with agent.yaml configuration

Usage:
  agent-foundry run "<task>" [options]
  agent-foundry run                     # interactive mode (no prompt)
  agent-foundry run --interactive       # explicit interactive mode

Options:
  --project, --project-path, -C <path>  Project/config directory (default: current directory)
  --model, -m <model>                   Override LLM model (e.g. gpt-4o, claude-sonnet-4-20250514)
  --interactive, -i                     Enter interactive REPL mode
  --mode <single|autonomous>            Run mode override (default: runner.mode or single)
  --single, -s                          Shortcut for --mode single
  --autonomous, -a                      Shortcut for --mode autonomous
  --max-turns <n>                       Max autonomous turns (default: runner.maxTurns or 50)
  --stop <text>                         Stop condition token (default: runner.stopCondition or TASK_COMPLETE)
  --continue <text>                     Continue prompt between turns (default: runner.continuePrompt)
  --instructions <text>                 Additional task instructions for this run
  --quiet, -q                           Suppress tool call logs (stderr)

Examples:
  $ agent-foundry run "Summarize docs/architecture.md"
  $ agent-foundry run --model claude-sonnet-4-20250514 "Explain this codebase"
  $ agent-foundry run                                     # interactive mode
  $ agent-foundry run "Research MCP servers and write a report" --autonomous --max-turns 20
  $ agent-foundry run "Refactor src/core" --project ./my-repo
`)
}
