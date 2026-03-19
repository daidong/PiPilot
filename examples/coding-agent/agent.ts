/**
 * createCodingAgent — factory for the coding agent
 *
 * Wires together:
 *   - packs.safe()    file I/O (read/write/edit/glob/grep)
 *   - packs.exec()    bash (test runner, build, scripts)
 *   - packs.git()     git_status/diff/add/commit/log
 *   - codingWorkflowSkill  lazy-loaded TDD + commit guidance
 *   - hooks           safety gate on bash (blocks destructive patterns)
 *   - transformContext  injects live git status each LLM call (GAP-9)
 *   - pinnedMessages  keeps project summary always visible (GAP-10)
 *   - contextWindow   enables proactive token trimming (GAP-6)
 */

import { createAgent, packs, definePack } from '../../src/index.js'
import type { Agent, AgentRunHandle } from '../../src/index.js'
import type { Message } from '../../src/index.js'
import type { DetailedTokenUsage, TokenCost } from '../../src/llm/provider.types.js'
import { codingWorkflowSkill } from './skills/index.js'

// ── Dangerous bash patterns ────────────────────────────────────────────────
// The exec pack already blocks the worst offenders via noDestructive policy.
// These are additional semantic checks done in the beforeToolCall hook.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-[rf]+\s+\//, reason: 'Deleting root filesystem' },
  { pattern: /git\s+push.*--force(?!-with-lease).*\s+(main|master)/, reason: 'Force-pushing to main/master' },
  { pattern: /:\s*>\s*\/etc\//, reason: 'Overwriting system files' },
  { pattern: /curl.*\|\s*(ba)?sh/, reason: 'Piping remote scripts to shell' },
  { pattern: />\s*~\/\.(?:bashrc|zshrc|profile|ssh)/, reason: 'Overwriting shell config or SSH keys' },
]

// ── Config ─────────────────────────────────────────────────────────────────

export interface CodingAgentConfig {
  /** Root directory of the project being worked on */
  projectPath: string

  /** API key (falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY env vars) */
  apiKey?: string

  /** Model ID. Defaults to claude-sonnet-4-6 or auto-detected from API key */
  model?: string

  /**
   * Context window size in tokens.
   * Enables GAP-6 proactive trimming. Set to your model's actual window.
   * Common values: 200_000 (Claude), 128_000 (GPT-4o)
   */
  contextWindow?: number

  /**
   * Short description of the project (1-3 sentences).
   * Pinned to every LLM call so the agent always knows what it's working on.
   */
  projectSummary?: string

  /**
   * When true, dangerous bash commands require interactive approval.
   * Default: false (headless-friendly; hook still blocks the worst patterns).
   */
  requireApproval?: boolean

  /** Streaming text callback */
  onStream?: (text: string) => void

  /** Tool call callback — useful for progress display */
  onToolCall?: (tool: string, args: unknown) => void

  /** Tool result callback */
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void

  /** Usage/cost callback */
  onUsage?: (usage: DetailedTokenUsage, cost: TokenCost) => void

  /** Enable debug logging */
  debug?: boolean
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createCodingAgent(config: CodingAgentConfig): Agent {
  const {
    projectPath,
    apiKey,
    model,
    contextWindow = 200_000,
    projectSummary,
    requireApproval = false,
    onStream,
    onToolCall,
    onToolResult,
    onUsage,
    debug,
  } = config

  // GAP-10: Pin the project summary so it never disappears from context
  const pinnedMessages: Message[] = projectSummary
    ? [{ role: 'user', content: `[Project context]\n${projectSummary}` }]
    : []

  // GAP-9: Inject live git status before every LLM call.
  // This gives the model real-time awareness of what has changed without
  // manually including it in every user message.
  const transformContext = async (messages: Message[]): Promise<Message[]> => {
    try {
      const { execSync } = await import('child_process')
      const status = execSync('git status --short 2>/dev/null || echo "(not a git repo)"', {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 3000
      }).trim()

      if (!status || status === '(not a git repo)') return messages

      const statusNote: Message = {
        role: 'user',
        content: `[git status — updated every step]\n${status || '(clean — no uncommitted changes)'}`
      }
      // Append at the end so it's the freshest info before the LLM call
      return [...messages, statusNote]
    } catch {
      return messages
    }
  }

  return createAgent({
    projectPath,
    apiKey,
    model: model ?? (apiKey?.startsWith('sk-ant') ? 'claude-sonnet-4-6' : undefined),
    skipConfigFile: true,

    // ── Capability packs ─────────────────────────────────────────────────
    packs: [
      packs.safe(),
      packs.exec({
        approvalMode: requireApproval ? 'dangerous' : 'none',
        // Additional deny patterns on top of the pack's built-in noDestructive policy
        denyPatterns: [
          /\bsudo\b/,
          /chmod\s+777/,
        ]
      }),
      packs.git(),
      definePack({
        id: 'coding-knowledge',
        description: 'Coding workflow skill',
        skills: [codingWorkflowSkill],
        skillLoadingConfig: {
          lazy: ['coding-workflow']
        }
      })
    ],

    // ── Identity ──────────────────────────────────────────────────────────
    identity: `You are an expert software engineer.
You write clean, well-tested, idiomatic code.
You always read files before editing them.
You run tests after every non-trivial change.
You commit in small logical units with clear messages.
You never break existing tests without fixing them first.`,

    constraints: [
      'Use glob and grep to locate files — never assume paths',
      'Read a file before editing it',
      'Run the test suite after completing a change',
      'Make one logical change per commit',
      'If you are unsure about scope, ask before making large changes',
    ],

    // ── Context management ────────────────────────────────────────────────
    contextWindow,                    // GAP-6: proactive token trimming
    pinnedMessages,                   // GAP-10: project summary always visible
    transformContext,                 // GAP-9: live git status injected each step

    // ── Safety hook ───────────────────────────────────────────────────────
    hooks: {
      beforeToolCall: async ({ tool, input }) => {
        if (tool !== 'bash') return
        const cmd = (input as { command?: string }).command ?? ''
        for (const { pattern, reason } of DANGEROUS_PATTERNS) {
          if (pattern.test(cmd)) {
            return { block: true, reason: `Blocked: ${reason} — command: ${cmd.slice(0, 80)}` }
          }
        }
      }
    },

    // ── Callbacks ─────────────────────────────────────────────────────────
    onStream,
    onToolCall,
    onToolResult,
    onUsage,

    // ── Execution limits ──────────────────────────────────────────────────
    maxSteps: 60,
    toolLoopThreshold: 12,
    trace: { export: { enabled: false } },
    debug,
  })
}

// ── Convenience: run a task with an optional follow-up pipeline ────────────

export interface RunTaskOptions {
  /** Primary task description */
  task: string
  /**
   * Follow-up tasks to chain after the main task completes.
   * Each runs when the agent would otherwise stop.
   * Example: ['Run tests and fix any failures', 'Commit the changes']
   */
  followUps?: string[]
}

export function runTask(agent: Agent, options: RunTaskOptions): AgentRunHandle {
  const { task, followUps = [] } = options
  let handle = agent.run(task)
  for (const fu of followUps) {
    handle = handle.followUp(fu)
  }
  return handle
}
