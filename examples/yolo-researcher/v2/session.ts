import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { FailureStore } from './failure-store.js'
import { ProjectStore } from './project-store.js'
import { LocalShellToolRunner } from './tool-runner.js'
import type {
  AtomicAction,
  CreateYoloSessionConfig,
  EditAction,
  ExecAction,
  FailureEntry,
  ProjectUpdate,
  RecentTurnContext,
  TurnContext,
  TurnDecision,
  TurnExecutionResult,
  TurnStatus
} from './types.js'
import {
  ensureDir,
  fileExists,
  firstNonEmptyLine,
  formatTurnId,
  listTurnNumbers,
  normalizeText,
  readTextOrEmpty,
  toPosixPath,
  writeText
} from './utils.js'

const DEFAULT_RUNTIME = 'host'
const DEFAULT_RECENT_TURNS_TO_LOAD = 3

const DETERMINISTIC_ERROR_PATTERNS = [
  /modulenotfound/i,
  /module.?not.?found/i,
  /module\s*not\s*found/i,
  /no such file/i,
  /cannot find/i,
  /not found/i,
  /permission denied/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /read-only file system/i,
  /address already in use/i
]

function isDeterministicFailure(errorLine: string): boolean {
  if (!errorLine.trim()) return false
  return DETERMINISTIC_ERROR_PATTERNS.some((pattern) => pattern.test(errorLine))
}

function buildFailureFingerprint(cmd: string, errorLine: string, runtime: string): string {
  return `${normalizeText(cmd)}|${normalizeText(errorLine)}|${normalizeText(runtime)}`
}

function buildSimplePatch(filePath: string, previousContent: string, nextContent: string): string {
  const safePath = toPosixPath(filePath)
  const previous = previousContent.endsWith('\n') ? previousContent : `${previousContent}\n`
  const next = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`

  return [
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    '@@',
    ...previous.split(/\r?\n/).filter((line) => line.length > 0).map((line) => `-${line}`),
    ...next.split(/\r?\n/).filter((line) => line.length > 0).map((line) => `+${line}`),
    ''
  ].join('\n')
}

function summarizeRecentAction(rawActionMd: string): string {
  const line = rawActionMd
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('- Key observation:') || value.startsWith('- Next:') || value.startsWith('- Status:'))
  if (!line) return 'No summary line found.'
  return line.replace(/^-\s+/, '').trim()
}

export class YoloSession {
  readonly yoloRoot: string
  readonly runsDir: string
  readonly projectFilePath: string
  readonly failuresFilePath: string

  private readonly projectStore: ProjectStore
  private readonly failureStore: FailureStore
  private readonly now: () => Date
  private initialized = false

  constructor(private readonly config: CreateYoloSessionConfig) {
    this.now = config.now ?? (() => new Date())
    this.yoloRoot = path.join(config.projectPath, 'yolo', config.projectId)
    this.runsDir = path.join(this.yoloRoot, 'runs')

    const fallbackRuntime = config.defaultRuntime?.trim() || DEFAULT_RUNTIME
    this.projectStore = new ProjectStore(this.yoloRoot, config.goal, config.successCriteria ?? [], fallbackRuntime)
    this.failureStore = new FailureStore(this.yoloRoot, this.now)

    this.projectFilePath = this.projectStore.filePath
    this.failuresFilePath = this.failureStore.filePath
  }

  async init(): Promise<void> {
    if (this.initialized) return

    await ensureDir(this.yoloRoot)
    await ensureDir(this.runsDir)
    await this.projectStore.init()
    await this.failureStore.init()

    this.initialized = true
  }

  async runNextTurn(): Promise<TurnExecutionResult> {
    await this.init()

    const project = await this.projectStore.load()
    const failures = await this.failureStore.load()
    const turnNumber = await this.computeNextTurnNumber()
    const turnId = formatTurnId(turnNumber)
    const turnDir = path.join(this.runsDir, turnId)
    const artifactsDir = path.join(turnDir, 'artifacts')

    await ensureDir(turnDir)
    await ensureDir(artifactsDir)

    const context: TurnContext = {
      turnNumber,
      projectRoot: this.config.projectPath,
      yoloRoot: this.yoloRoot,
      runsDir: this.runsDir,
      project,
      failures,
      recentTurns: await this.loadRecentTurns(this.config.recentTurnsToLoad ?? DEFAULT_RECENT_TURNS_TO_LOAD)
    }

    const decision = await this.config.agent.decide(context)
    this.validateDecision(decision)

    const execution = await this.executeAtomicAction({
      turnNumber,
      turnDir,
      artifactsDir,
      decision,
      context
    })

    const updateSummaryLines = [...execution.updateSummary]
    let projectUpdated = false

    if (decision.projectUpdate) {
      await this.projectStore.applyUpdate(decision.projectUpdate)
      projectUpdated = true
      updateSummaryLines.push('PROJECT.md: applied structured update from decision.')
    }

    if (execution.autoProjectUpdate) {
      await this.projectStore.applyUpdate(execution.autoProjectUpdate)
      projectUpdated = true
      updateSummaryLines.push('PROJECT.md: applied runtime-generated evidence pointers.')
    }

    if (projectUpdated) {
      const panel = await this.projectStore.load()
      updateSummaryLines.push(`PROJECT.md: plan=${panel.currentPlan.length}, facts=${panel.facts.length}, artifacts=${panel.keyArtifacts.length}`)
    }

    if (execution.failureEntry) {
      updateSummaryLines.push(`FAILURES.md: ${execution.failureEntry.status} recorded for fingerprint ${execution.failureEntry.fingerprint}`)
    }

    if (execution.blockedBy) {
      updateSummaryLines.push(`FAILURES.md: blocked by ${execution.blockedBy.fingerprint}`)
    }

    const boundedUpdates = updateSummaryLines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)

    await writeText(path.join(turnDir, 'action.md'), this.renderActionMarkdown({
      turnNumber,
      decision,
      status: execution.status,
      keyObservation: execution.keyObservation,
      evidencePaths: execution.evidencePaths,
      updateSummary: boundedUpdates
    }))

    return {
      turnNumber,
      turnDir,
      status: execution.status,
      intent: decision.intent,
      action: decision.action,
      summary: execution.keyObservation,
      evidencePaths: execution.evidencePaths,
      blockedBy: execution.blockedBy ?? undefined
    }
  }

  async runUntilStop(maxTurns: number): Promise<TurnExecutionResult[]> {
    const results: TurnExecutionResult[] = []
    for (let idx = 0; idx < maxTurns; idx += 1) {
      const result = await this.runNextTurn()
      results.push(result)
      if (result.status === 'stopped' || result.status === 'ask_user') {
        break
      }
    }
    return results
  }

  async getRecentTurns(limit: number = DEFAULT_RECENT_TURNS_TO_LOAD): Promise<RecentTurnContext[]> {
    await this.init()
    return this.loadRecentTurns(limit)
  }

  async getProjectMarkdown(): Promise<string> {
    await this.init()
    return readTextOrEmpty(this.projectFilePath)
  }

  async getFailuresMarkdown(): Promise<string> {
    await this.init()
    return readTextOrEmpty(this.failuresFilePath)
  }

  private async computeNextTurnNumber(): Promise<number> {
    const numbers = await listTurnNumbers(this.runsDir)
    return (numbers[numbers.length - 1] ?? 0) + 1
  }

  private async loadRecentTurns(limit: number): Promise<RecentTurnContext[]> {
    const numbers = await listTurnNumbers(this.runsDir)
    const selected = numbers.slice(-Math.max(0, limit)).reverse()

    const contexts: RecentTurnContext[] = []
    for (const number of selected) {
      const actionPath = path.join(this.runsDir, formatTurnId(number), 'action.md')
      const raw = await readTextOrEmpty(actionPath)
      if (!raw.trim()) continue
      contexts.push({
        turnNumber: number,
        actionPath: toPosixPath(path.relative(this.yoloRoot, actionPath)),
        summary: summarizeRecentAction(raw)
      })
    }
    return contexts
  }

  private validateDecision(decision: TurnDecision): void {
    if (!decision.intent?.trim()) {
      throw new Error('TurnDecision.intent is required')
    }
    if (!decision.action?.kind) {
      throw new Error('TurnDecision.action.kind is required')
    }

    const action = decision.action as Record<string, unknown>
    const requireNonEmpty = (field: string): string => {
      const value = action[field]
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${decision.action.kind} action.${field} is required`)
      }
      return value
    }

    switch (decision.action.kind) {
      case 'Exec':
        requireNonEmpty('cmd')
        break
      case 'Read':
      case 'Write':
      case 'Edit':
        requireNonEmpty('targetPath')
        break
      case 'Ask':
        requireNonEmpty('question')
        break
      case 'Stop':
        requireNonEmpty('reason')
        break
      default:
        break
    }
  }

  private ensureSafeTargetPath(inputPath: string): string {
    const resolved = path.resolve(this.config.projectPath, inputPath)
    const projectRoot = path.resolve(this.config.projectPath)
    if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`targetPath escapes project root: ${inputPath}`)
    }
    return resolved
  }

  private toEvidencePath(absPath: string): string {
    return toPosixPath(path.relative(this.yoloRoot, absPath))
  }

  private async executeAtomicAction(input: {
    turnNumber: number
    turnDir: string
    artifactsDir: string
    decision: TurnDecision
    context: TurnContext
  }): Promise<{
      status: TurnStatus
      keyObservation: string
      evidencePaths: string[]
      failureEntry: FailureEntry | null
      blockedBy: FailureEntry | null
      autoProjectUpdate: ProjectUpdate | null
      updateSummary: string[]
    }> {
    const action = input.decision.action
    switch (action.kind) {
      case 'Exec':
        return this.executeExecAction(input.turnDir, action)
      case 'Read':
        return this.executeReadAction(input.turnDir, action)
      case 'Write':
        return this.executeWriteAction(input.turnDir, action)
      case 'Edit':
        return this.executeEditAction(input.turnDir, action)
      case 'Ask':
        return this.executeAskAction(input.artifactsDir, action)
      case 'Stop':
        return {
          status: 'stopped',
          keyObservation: action.reason,
          evidencePaths: [],
          failureEntry: null,
          blockedBy: null,
          autoProjectUpdate: {
            currentPlan: ['Stop requested. Awaiting new goal or constraints.']
          },
          updateSummary: ['Next: stopped by agent decision.']
        }
      default:
        throw new Error(`Unsupported atomic action: ${(action as AtomicAction).kind}`)
    }
  }

  private async executeExecAction(turnDir: string, action: ExecAction): Promise<{
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    failureEntry: FailureEntry | null
    blockedBy: FailureEntry | null
    autoProjectUpdate: ProjectUpdate | null
    updateSummary: string[]
  }> {
    const runtime = action.runtime?.trim() || (await this.projectStore.load()).defaultRuntime || this.config.defaultRuntime || DEFAULT_RUNTIME
    const cwd = action.cwd ? this.ensureSafeTargetPath(action.cwd) : this.config.projectPath

    const cmdPath = path.join(turnDir, 'cmd.txt')
    const stdoutPath = path.join(turnDir, 'stdout.txt')
    const stderrPath = path.join(turnDir, 'stderr.txt')
    const exitCodePath = path.join(turnDir, 'exit_code.txt')

    await writeText(cmdPath, `${action.cmd}\n`)

    const blockedBy = await this.failureStore.findBlocked(action.cmd, runtime)
    if (blockedBy && !action.blockedOverrideReason?.trim()) {
      const message = [
        `Blocked command rejected by circuit breaker.`,
        `fingerprint: ${blockedBy.fingerprint}`,
        `reason: ${blockedBy.errorLine}`,
        `evidence: ${blockedBy.evidencePath}`,
        `hint: provide blockedOverrideReason and run minimal verification after remediation.`,
        ''
      ].join('\n')

      await writeText(stdoutPath, '')
      await writeText(stderrPath, message)
      await writeText(exitCodePath, '-1\n')

      return {
        status: 'blocked',
        keyObservation: `Command blocked: ${blockedBy.errorLine}`,
        evidencePaths: [
          this.toEvidencePath(cmdPath),
          this.toEvidencePath(stderrPath),
          this.toEvidencePath(exitCodePath)
        ],
        failureEntry: null,
        blockedBy,
        autoProjectUpdate: {
          keyArtifacts: [this.toEvidencePath(stderrPath)]
        },
        updateSummary: ['Next: switch runtime, fix dependency/permission, or ask user.']
      }
    }

    const runner = this.config.toolRunner ?? new LocalShellToolRunner()
    const outcome = await runner.runExec({
      cmd: action.cmd,
      runtime,
      cwd,
      timeoutMs: action.timeoutMs,
      env: action.env
    })

    await writeText(stdoutPath, outcome.stdout)
    await writeText(stderrPath, outcome.stderr)
    await writeText(exitCodePath, `${outcome.exitCode}\n`)

    const cmdEvidence = this.toEvidencePath(cmdPath)
    const stdoutEvidence = this.toEvidencePath(stdoutPath)
    const stderrEvidence = this.toEvidencePath(stderrPath)
    const exitEvidence = this.toEvidencePath(exitCodePath)

    const baseUpdate: ProjectUpdate = {
      keyArtifacts: [cmdEvidence, stdoutEvidence, stderrEvidence, exitEvidence]
    }

    if (outcome.exitCode === 0) {
      if (action.blockedOverrideReason?.trim()) {
        await this.failureStore.clearBlockedAfterVerifiedSuccess({
          cmd: action.cmd,
          runtime,
          evidencePath: stdoutEvidence
        })
      }

      return {
        status: 'success',
        keyObservation: 'Command executed successfully.',
        evidencePaths: [cmdEvidence, stdoutEvidence, stderrEvidence, exitEvidence],
        failureEntry: null,
        blockedBy: null,
        autoProjectUpdate: baseUpdate,
        updateSummary: ['Next: promote verified outputs to Facts/Constraints with evidence pointers.']
      }
    }

    const errorLine = firstNonEmptyLine(outcome.stderr, outcome.stdout) || `exit code ${outcome.exitCode}`
    let failureEntry: FailureEntry | null = null

    if (isDeterministicFailure(errorLine)) {
      const fingerprint = buildFailureFingerprint(action.cmd, errorLine, runtime)
      failureEntry = await this.failureStore.recordDeterministicFailure({
        cmd: action.cmd,
        runtime,
        fingerprint,
        errorLine,
        evidencePath: stderrEvidence,
        alternatives: action.alternatives ?? []
      })
    }

    return {
      status: 'failure',
      keyObservation: `Command failed: ${errorLine}`,
      evidencePaths: [cmdEvidence, stdoutEvidence, stderrEvidence, exitEvidence],
      failureEntry,
      blockedBy: null,
      autoProjectUpdate: baseUpdate,
      updateSummary: failureEntry
        ? [`Next: avoid retry path until remediation; status=${failureEntry.status}.`]
        : ['Next: classify failure and design a minimal verification action.']
    }
  }

  private async executeReadAction(turnDir: string, action: { targetPath: string }): Promise<{
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    failureEntry: FailureEntry | null
    blockedBy: FailureEntry | null
    autoProjectUpdate: ProjectUpdate | null
    updateSummary: string[]
  }> {
    const targetPath = this.ensureSafeTargetPath(action.targetPath)
    const cmdPath = path.join(turnDir, 'cmd.txt')
    const stdoutPath = path.join(turnDir, 'stdout.txt')
    const stderrPath = path.join(turnDir, 'stderr.txt')
    const exitCodePath = path.join(turnDir, 'exit_code.txt')

    await writeText(cmdPath, `read ${action.targetPath}\n`)

    if (!(await fileExists(targetPath))) {
      const message = `No such file: ${action.targetPath}\n`
      await writeText(stdoutPath, '')
      await writeText(stderrPath, message)
      await writeText(exitCodePath, '1\n')

      return {
        status: 'failure',
        keyObservation: message.trim(),
        evidencePaths: [
          this.toEvidencePath(cmdPath),
          this.toEvidencePath(stderrPath),
          this.toEvidencePath(exitCodePath)
        ],
        failureEntry: null,
        blockedBy: null,
        autoProjectUpdate: {
          keyArtifacts: [this.toEvidencePath(stderrPath)]
        },
        updateSummary: ['Next: verify file path or switch to Ask action for missing artifacts.']
      }
    }

    const content = await fs.readFile(targetPath, 'utf-8')
    await writeText(stdoutPath, content)
    await writeText(stderrPath, '')
    await writeText(exitCodePath, '0\n')

    const stdoutEvidence = this.toEvidencePath(stdoutPath)

    return {
      status: 'success',
      keyObservation: `Read succeeded: ${action.targetPath}`,
      evidencePaths: [
        this.toEvidencePath(cmdPath),
        stdoutEvidence,
        this.toEvidencePath(stderrPath),
        this.toEvidencePath(exitCodePath)
      ],
      failureEntry: null,
      blockedBy: null,
      autoProjectUpdate: {
        keyArtifacts: [stdoutEvidence]
      },
      updateSummary: ['Next: promote only evidence-backed conclusions.']
    }
  }

  private async executeWriteAction(turnDir: string, action: { targetPath: string; content: string }): Promise<{
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    failureEntry: FailureEntry | null
    blockedBy: FailureEntry | null
    autoProjectUpdate: ProjectUpdate | null
    updateSummary: string[]
  }> {
    const targetPath = this.ensureSafeTargetPath(action.targetPath)
    await ensureDir(path.dirname(targetPath))
    await fs.writeFile(targetPath, action.content, 'utf-8')

    const recordPath = path.join(turnDir, 'artifacts', 'write-target.txt')
    await writeText(recordPath, `${toPosixPath(path.relative(this.config.projectPath, targetPath))}\n`)

    const evidence = this.toEvidencePath(recordPath)

    return {
      status: 'success',
      keyObservation: `Write succeeded: ${action.targetPath}`,
      evidencePaths: [evidence],
      failureEntry: null,
      blockedBy: null,
      autoProjectUpdate: {
        keyArtifacts: [evidence]
      },
      updateSummary: ['Next: verify written content with a Read or Exec action.']
    }
  }

  private async executeEditAction(turnDir: string, action: EditAction): Promise<{
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    failureEntry: FailureEntry | null
    blockedBy: FailureEntry | null
    autoProjectUpdate: ProjectUpdate | null
    updateSummary: string[]
  }> {
    const targetPath = this.ensureSafeTargetPath(action.targetPath)
    const previousContent = await readTextOrEmpty(targetPath)

    await ensureDir(path.dirname(targetPath))
    await fs.writeFile(targetPath, action.newContent, 'utf-8')

    const patchPath = path.join(turnDir, 'patch.diff')
    const relativeTarget = toPosixPath(path.relative(this.config.projectPath, targetPath))
    await writeText(patchPath, buildSimplePatch(relativeTarget, previousContent, action.newContent))

    const evidence = this.toEvidencePath(patchPath)

    return {
      status: 'success',
      keyObservation: `Edit succeeded: ${action.targetPath}`,
      evidencePaths: [evidence],
      failureEntry: null,
      blockedBy: null,
      autoProjectUpdate: {
        keyArtifacts: [evidence]
      },
      updateSummary: ['Next: run minimal validation to confirm patch impact.']
    }
  }

  private async executeAskAction(artifactsDir: string, action: { question: string }): Promise<{
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    failureEntry: FailureEntry | null
    blockedBy: FailureEntry | null
    autoProjectUpdate: ProjectUpdate | null
    updateSummary: string[]
  }> {
    const askPath = path.join(artifactsDir, 'ask-user.md')
    await writeText(askPath, `# Blocking Question\n\n${action.question.trim()}\n`)
    const evidence = this.toEvidencePath(askPath)

    return {
      status: 'ask_user',
      keyObservation: 'User input required to proceed.',
      evidencePaths: [evidence],
      failureEntry: null,
      blockedBy: null,
      autoProjectUpdate: {
        keyArtifacts: [evidence]
      },
      updateSummary: ['Next: wait for user response before next turn.']
    }
  }

  private renderActionMarkdown(input: {
    turnNumber: number
    decision: TurnDecision
    status: TurnStatus
    keyObservation: string
    evidencePaths: string[]
    updateSummary: string[]
  }): string {
    const action = input.decision.action
    const actionLine = this.describeAction(action)

    const updateLines = input.updateSummary.length > 0
      ? input.updateSummary.map((line) => `- ${line}`)
      : ['- Next: continue with one atomic action.']

    return [
      `# Turn ${formatTurnId(input.turnNumber)}`,
      '',
      '## Intent',
      `- Why this action: ${input.decision.intent.trim()}`,
      `- Expected outcome: ${(input.decision.expectedOutcome?.trim() || 'Generate evidence for the next decision.')}`,
      '',
      '## Action',
      `- Tool: ${action.kind}`,
      `- Command or target: ${actionLine}`,
      '',
      '## Result',
      `- Status: ${input.status}`,
      `- Key observation: ${input.keyObservation}`,
      `- Evidence: ${input.evidencePaths.length > 0 ? input.evidencePaths.join(', ') : 'none'}`,
      '',
      '## Update (<=5 lines, pointers only)',
      ...updateLines,
      ''
    ].join('\n')
  }

  private describeAction(action: AtomicAction): string {
    switch (action.kind) {
      case 'Exec':
        return action.cmd
      case 'Read':
        return action.targetPath
      case 'Write':
        return action.targetPath
      case 'Edit':
        return action.targetPath
      case 'Ask':
        return action.question
      case 'Stop':
        return action.reason
      default:
        return 'unknown'
    }
  }
}

export function createYoloSession(config: CreateYoloSessionConfig): YoloSession {
  return new YoloSession(config)
}
