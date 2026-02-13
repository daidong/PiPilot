/**
 * run CLI Command
 *
 * Runs an agent task once or in autonomous loop mode.
 */

import { createAgent } from '../agent/create-agent.js'
import { tryLoadConfig } from '../config/index.js'

export interface RunOptions {
  prompt: string
  projectPath?: string
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
  const res = result as { success?: boolean; error?: string } | undefined

  if (res?.success === false) {
    const errMsg = res.error
      ? ` -- ${res.error.length > 80 ? res.error.slice(0, 77) + '...' : res.error}`
      : ''
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
      case '-C':
        if (args[i + 1]) {
          options.projectPath = args[++i]
        }
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
  if (!prompt) {
    throw new Error('Missing prompt. Usage: agent-foundry run "<task>"')
  }

  return {
    prompt,
    ...options
  } as RunOptions
}

export async function runAgentTask(options: RunOptions): Promise<void> {
  const projectPath = options.projectPath ?? process.cwd()
  const yamlConfig = tryLoadConfig(projectPath)
  const runner = yamlConfig?.runner ?? {}

  const mode = options.mode ?? runner.mode ?? 'single'
  const maxTurns = options.maxTurns ?? runner.maxTurns ?? 50
  const stopCondition = options.stopCondition ?? runner.stopCondition ?? 'TASK_COMPLETE'
  const continuePrompt = options.continuePrompt ?? runner.continuePrompt ?? 'Continue your work.'
  const baseInstructions = options.additionalInstructions ?? runner.additionalInstructions

  const verbose = !options.quiet

  const agent = createAgent({
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
  })

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

Options:
  --project, -C <path>        Project/config directory (default: current directory)
  --mode <single|autonomous>  Run mode override (default: runner.mode or single)
  --single, -s                Shortcut for --mode single
  --autonomous, -a            Shortcut for --mode autonomous
  --max-turns <n>             Max autonomous turns (default: runner.maxTurns or 50)
  --stop <text>               Stop condition token (default: runner.stopCondition or TASK_COMPLETE)
  --continue <text>           Continue prompt between turns (default: runner.continuePrompt)
  --instructions <text>       Additional task instructions for this run
  --quiet, -q                 Suppress tool call logs (stderr)

Examples:
  $ agent-foundry run "Summarize docs/architecture.md"
  $ agent-foundry run "Research MCP servers and write a report" --autonomous --max-turns 20
  $ agent-foundry run "Refactor src/core" --project ./my-repo
`)
}
