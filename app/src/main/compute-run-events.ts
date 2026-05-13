import fs from 'fs'
import { ComputeRunner } from '../../../lib/local-compute/runner'
import type { RunRecord, RunStatusResult } from '../../../lib/local-compute/types'
import { extractProgress } from '../../../lib/local-compute/progress'
import { ModalRunStore } from '../../../lib/modal-compute/modal-run-store'
import { computeElapsedCost } from '../../../lib/modal-compute/cost-estimator'
import { type ModalRunRecord, isModalTerminal } from '../../../lib/modal-compute/types'

const OUTPUT_TAIL_BYTES = 8_192
const UI_OUTPUT_TAIL_CHARS = 2_048

function readFileTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size === 0) return ''
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf-8')
  } catch {
    return ''
  }
}

function elapsedSeconds(startedAt?: string, completedAt?: string): number {
  if (!startedAt) return 0
  const start = new Date(startedAt).getTime()
  if (!Number.isFinite(start)) return 0
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  if (!Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / 1000))
}

function compact(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined))
}

export function formatLocalRunEvent(data: any, args?: any): Record<string, unknown> {
  const event = {
    runId: data.run_id,
    status: data.status,
    currentPhase: data.current_phase,
    command: data.command ?? args?.command,
    sandbox: data.sandbox,
    weight: data.weight,
    startedAt: data.started_at,
    target: 'local',
    exitCode: data.exit_code,
    elapsedSeconds: data.elapsed_seconds,
    outputBytes: data.output_bytes,
    outputLines: data.output_lines,
    stalled: data.stalled,
    progress: data.progress,
    outputTail: data.output_tail?.slice(-UI_OUTPUT_TAIL_CHARS),
    failure: data.failure,
    parentRunId: data.parent_run_id,
  }
  return compact(event)
}

export function formatModalRunEvent(data: any, args?: any): Record<string, unknown> {
  const event = {
    runId: data.run_id,
    planId: data.plan_id,
    taskDescription: data.task_description,
    status: data.status,
    currentPhase: data.current_phase ?? 'modal',
    command: data.command ?? args?.command,
    scriptPath: data.script_path,
    image: data.image,
    costEstimate: data.cost_estimate,
    costThresholdUsd: data.cost_threshold_usd,
    sandbox: 'modal',
    weight: 'heavy',
    startedAt: data.started_at ?? new Date().toISOString(),
    target: 'modal',
    exitCode: data.exit_code,
    elapsedSeconds: data.elapsed_seconds,
    outputBytes: data.output_bytes,
    outputLines: data.output_lines,
    lastOutputAt: data.last_output_at,
    timeoutMs: data.timeout_ms,
    stallThresholdMs: data.stall_threshold_ms,
    stalled: data.stalled,
    progress: data.progress,
    outputTail: data.output_tail?.slice(-UI_OUTPUT_TAIL_CHARS),
    failure: data.failure,
    parentRunId: data.parent_run_id,
    estimatedCostUsd: data.estimated_cost_usd,
  }
  return compact(event)
}

function localRecordToToolData(record: RunRecord, status: RunStatusResult | undefined): Record<string, unknown> {
  return {
    run_id: record.runId,
    status: status?.status ?? record.status,
    current_phase: status?.currentPhase ?? record.currentPhase,
    command: record.command,
    sandbox: record.sandbox,
    weight: record.weight,
    started_at: record.startedAt,
    exit_code: status?.exitCode ?? record.exitCode,
    elapsed_seconds: elapsedSeconds(record.startedAt, record.completedAt),
    output_bytes: status?.outputBytes ?? record.outputBytes,
    output_lines: status?.outputLines ?? record.outputLines,
    stalled: status?.stalled ?? record.stalled,
    progress: status?.progress,
    output_tail: status?.outputTail ?? readFileTail(record.outputPath, OUTPUT_TAIL_BYTES),
    failure: status?.failure,
    parent_run_id: record.parentRunId,
  }
}

function modalFailure(run: ModalRunRecord): Record<string, unknown> | undefined {
  if (!isModalTerminal(run.status) || run.status === 'completed') return undefined
  return {
    code: run.status === 'timed_out' ? 'TIMEOUT' : 'COMMAND_FAILED',
    retryable: run.status !== 'cancelled',
    message: run.error ?? `Modal run ended with status ${run.status}.`,
    suggestions: ['Inspect the output tail and Modal script, then retry after fixing the issue.'],
  }
}

function modalCostSoFar(run: ModalRunRecord): number | undefined {
  if (isModalTerminal(run.status) && run.estimatedCostSoFar !== undefined) return run.estimatedCostSoFar
  if (run.startedAt) return computeElapsedCost(run.startedAt, run.costEstimate.gpuRateUsdPerHour)
  return run.estimatedCostSoFar
}

function modalRecordToToolData(run: ModalRunRecord, costThresholdUsd: number): Record<string, unknown> {
  const outputTail = readFileTail(run.outputPath, OUTPUT_TAIL_BYTES)
  return {
    run_id: run.runId,
    plan_id: run.planId,
    task_description: run.taskDescription,
    status: run.status,
    current_phase: 'modal',
    command: run.command,
    script_path: run.scriptPath,
    image: run.image,
    cost_estimate: run.costEstimate,
    cost_threshold_usd: costThresholdUsd,
    started_at: run.startedAt,
    exit_code: run.exitCode,
    elapsed_seconds: elapsedSeconds(run.startedAt, isModalTerminal(run.status) ? run.completedAt : undefined),
    output_bytes: run.outputBytes,
    output_lines: run.outputLines,
    last_output_at: run.lastOutputAt,
    timeout_ms: run.timeoutMs,
    stall_threshold_ms: run.stallThresholdMs,
    stalled: run.stalled,
    progress: extractProgress(outputTail),
    output_tail: outputTail,
    failure: modalFailure(run),
    parent_run_id: run.parentRunId,
    estimated_cost_usd: modalCostSoFar(run),
  }
}

export async function hydrateComputeRunEvents(opts: {
  projectPath: string
  costThresholdUsd: number
}): Promise<Record<string, unknown>[]> {
  if (!opts.projectPath) return []

  const events: Record<string, unknown>[] = []

  const localRunner = new ComputeRunner({
    projectPath: opts.projectPath,
    workspacePath: opts.projectPath,
  })
  try {
    for (const record of localRunner.getStore().getAllRuns()) {
      events.push(formatLocalRunEvent(localRecordToToolData(record, localRunner.getStatus(record.runId))))
    }
  } finally {
    await localRunner.destroy().catch(() => {})
  }

  const modalStore = new ModalRunStore(opts.projectPath)
  modalStore.evictOld()
  for (const record of modalStore.getAllRuns()) {
    events.push(formatModalRunEvent(modalRecordToToolData(record, opts.costThresholdUsd)))
  }
  modalStore.stopFlushTimer()

  return events.sort((a, b) => {
    const aTime = typeof a.startedAt === 'string' ? new Date(a.startedAt).getTime() : 0
    const bTime = typeof b.startedAt === 'string' ? new Date(b.startedAt).getTime() : 0
    return bTime - aTime
  })
}
