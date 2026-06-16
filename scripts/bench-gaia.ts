/**
 * Headless GAIA batch runner.
 *
 * Runs the Research Pilot coordinator over GAIA tasks WITHOUT the Electron UI.
 * Each task gets its own fresh project folder, which gives three things for
 * free, with zero changes to the app:
 *   1. isolation   — every run writes its own `<out>/<task_id>/.research-pilot/`
 *   2. clean ctx   — a fresh folder has no session summary / recap / bootstrap,
 *                    so nothing leaks between tasks (the leak that "Reset AI
 *                    context" can't fix when a folder is reused)
 *   3. provenance  — a PipilotTracer is constructed directly (bypassing the
 *                    app's opt-in `tracingMode` gate), so spans always land in
 *                    `<task_id>/.research-pilot/traces/`. Open any task folder
 *                    as a project in the app to view its audit graph.
 *
 * Run with tsx (same loader the test suite uses):
 *   node --import tsx scripts/bench-gaia.ts --model anthropic:claude-opus-4-8
 *
 * Prereqs:
 *   - GAIA downloaded to <gaia>/2023/validation/ (parquet + attachment files)
 *   - metadata.jsonl generated: `/opt/anaconda3/bin/python scripts/gaia_to_jsonl.py`
 *   - API key saved in the app (Settings → API Keys) OR exported in the shell
 *
 * This runner does NOT score answers. It stores the raw model output plus the
 * GAIA ground truth so you can score later with a separate tool.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createCoordinator } from '../lib/agents/coordinator.js'
import { PipilotTracer } from '../lib/telemetry/tracer.js'
import { PATHS } from '../lib/types.js'
import { applyApiKeysToEnv } from '../shared-electron/api-key-loader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// ─── CLI parsing ──────────────────────────────────────────────────────────
interface Args {
  model: string
  gaia: string
  split: string
  out: string
  perLevel: number
  levels: string[]
  tasks: string[]
  all: boolean
  limit: number
  concurrency: number
  reasoning: 'max' | 'high' | 'medium' | 'low'
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (flag: string): boolean => argv.includes(flag)
  return {
    model: get('--model') ?? '',
    gaia: get('--gaia') ?? join(homedir(), 'Desktop/Provenance/gaia-data'),
    split: get('--split') ?? 'validation',
    // Empty → auto-named after selection (see resolveOutDir): GAIA-<split>_<stamp>_<N>q
    out: get('--out') ?? '',
    perLevel: Number(get('--per-level') ?? 2),
    levels: (get('--levels') ?? '1,2,3').split(',').map((s) => s.trim()),
    tasks: (get('--tasks') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    all: has('--all'),
    limit: Number(get('--limit') ?? 0),
    concurrency: Number(get('--concurrency') ?? 1),
    reasoning: (get('--reasoning') ?? 'high') as Args['reasoning'],
    dryRun: has('--dry-run'),
  }
}

// ─── GAIA task model ────────────────────────────────────────────────────────
interface GaiaTask {
  task_id: string
  Question: string
  Level: string
  'Final answer': string | null
  file_name: string | null
  file_path: string | null
  'Annotator Metadata': unknown
}

function loadTasks(gaia: string, split: string): GaiaTask[] {
  const jsonl = join(gaia, '2023', split, 'metadata.jsonl')
  if (!existsSync(jsonl)) {
    throw new Error(
      `metadata.jsonl not found: ${jsonl}\n` +
        `Generate it first: /opt/anaconda3/bin/python scripts/gaia_to_jsonl.py "${gaia}" ${split}`,
    )
  }
  return readFileSync(jsonl, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GaiaTask)
}

/** Auto output dir name: GAIA-<split>_<YYYYMMDD-HHMM>_<N>q (used when --out is omitted). */
function resolveOutDir(a: Args, count: number): string {
  if (a.out) return a.out
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return join(REPO_ROOT, 'runs', `GAIA-${a.split}_${stamp}_${count}q`)
}

/** Deterministic subset: sort by task_id, take first `perLevel` from each level. */
function selectTasks(all: GaiaTask[], a: Args): GaiaTask[] {
  if (a.tasks.length) return all.filter((t) => a.tasks.includes(t.task_id))
  // Always honor --levels (defaults to 1,2,3, so no-op unless narrowed).
  const pool = [...all]
    .filter((t) => a.levels.includes(String(t.Level)))
    .sort((x, y) => x.task_id.localeCompare(y.task_id))
  if (a.all) return a.limit ? pool.slice(0, a.limit) : pool
  const picked: GaiaTask[] = []
  for (const level of a.levels) {
    picked.push(...pool.filter((t) => String(t.Level) === level).slice(0, a.perLevel))
  }
  return a.limit ? picked.slice(0, a.limit) : picked
}

// ─── Per-task project scaffolding ───────────────────────────────────────────
const SCAFFOLD_DIRS = [
  PATHS.root,
  PATHS.artifactsRoot,
  PATHS.notes,
  PATHS.papers,
  PATHS.data,
  PATHS.webContent,
  PATHS.toolOutputs,
  PATHS.sessions,
  PATHS.cache,
  PATHS.documentCache,
  PATHS.memoryRoot,
  PATHS.sessionSummaries,
  PATHS.skills,
  PATHS.memory,
]

function scaffold(dir: string, taskId: string): void {
  for (const d of SCAFFOLD_DIRS) mkdirSync(join(dir, d), { recursive: true })
  const projectFile = join(dir, PATHS.project)
  if (!existsSync(projectFile)) {
    writeFileSync(
      projectFile,
      JSON.stringify(
        {
          id: taskId,
          name: `GAIA ${taskId}`,
          description: 'GAIA benchmark run (headless)',
          questions: [],
          userCorrections: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Append the prompt + answer to `.research-pilot/sessions/<taskId>.jsonl` in the
 * ChatMessage shape the renderer persists. Message persistence is normally
 * renderer-driven (chat-store → `session:save-message`); a headless run bypasses
 * it, so without this the app's chat panel would be empty when you reopen the
 * folder. Provenance (traces) is unaffected either way.
 */
function writeChatTranscript(dir: string, taskId: string, prompt: string, answer: string): void {
  const file = join(dir, PATHS.sessions, `${taskId}.jsonl`)
  const ts = Date.now()
  const lines = [
    { id: randomUUID(), role: 'user', content: prompt, timestamp: ts },
    { id: randomUUID(), role: 'assistant', content: answer, timestamp: ts + 1 },
  ]
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// ─── Prompt construction (GAIA standard format instruction) ─────────────────
const GAIA_FORMAT = `When you have finished, report your answer on a new line in the exact form:
FINAL ANSWER: [YOUR ANSWER]
YOUR ANSWER should be a number OR as few words as possible OR a comma-separated list of numbers and/or strings.
If asked for a number, don't use commas as thousands separators and don't include units ($, %, etc.) unless specified.
If asked for a string, don't use articles or abbreviations (e.g. for cities) unless specified, and write digits in plain text unless specified.
If asked for a comma-separated list, apply the above rules to each element.`

function buildPrompt(task: GaiaTask): string {
  const parts = [task.Question.trim()]
  if (task.file_name) {
    parts.push(
      `\nAn attached file named "${task.file_name}" is available in your current project working directory (the project root). Read it directly to answer the question.`,
    )
  }
  parts.push('\n' + GAIA_FORMAT)
  return parts.join('\n')
}

// ─── Auth resolution (API key OR subscription OAuth) ────────────────────────
type AuthMode = 'api-key' | 'anthropic-subscription' | 'openai-codex'
interface AuthResult {
  apiKey: string
  authMode: AuthMode
  getApiKeyOverride?: () => Promise<string>
}

const CONFIG_DIR = join(homedir(), '.research-copilot')

interface OAuthCreds {
  access: string
  refresh: string
  expires: number
}

function readOAuthCreds(file: string): OAuthCreds {
  if (!existsSync(file)) {
    throw new Error(
      `Subscription credentials not found at ${file}. Sign in to the subscription in the app first ` +
        `(model selector → sign in), then retry.`,
    )
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as OAuthCreds
}

/**
 * Codex credentials — mirrors the app's loadCodexCredentials: prefer our own
 * store, else fall back to the Codex CLI's `~/.codex/auth.json` (different
 * shape: { tokens: { access_token, refresh_token, expires_at(s)? } }). This is
 * why a Codex CLI login works without anything in ~/.research-copilot/.
 */
function readCodexCreds(ownStore: string): OAuthCreds {
  if (existsSync(ownStore)) {
    try {
      const d = JSON.parse(readFileSync(ownStore, 'utf-8'))
      if (d.access && d.refresh) return d as OAuthCreds
    } catch {
      /* fall through to CLI store */
    }
  }
  const codexAuth = join(homedir(), '.codex', 'auth.json')
  if (existsSync(codexAuth)) {
    const d = JSON.parse(readFileSync(codexAuth, 'utf-8'))
    if (d.tokens?.access_token && d.tokens?.refresh_token) {
      return {
        access: d.tokens.access_token,
        refresh: d.tokens.refresh_token,
        expires: d.tokens.expires_at ? d.tokens.expires_at * 1000 : Date.now() + 3600_000,
      }
    }
  }
  throw new Error(
    `ChatGPT subscription credentials not found (checked ${ownStore} and ~/.codex/auth.json). ` +
      `Sign in to Codex in the app or via the Codex CLI first.`,
  )
}

/**
 * Resolve auth from the model id's provider prefix — mirrors the app's
 * resolveCoordinatorAuth (shared-electron/ipc-base.ts, which we can't import
 * because it pulls electron):
 *   anthropic-sub:<m>  → Claude subscription (OAuth + token refresh)
 *   openai-codex:<m>   → ChatGPT subscription (OAuth + token refresh)
 *   anthropic:<m>      → ANTHROPIC_API_KEY
 *   openai:<m> / other → OPENAI_API_KEY
 */
function resolveAuth(model: string): AuthResult {
  const provider = model.includes(':') ? model.slice(0, model.indexOf(':')) : ''

  if (provider === 'anthropic-sub') {
    const file = join(CONFIG_DIR, 'anthropic-sub-credentials.json')
    const creds = readOAuthCreds(file)
    const getApiKeyOverride = async () => {
      const c = readOAuthCreds(file)
      if (c.expires < Date.now() + 60_000) {
        try {
          const { refreshAnthropicToken } = await import('@mariozechner/pi-ai/oauth')
          const fresh = (await refreshAnthropicToken(c.refresh)) as OAuthCreds
          writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 })
          return fresh.access
        } catch {
          return c.access
        }
      }
      return c.access
    }
    return { apiKey: creds.access, authMode: 'anthropic-subscription', getApiKeyOverride }
  }

  if (provider === 'openai-codex') {
    const file = join(CONFIG_DIR, 'openai-codex-credentials.json')
    const creds = readCodexCreds(file)
    const getApiKeyOverride = async () => {
      const c = readCodexCreds(file)
      if (c.expires < Date.now() + 60_000) {
        try {
          const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth')
          const fresh = (await refreshOpenAICodexToken(c.refresh)) as OAuthCreds
          writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 })
          return fresh.access
        } catch {
          return c.access
        }
      }
      return c.access
    }
    return { apiKey: creds.access, authMode: 'openai-codex', getApiKeyOverride }
  }

  // API-key path. Mirror the app: config (~/.research-copilot/config.json) wins over shell env.
  const configFile = join(CONFIG_DIR, 'config.json')
  if (existsSync(configFile)) {
    try {
      const cfg = JSON.parse(readFileSync(configFile, 'utf-8')) as { apiKeys?: Record<string, string> }
      applyApiKeysToEnv(cfg.apiKeys, process.env)
    } catch {
      /* malformed config — fall through to env */
    }
  }
  const isAnthropic = /^anthropic:|claude/i.test(model)
  const isOpenAI = /^openai:|gpt/i.test(model)
  const key = isAnthropic
    ? process.env.ANTHROPIC_API_KEY
    : isOpenAI
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error(
      `No API key for model "${model}". Save one in the app (Settings → API Keys), ` +
        `export ANTHROPIC_API_KEY / OPENAI_API_KEY, or use a subscription prefix ` +
        `(anthropic-sub: / openai-codex:).`,
    )
  }
  return { apiKey: key, authMode: 'api-key' }
}

// ─── Run one task ────────────────────────────────────────────────────────────
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'app', 'package.json'), 'utf-8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

interface RunResult {
  task_id: string
  level: string
  question: string
  file_name: string | null
  answer: string | null
  ground_truth: string | null
  annotator_steps: unknown
  ok: boolean
  error?: string
  elapsed_ms: number
  dir: string
}

async function runTask(task: GaiaTask, a: Args, auth: AuthResult): Promise<RunResult> {
  const dir = join(a.out, task.task_id)
  scaffold(dir, task.task_id)

  // Copy the attachment (if any) into the project root so the agent's
  // read/bash/find tools can reach it.
  if (task.file_name && task.file_path) {
    const src = join(a.gaia, task.file_path)
    if (existsSync(src)) copyFileSync(src, join(dir, task.file_name))
    else console.warn(`  [warn] attachment missing: ${src}`)
  }

  const base: RunResult = {
    task_id: task.task_id,
    level: String(task.Level),
    question: task.Question,
    file_name: task.file_name,
    answer: null,
    ground_truth: task['Final answer'] ?? null,
    annotator_steps: (task['Annotator Metadata'] as { Steps?: unknown })?.Steps ?? null,
    ok: false,
    elapsed_ms: 0,
    dir,
  }

  // Tracer constructed directly → provenance always on, no app gate.
  const tracer = new PipilotTracer({
    projectPath: dir,
    serviceVersion: APP_VERSION,
    appBuildCommit: process.env.RESEARCH_COPILOT_BUILD_COMMIT ?? 'bench',
    projectId: task.task_id,
    sessionId: task.task_id,
  })

  const t0 = Date.now()
  try {
    const coordinator = await createCoordinator({
      apiKey: auth.apiKey,
      ...(auth.getApiKeyOverride && { getApiKeyOverride: auth.getApiKeyOverride }),
      authMode: auth.authMode,
      model: a.model,
      projectPath: dir,
      sessionId: task.task_id,
      reasoningEffort: a.reasoning,
      tracer,
    })
    try {
      const prompt = buildPrompt(task)
      const res = await coordinator.chat(prompt)
      base.elapsed_ms = Date.now() - t0
      if (res.success) {
        base.ok = true
        base.answer = res.response ?? ''
        // Persist the Q+A so the app's chat panel renders it on reopen.
        writeChatTranscript(dir, task.task_id, prompt, base.answer)
      } else {
        base.error = res.error
      }
    } finally {
      await coordinator.destroy().catch(() => {})
    }
  } catch (err) {
    base.elapsed_ms = Date.now() - t0
    base.error = err instanceof Error ? err.message : String(err)
  } finally {
    await tracer.shutdown().catch(() => {})
  }

  writeFileSync(join(dir, 'result.json'), JSON.stringify(base, null, 2))
  return base
}

// ─── Simple concurrency pool ─────────────────────────────────────────────────
async function runPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker))
  return results
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.model) {
    console.error('Missing --model. Example:\n  node --import tsx scripts/bench-gaia.ts --model anthropic:claude-opus-4-8')
    process.exit(1)
  }

  const all = loadTasks(a.gaia, a.split)
  const selected = selectTasks(all, a)
  a.out = resolveOutDir(a, selected.length)

  console.log(`GAIA ${a.split}: ${all.length} tasks total, ${selected.length} selected`)
  console.log(`model=${a.model} reasoning=${a.reasoning} concurrency=${a.concurrency}`)
  console.log(`out=${a.out}`)
  for (const t of selected) {
    const q = t.Question.replace(/\s+/g, ' ').trim()
    const preview = q.length > 110 ? q.slice(0, 110) + '…' : q
    console.log(`  L${t.Level} ${t.task_id}${t.file_name ? ` [file: ${t.file_name}]` : ''}`)
    console.log(`       ${preview}`)
  }

  if (a.dryRun) {
    console.log('\n--dry-run: selection only, no LLM calls, nothing written.')
    return
  }

  const auth = resolveAuth(a.model)
  console.log(`auth=${auth.authMode}`)
  mkdirSync(a.out, { recursive: true })

  let done = 0
  const results = await runPool(selected, a.concurrency, async (task) => {
    const r = await runTask(task, a, auth)
    done++
    const status = r.ok ? 'ok' : `FAIL (${r.error?.slice(0, 80)})`
    console.log(`[${done}/${selected.length}] L${r.level} ${r.task_id}: ${status}  ${(r.elapsed_ms / 1000).toFixed(1)}s`)
    return r
  })

  // Summary index.
  const index = {
    benchmark: 'GAIA',
    split: a.split,
    model: a.model,
    reasoning: a.reasoning,
    ranAt: new Date().toISOString(),
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    tasks: results.map((r) => ({
      task_id: r.task_id,
      level: r.level,
      ok: r.ok,
      elapsed_ms: r.elapsed_ms,
      result: join(r.task_id, 'result.json'),
      provenance: join(r.task_id, '.research-pilot', 'traces'),
    })),
  }
  writeFileSync(join(a.out, 'index.json'), JSON.stringify(index, null, 2))
  console.log(`\nDone. ${index.ok}/${index.total} ok. Summary: ${join(a.out, 'index.json')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
