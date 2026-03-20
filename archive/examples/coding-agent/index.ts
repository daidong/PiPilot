/**
 * coding-agent — CLI entry point
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-xxx   # or OPENAI_API_KEY
 *   npx tsx examples/coding-agent/index.ts "fix the null check in UserService"
 *
 * Options:
 *   --project <path>   Project root (default: cwd)
 *   --model <id>       Model ID (default: auto-detect from API key)
 *   --commit           After completing the task, commit the changes
 *   --test <cmd>       Run this test command after changes (e.g. "npm test")
 *   --context <text>   One-line project summary to pin in context
 *   --approval         Require interactive approval for dangerous bash commands
 *   --debug            Enable debug logging
 *
 * Examples:
 *   # Simple fix
 *   npx tsx examples/coding-agent/index.ts "add input validation to createUser()"
 *
 *   # Fix → test → commit pipeline
 *   npx tsx examples/coding-agent/index.ts \
 *     "fix the race condition in the job queue" \
 *     --commit
 *
 *   # Specify project and test command
 *   npx tsx examples/coding-agent/index.ts \
 *     --project ~/my-project \
 *     --test "pytest -x" \
 *     "refactor the database connection pooling"
 */

import { resolve } from 'path'
import { createCodingAgent, runTask } from './agent.js'

// ── Parse CLI args ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  task: string
  projectPath: string
  model?: string
  commit: boolean
  testCmd?: string
  projectSummary?: string
  requireApproval: boolean
  debug: boolean
} {
  const args = argv.slice(2)
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--commit') { flags.commit = true }
    else if (arg === '--approval') { flags.approval = true }
    else if (arg === '--debug') { flags.debug = true }
    else if (arg === '--project' && args[i + 1]) { flags.project = args[++i] }
    else if (arg === '--model' && args[i + 1]) { flags.model = args[++i] }
    else if (arg === '--test' && args[i + 1]) { flags.test = args[++i] }
    else if (arg === '--context' && args[i + 1]) { flags.context = args[++i] }
    else if (!arg.startsWith('--')) { positional.push(arg) }
  }

  const task = positional.join(' ').trim()
  if (!task) {
    console.error('Usage: npx tsx examples/coding-agent/index.ts "your task here" [options]')
    console.error('       npx tsx examples/coding-agent/index.ts --help')
    process.exit(1)
  }

  return {
    task,
    projectPath: resolve(flags.project as string ?? process.cwd()),
    model: flags.model as string | undefined,
    commit: Boolean(flags.commit),
    testCmd: flags.test as string | undefined,
    projectSummary: flags.context as string | undefined,
    requireApproval: Boolean(flags.approval),
    debug: Boolean(flags.debug),
  }
}

// ── Progress display ───────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read: '📖', write: '✍️', edit: '✏️',
  bash: '⚡', glob: '🔍', grep: '🔎',
  git_status: '📊', git_diff: '📋', git_add: '➕',
  git_commit: '💾', git_log: '📜',
  'ctx-get': '🧠',
}

function formatToolCall(tool: string, args: unknown): string {
  const icon = TOOL_ICONS[tool] ?? '🔧'
  const a = args as Record<string, unknown>

  if (tool === 'bash') return `${icon} bash: ${String(a.command ?? '').split('\n')[0].slice(0, 60)}`
  if (tool === 'read') return `${icon} read: ${a.path ?? a.file_path ?? ''}`
  if (tool === 'edit') return `${icon} edit: ${a.path ?? a.file_path ?? ''}`
  if (tool === 'write') return `${icon} write: ${a.path ?? a.file_path ?? ''}`
  if (tool === 'glob') return `${icon} glob: ${a.pattern ?? ''}`
  if (tool === 'grep') return `${icon} grep: ${a.pattern ?? ''}`
  if (tool === 'git_commit') return `${icon} commit: ${String(a.message ?? '').slice(0, 50)}`
  if (tool === 'git_diff') return `${icon} git diff${a.staged ? ' --staged' : ''}`
  return `${icon} ${tool}`
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { task, projectPath, model, commit, testCmd, projectSummary, requireApproval, debug } = parseArgs(process.argv)

  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY

  console.log(`\n🤖 Coding Agent`)
  console.log(`📁 Project: ${projectPath}`)
  console.log(`📝 Task: ${task}\n`)

  // Track token usage
  let totalTokens = 0
  let totalCost = 0

  const agent = createCodingAgent({
    projectPath,
    apiKey,
    model,
    projectSummary,
    requireApproval,
    debug,

    onStream: (text) => process.stdout.write(text),

    onToolCall: (tool, args) => {
      process.stdout.write('\n')
      console.log(`  ${formatToolCall(tool, args)}`)
    },

    onToolResult: (tool, result) => {
      const r = result as { success?: boolean; error?: string }
      if (r.success === false) {
        console.log(`  ❌ ${tool} failed: ${r.error?.slice(0, 100) ?? 'unknown error'}`)
      }
    },

    onUsage: (usage, cost) => {
      totalTokens += usage.totalTokens
      totalCost += cost.totalCost
    },
  })

  // ── Build follow-up pipeline ─────────────────────────────────────────────
  // The .followUp() chain runs sequentially after each natural stopping point.
  // If the main task completes without errors, the agent will continue with
  // test → commit steps automatically.

  const followUps: string[] = []

  if (testCmd) {
    followUps.push(
      `Run the tests with: ${testCmd}\n` +
      `If any tests fail, fix them before proceeding. Do not move on with failing tests.`
    )
  }

  if (commit) {
    followUps.push(
      `Review the changes with git_diff, then:\n` +
      `1. Stage the relevant files (use specific paths, not ".")\n` +
      `2. Write a descriptive commit message following conventional commits format\n` +
      `3. Commit the changes`
    )
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  const startTime = Date.now()

  try {
    const result = await runTask(agent, { task, followUps })

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log('\n\n' + '─'.repeat(60))
    console.log(`✅ Done in ${elapsed}s — ${result.steps} steps, ${totalTokens.toLocaleString()} tokens`)
    if (totalCost > 0) {
      console.log(`💰 Estimated cost: $${totalCost.toFixed(4)}`)
    }
    console.log('─'.repeat(60))

    if (result.response) {
      console.log('\n' + result.response)
    }

  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.error(`\n❌ Failed after ${elapsed}s: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

main()
