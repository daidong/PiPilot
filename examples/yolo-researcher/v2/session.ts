import * as path from 'node:path'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { FailureStore } from './failure-store.js'
import { ProjectStore } from './project-store.js'
import type {
  CreateYoloSessionConfig,
  DeliverableRequirement,
  EvidenceTrustHint,
  EvidenceLine,
  FailureEntry,
  NorthStarSemanticGateConfig,
  NorthStarSemanticGateInput,
  NorthStarSemanticGateMode,
  NorthStarSemanticGateOutput,
  NorthStarSemanticGateRequiredAction,
  PendingUserInput,
  PlanBoardItem,
  PlannerCheckpointInfo,
  ResolvedOrchestrationMode,
  ProjectUpdate,
  QueuedUserInput,
  RecentTurnContext,
  NorthStarContract,
  OrchestrationMode,
  StageStatus,
  StagnationInfo,
  ToolEventRecord,
  TurnContext,
  TurnExecutionResult,
  TurnRunOutcome,
  TurnStatus
} from './types.js'
import {
  ensureDir,
  fileExists,
  firstNonEmptyLine,
  formatTurnId,
  listTurnNumbers,
  normalizeText,
  parseArtifactUri,
  readTextOrEmpty,
  toIso,
  toPosixPath,
  writeText
} from './utils.js'
import {
  applyNativeTurnPlanDeltas as applyNativeTurnPlanDeltasHelper,
  applyNativeTurnProjectMutations as applyNativeTurnProjectMutationsHelper,
  applyNativeTurnStatusGuards as applyNativeTurnStatusGuardsHelper,
  applyOutcomeProjectUpdate as applyOutcomeProjectUpdateHelper,
  buildNativeTurnFilePaths as buildNativeTurnFilePathsHelper,
  buildNativeTurnResultPayload as buildNativeTurnResultPayloadHelper,
  executeNativeTurnOutcome as executeNativeTurnOutcomeHelper,
  prepareNativeTurnPlanProgress as prepareNativeTurnPlanProgressHelper,
  writeFinalTurnArtifacts as writeFinalTurnArtifactsHelper,
  writeProvisionalTurnArtifacts as writeProvisionalTurnArtifactsHelper
} from './session-native-turn.js'

const DEFAULT_RUNTIME = 'host'
const DEFAULT_RECENT_TURNS_TO_LOAD = 3
const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'artifact_gravity_v3_paper'
const NORTHSTAR_FILE_NAME = 'NORTHSTAR.md'
const NORTHSTAR_NO_DELTA_PIVOT_THRESHOLD = 2
const NORTHSTAR_REALITYCHECK_NO_EXEC_PIVOT_THRESHOLD = 2
const NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_DEFAULT = 3
const NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MIN = 1
const NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MAX = 20
const NORTHSTAR_DIRECTORY_DIGEST_LIMIT = 256
const NORTHSTAR_TRIVIAL_TEXT_DELTA_THRESHOLD = 20
const NORTHSTAR_NO_IMPROVEMENT_HARD_BLOCK_STREAK = 3
const NORTHSTAR_NON_MUST_ACTION_OVERDUE_GRACE_TURNS = 2
const NORTHSTAR_NON_MUST_ACTION_MAX_OPEN = 4
const NORTHSTAR_VERIFIED_GROWTH_MISSING_PROOF_REASON = 'northstar_verified_growth_missing_content_delta_proof'
const NORTHSTAR_REPEATED_NO_DELTA_BLOCK_REASON = 'northstar_repeated_no_delta_requires_pivot'
const NORTHSTAR_EXTERNAL_CHECK_TRIVIAL_DELTA_REASON = 'northstar_external_check_trivial_delta'
const NORTHSTAR_SCOPED_RUNS_RE = /^runs\/turn-(\d{4}|\*)\//i
const NORTHSTAR_CODELIKE_PATH_RE = /\.(patch|diff|py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|swift|cpp|cc|c|h|hpp|cs|rb|php|scala|sh|bash|zsh)$/i
const NORTHSTAR_PAPER_ARTIFACT_PATH_RE = /^artifacts\/[a-z0-9_./-]+$/i
const NORTHSTAR_SCOREBOARD_PATH_RE = /^artifacts\/[a-z0-9_./-]+\.json$/i
const NORTHSTAR_EXTERNAL_RESULT_ARTIFACT_RE = /(?:^|\/)(?:results?|smoke|evals?|benchmarks?)(?:\/|\.|_|-)/i
const NORTHSTAR_VOLATILE_JSON_KEY_RE = /(?:^|_)(?:timestamp|time|ts|date|created_at|updated_at|generated_at|started_at|finished_at|run_id|session_id|uuid)$/i
const NORTHSTAR_INTERNAL_CHECK_CMD_ALLOWLIST: RegExp[] = [
  /^python(?:3)?\s+scripts\/check_[a-z0-9_.-]+\.py(?:\s+.+)?$/i,
  /^uv\s+run\s+python(?:3)?\s+scripts\/check_[a-z0-9_.-]+\.py(?:\s+.+)?$/i,
  /^node\s+scripts\/check[-_][a-z0-9_.-]+\.m?js(?:\s+.+)?$/i,
  /^npm\s+run\s+check:[a-z0-9:_-]+(?:\s+--\s+.+)?$/i
]
const NORTHSTAR_EXTERNAL_CHECK_CMD_ALLOWLIST: RegExp[] = [
  /^python(?:3)?\s+scripts\/run_[a-z0-9_.-]+\.py(?:\s+.+)?$/i,
  /^python(?:3)?\s+experiments\/[a-z0-9_./-]+\.py(?:\s+.+)?$/i,
  /^uv\s+run\s+python(?:3)?\s+scripts\/run_[a-z0-9_.-]+\.py(?:\s+.+)?$/i,
  /^uv\s+run\s+python(?:3)?\s+experiments\/[a-z0-9_./-]+\.py(?:\s+.+)?$/i,
  /^python(?:3)?\s+-m\s+pytest(?:\s+.+)?$/i,
  /^uv\s+run\s+pytest(?:\s+.+)?$/i,
  /^node\s+scripts\/run[-_][a-z0-9_.-]+\.m?js(?:\s+.+)?$/i,
  /^npm\s+run\s+(?:exp|experiment|smoke|eval|bench):[a-z0-9:_-]+(?:\s+--\s+.+)?$/i
]
const NORTHSTAR_REALITYCHECK_CMD_DENY_RE = /(?:^|[\s])(curl|wget|git|rm|sudo|chmod|chown|apt|brew|pip(?:3)?\s+install|npm\s+install)(?:[\s]|$)|[;&|`]|(?:\$\()|(?:>>?)/i
const LITERATURE_BODY_LIMIT = 40_000
const LITERATURE_HOST_HINTS = [
  'arxiv.org',
  'api.semanticscholar.org',
  'semanticscholar.org',
  'openalex.org',
  'api.openalex.org',
  'doi.org',
  'crossref.org',
  'dblp.org',
  'pubmed.ncbi.nlm.nih.gov',
  'europepmc.org',
  'paperswithcode.com'
]
const REDUNDANCY_WINDOW_TURNS = 20
const CHECKPOINT_REASON_COOLDOWN_TURNS = 3
const MAX_BUSINESS_ARTIFACT_EVIDENCE_PATHS = 80
const SYSTEM_ARTIFACT_NAMES = new Set([
  'tool-events.jsonl',
  'agent-output.txt',
  'ask-user.md',
  'changed_files.json',
  'patch.diff'
])
const EVIDENCE_PATH_RE = /^runs\/turn-\d{4}\/.+/
const TURN_SCOPED_DELIVERABLE_RE = /^runs\/turn-(\d{4}|\*)\/(.+)$/i
const GOVERNANCE_CHECKPOINT_ARTIFACT_RE = /^runs\/turn-\d{4}\/artifacts\/planning_checkpoint_[^/]+\.md$/i
const ENV_ASSERTION_API_KEY_RE = /\b(api key|openai_api_key|anthropic_api_key|provider)\b/i
const ENV_ASSERTION_REPO_RE = /\b(git checkout|repo checkout|repository|git repo|not a git repository)\b/i
const ENV_ASSERTION_RESOURCE_RE = /\b(resource unavailable|policy[_ -]?denied|blocked by (a )?policy|network (is )?disabled|timed? out|timeout)\b/i
const ENV_ASSERTION_NEGATION_RE = /\b(no|not|missing|without|cannot|unable|blocked)\b/i
const ENV_PROOF_API_KEY_RE = /\b(api key|openai_api_key|anthropic_api_key|missing.*key|not set|not configured|unauthorized|401|authentication)\b/i
const ENV_PROOF_REPO_RE = /\b(not a git repository|no such file|pathspec|repository|git checkout|git status|\.git)\b/i
const ENV_PROOF_RESOURCE_RE = /\b(resource unavailable|policy[_ -]?denied|blocked by (a )?policy|timeout|timed out|network (is )?disabled)\b/i
const SEMANTIC_HARD_POLICY_RE = /\b(policy[_ -]?denied|blocked by (a )?policy|forbidden|disallowed|not allowed)\b/i
const SEMANTIC_HARD_PATH_RE = /\b(escapes project root|outside project root|path escape)\b/i
const TOOL_LAYER_FAILURE_RE = /\b(policy[_ -]?denied|blocked by (a )?policy|approval required|spawn|enoent|eacces|timeout|timed out|killed|signal|failed to execute|tool .* blocked)\b/i
const NO_OUTPUT_ASSERTION_RE = /\b(no|without|missing|none)\s+(stdout|stderr|output)\b/i
const NO_LOG_ASSERTION_RE = /\b(no|without|missing|none)\s+(logs?|log path)\b/i
const PLAN_ID_RE = /^P\d+$/i
const REPO_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.agentfoundry',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage'
])
const REPO_SCAN_MAX_DEPTH = 3
const REPO_SCAN_MAX_RESULTS = 12
const PATH_ANCHOR_SCAN_MAX_DEPTH = 8
const CODING_LARGE_REPO_CODE_EDIT_SCRIPTS = new Set(['agent-run-to-completion'])
const CODING_AGENT_STALL_MIN_POLLS = 2
const CODING_AGENT_STALL_MIN_WINDOW_MS = 90_000
const CODING_AGENT_TIMEOUT_RECONCILE_MAX_WAIT_MS = 90_000
const CODING_AGENT_TIMEOUT_RECONCILE_POLL_MS = 2_000
const DEFAULT_NORTHSTAR_SEMANTIC_GATE_MODE: NorthStarSemanticGateMode = 'enforce_downgrade_only'
const DEFAULT_NORTHSTAR_SEMANTIC_GATE_CONFIDENCE = 0.80
const DEFAULT_NORTHSTAR_SEMANTIC_GATE_MAX_INPUT_CHARS = 24_000
const DEFAULT_NORTHSTAR_SEMANTIC_REQUIRED_ACTION_BUDGET = 1
const DEFAULT_NORTHSTAR_SEMANTIC_MUST_MAX_OPEN = 1
const DEFAULT_NORTHSTAR_SEMANTIC_RECENT_WINDOW = 4
const MAX_TRUSTED_EVIDENCE_PATHS = 400
const MAX_UNTRUSTED_EVIDENCE_HINTS = 120
const NORTHSTAR_SEMANTIC_GATE_PROMPT_VERSION = 'nsg.v1'
const NORTHSTAR_SEMANTIC_GATE_TEMPERATURE = 0
const NORTHSTAR_SEMANTIC_REASON_LOW_CONFIDENCE = 'low_confidence'
const NORTHSTAR_SEMANTIC_REASON_INVALID_DIMENSION_SCORES = 'invalid_dimension_scores'
const NORTHSTAR_SEMANTIC_REASON_VERDICT_MISMATCH = 'verdict_mismatch'
const NORTHSTAR_SEMANTIC_REASON_INCONSISTENT_METRICS = 'inconsistent_metrics'
const NORTHSTAR_SEMANTIC_REASON_OBJECTIVE_CONTEXT_MISSING = 'objective_context_missing'
const NORTHSTAR_SEMANTIC_REASON_INVALID_CHANGE_PROOF_FLAGS = 'invalid_change_proof_flags'
const NORTHSTAR_SEMANTIC_REASON_MISSING_CONTENT_SNAPSHOT = 'missing_content_snapshot'

function isArtifactGravityMode(mode: OrchestrationMode | ResolvedOrchestrationMode | '' | null | undefined): boolean {
  return mode === 'artifact_gravity_v3_paper'
}

function isArtifactGravityPaperMode(mode: OrchestrationMode | ResolvedOrchestrationMode | '' | null | undefined): boolean {
  return mode === 'artifact_gravity_v3_paper'
}

const DELIVERABLE_PATTERNS: string[] = [
  'problem_statement',   // S1
  'literature_map',      // S2
  'idea_candidates',     // S3
  'experiment_plan',     // S4 (file)
  'exp-',                // S4 (directory prefix, e.g., exp-001/)
  'paper_draft',         // S5
  'outline',             // S5 (alias)
]

const DELIVERABLE_CHECKLIST: DeliverableRequirement[] = [
  { stage: 'S1', label: 'Problem Definition', patterns: ['problem_statement'] },
  { stage: 'S2', label: 'Literature',         patterns: ['literature_map'] },
  { stage: 'S3', label: 'Innovation',         patterns: ['idea_candidates'] },
  { stage: 'S4', label: 'Implementation',     patterns: ['experiment_plan', 'exp-'] },
  { stage: 'S5', label: 'Writing',            patterns: ['paper_draft', 'outline'] },
]

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

function summarizeRecentAction(rawActionMd: string): string {
  const line = rawActionMd
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('- Key observation:') || value.startsWith('- Next:') || value.startsWith('- Status:'))
  if (!line) return 'No summary line found.'
  return line.replace(/^-\s+/, '').trim()
}

function safeString(value: unknown, fallback: string = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizePlanId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toUpperCase()
  if (!trimmed) return ''
  if (PLAN_ID_RE.test(trimmed)) return trimmed
  const numeric = trimmed.replace(/[^0-9]/g, '')
  if (!numeric) return ''
  return `P${Number.parseInt(numeric, 10)}`
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function buildJsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function slugifyForFile(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item'
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function clipText(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars)
}

function canonicalizeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item))
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort((a, b) => a.localeCompare(b))) {
      next[key] = canonicalizeJson(row[key])
    }
    return next
  }
  return String(value)
}

const execFile = promisify(execFileCallback)

function isLikelyLiteratureUrl(rawUrl: string): boolean {
  const input = rawUrl.trim().toLowerCase()
  if (!input) return false

  try {
    const url = new URL(input)
    const host = url.hostname.toLowerCase()
    if (LITERATURE_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`))) {
      return true
    }
    const pathWithQuery = `${url.pathname}${url.search}`.toLowerCase()
    return /(paper|publication|arxiv|scholar|citation|doi|related[-_]work|survey|bibliograph|openalex|crossref)/.test(pathWithQuery)
  } catch {
    return /(arxiv|semantic|scholar|openalex|crossref|doi|dblp|pubmed|paper|citation|survey|literature)/.test(input)
  }
}

function extractLiteratureTitle(body: unknown): string {
  if (typeof body === 'string') {
    const head = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 5)
    return head ? head.slice(0, 180) : ''
  }

  const row = toPlainObject(body)
  if (row) {
    const direct = safeString(row.title).trim()
    if (direct) return direct.slice(0, 180)

    const nestedResults = Array.isArray(row.results) ? row.results : (Array.isArray(row.data) ? row.data : null)
    if (nestedResults) {
      for (const item of nestedResults) {
        const entry = toPlainObject(item)
        const title = safeString(entry?.title).trim()
        if (title) return title.slice(0, 180)
      }
    }
  }

  return ''
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function stageRank(stage: StageStatus['currentStage']): number {
  if (stage === 'S1') return 1
  if (stage === 'S2') return 2
  if (stage === 'S3') return 3
  if (stage === 'S4') return 4
  return 5
}

interface ParsedDoneDefinitionRules {
  deliverables: string[]
  evidenceMin: number
  invalidRows: string[]
}

interface PlanAttributionResult {
  activePlanId: string
  ambiguous: boolean
  reason: string
  deliverablesTouched: string[]
  coTouchedPlanIds: string[]
}

interface RecentTurnResultMeta {
  turnNumber: number
  status: string
  blockedReason: string
  plannerCheckpointReasons: string[]
  planBoardHash: string
  governanceOnlyTurn: boolean
}

type EnvConstraintCategory = 'api_key' | 'repo_checkout' | 'resource'

interface RuntimeVersionInfo {
  packageVersion: string
  gitCommit: string
  buildTime: string
  desktopVersion: string
  nodeVersion: string
}

type RuntimeFailureKind = 'tool_invocation_failure' | 'command_failure' | 'unknown_failure'

interface RuntimeFailureSnapshot {
  tool: string
  cmd: string
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  errorText: string
  errorExcerpt: string
  hasOutput: boolean
  failureKind: RuntimeFailureKind
  skillId?: string
  skillScript?: string
  skillArgs?: string[]
  toolTimeoutMs?: number | null
  sessionId?: string
  logPath?: string
  deliverable?: string
  structuredStatus?: string
}

interface CodingAgentSessionObservation {
  observed: boolean
  sessionIds: string[]
  startedSessionIds: string[]
  polledSessionIds: string[]
  loggedSessionIds: string[]
  runningSessionIds: string[]
  completedSessionIds: string[]
  failedSessionIds: string[]
  hasTerminal: boolean
  hasRunningOnly: boolean
  warmupLikely: boolean
  pollCount: number
  observationWindowMs: number
}

type NorthStarSemanticVerdict = 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain'
type NorthStarSemanticReasonCode =
  | typeof NORTHSTAR_SEMANTIC_REASON_LOW_CONFIDENCE
  | typeof NORTHSTAR_SEMANTIC_REASON_INVALID_DIMENSION_SCORES
  | typeof NORTHSTAR_SEMANTIC_REASON_VERDICT_MISMATCH
  | typeof NORTHSTAR_SEMANTIC_REASON_INCONSISTENT_METRICS
  | typeof NORTHSTAR_SEMANTIC_REASON_OBJECTIVE_CONTEXT_MISSING
  | typeof NORTHSTAR_SEMANTIC_REASON_INVALID_CHANGE_PROOF_FLAGS
  | typeof NORTHSTAR_SEMANTIC_REASON_MISSING_CONTENT_SNAPSHOT
  | string

interface ResolvedNorthStarSemanticGateConfig {
  enabled: boolean
  mode: NorthStarSemanticGateMode
  confidenceThreshold: number
  model: string
  maxInputChars: number
  allowUpgrade: boolean
  requiredActionBudgetPerTurn: number
  mustActionMaxOpen: number
  recentWindowTurns: number
}

interface NorthStarSemanticActionPromotionAudit {
  code: string
  source_tier: 'must_candidate' | 'should' | 'suggest'
  final_tier: 'must' | 'should' | 'suggest'
  deterministic_trigger_codes: string[]
  notes: string[]
}

interface NorthStarSemanticGateAuditRecord {
  enabled: boolean
  mode: NorthStarSemanticGateMode
  eligible: boolean
  invoked: boolean
  prompt_version: string
  model_id: string
  temperature: number
  input_hash: string
  output: NorthStarSemanticGateOutput | null
  accepted: boolean
  reject_reason?: string
  derived_verdict?: NorthStarSemanticVerdict
  effective_verdict?: NorthStarSemanticVerdict
  reason_codes?: string[]
  required_actions?: NorthStarSemanticGateRequiredAction[]
  required_action_promotions?: NorthStarSemanticActionPromotionAudit[]
  status_mutation?: {
    from: TurnStatus
    to: TurnStatus
    reason: string
  }
  verdict_derivation_audit?: {
    dimension_scores: Record<string, number>
    derived_verdict: NorthStarSemanticVerdict
    legacy_verdict: string | null
    legacy_verdict_ignored: boolean
  }
  claim_audit_debt?: string[]
  low_confidence_coerced?: boolean
}

interface NormalizedNorthStarClaimQuality {
  claims_total: number
  claims_marked_verified: number
  claims_verified_with_valid_evidence: number
  claims_marked_verified_with_invalid_evidence: number
  evidence_valid_coverage: number
  source_metric_path: string
  invariant_violation: boolean
}

interface NorthStarRecentObjective {
  turn: number
  objective_id: string
  objective_version: number
  change_reason: 'pivot_due_to_regress' | 'scope_narrowing' | 'new_constraint' | 'external_feedback' | 'objective_stable'
}

interface NorthStarPathSnapshot {
  path: string
  exists: boolean
  hash: string
  semanticHash: string
  stableSemanticHash: string
  significantBytes: number
  contentKind: 'text' | 'binary' | 'directory' | 'other' | 'missing'
  textExcerpt: string
  mtimeMs: number
  lineCount: number
  nonEmptyLineCount: number
  csvRowCount: number
  csvColumnCount: number
  claimsStatusCounts: Record<string, number>
  claimsStatusColumnPresent: boolean
}

interface NorthStarContentDeltaProof {
  path: string
  beforeHash: string
  afterHash: string
  beforeSemanticHash: string
  afterSemanticHash: string
  beforeStableSemanticHash: string
  afterStableSemanticHash: string
  beforeContentKind: NorthStarPathSnapshot['contentKind']
  afterContentKind: NorthStarPathSnapshot['contentKind']
  structuredDiff: {
    significantBytesDelta: number
    lineCountDelta: number
    nonEmptyLineDelta: number
    csvRowDelta: number
    csvColumnDelta: number
    claimsStatusDelta: Record<string, number>
    claimsStatusColumnPresent: boolean
    changedFields: string[]
  }
}

interface NorthStarEvaluation {
  enabled: boolean
  objectiveId: string
  objectiveVersion: number
  contractPath: string
  artifactGate: 'any' | 'all'
  artifactPaths: string[]
  internalCheckGate: 'any' | 'all'
  internalCheckCommands: string[]
  internalCheckExecutedCommands: string[]
  internalCheckSucceededCommands: string[]
  internalCheckExecutedCount: number
  internalCheckSucceededCount: number
  internalCheckGateSatisfied: boolean
  externalCheckGate: 'any' | 'all'
  externalCheckCommands: string[]
  externalCheckExecutedCommands: string[]
  externalCheckSucceededCommands: string[]
  externalCheckExecutedCount: number
  externalCheckSucceededCount: number
  externalCheckGateSatisfied: boolean
  externalCheckCreditGranted: boolean
  externalCheckCandidateArtifactPaths: string[]
  externalCheckMeaningfulArtifactPaths: string[]
  externalCheckVolatileOnlyArtifactPaths: string[]
  externalCheckUnchangedArtifactPaths: string[]
  externalCheckRequireEvery: number
  externalCheckDueThisTurn: boolean
  externalCheckQuotaSatisfied: boolean
  externalCheckNoSuccessStreak: number
  scoreboardMetricPaths: string[]
  scoreboardMetricPathsValid: boolean
  scoreboardValues: Record<string, number>
  scoreboardPreviousValues: Record<string, number>
  scoreboardImproved: boolean
  scoreboardRegressed: boolean
  scoreboardChangedKeys: string[]
  scoreboardImprovedKeys: string[]
  scoreboardRegressedKeys: string[]
  scoreboardReady: boolean
  realityCheckGate: 'any' | 'all'
  realityCheckCommands: string[]
  realityCheckExecutedCommands: string[]
  realityCheckSucceededCommands: string[]
  realityCheckExecutedCount: number
  realityCheckSucceededCount: number
  realityCheckGateSatisfied: boolean
  previousGateSatisfied: boolean | null
  realityCheckNoExecStreak: number
  antiChurnTriggered: boolean
  verifyCmd: string
  artifactChanged: boolean
  changedArtifacts: string[]
  baselineSnapshots: NorthStarPathSnapshot[]
  afterSnapshots: NorthStarPathSnapshot[]
  contentDeltaProofs: NorthStarContentDeltaProof[]
  verifiedGrowthKeys: string[]
  verifiedGrowthTotalDelta: number
  verifiedGrowthContentProofRequired: boolean
  verifiedGrowthContentProofSatisfied: boolean
  verifiedGrowthContentProofPaths: string[]
  verifiedGrowthMatchedDelta: number
  verifiedGrowthMissingProofReason: string
  verifyExecuted: boolean
  verifySucceeded: boolean
  gateSatisfied: boolean
  policyViolations: string[]
  reason: string
  noDeltaStreak: number
  pivotAllowed: boolean
  pivotRollbackApplied: boolean
  pivotRollbackViolation: string
}

interface OrchestrationResolution {
  mode: ResolvedOrchestrationMode
  northStar: NorthStarContract | null
  notes: string[]
}

interface PlanDoneDefinitionCheck {
  ok: boolean
  reason: string
  deliverableTouched: boolean
  doneReady: boolean
}

interface NativeTurnStatusGuardInput {
  turnNumber: number
  orchestrationMode: ResolvedOrchestrationMode
  northStarContract?: NorthStarContract
  northStarEvaluation: NorthStarEvaluation
  finalStatus: TurnStatus
  summary: string
  activePlanId: string
  planExists: boolean
  planAttributionAmbiguous: boolean
  doneDefinitionCheck: PlanDoneDefinitionCheck
  coTouchedDeliverablePlanIds: string[]
  clearedBlocked: boolean
  repoCodeTouch: { touched: boolean, path: string }
  resolvedRepoTarget: ResolvedRepoTarget
  requireRepoTarget: boolean
  codingLargeRepoUsage: { used: boolean, script: string, usedCodeEditWorkflow: boolean }
  openaiScriptIssue: { reason: string, path: string } | null
  codingAgentSessionObservation: CodingAgentSessionObservation
  workspaceWriteTouches: string[]
  deltaReasons: string[]
  actionFingerprint: string
  doneFingerprintHit: boolean
  priorFingerprintCount: number
  governanceOnlyTurn: boolean
  resultPath: string
  toolEvents: ToolEventRecord[]
  northStarSemanticGateConfig: ResolvedNorthStarSemanticGateConfig
  northStarSemanticGateAudit: NorthStarSemanticGateAuditRecord
  projectedPlanItem: PlanBoardItem | null
  planEvidencePaths: string[]
  businessArtifactEvidencePaths: string[]
  trustedEvidencePaths: string[]
  changedFiles: string[]
  patchPath: string | null
  exitCode: number
  bashHasAnyOutputOnSuccess: boolean
  statusChange: string
  failureEntry: FailureEntry | null
  forcedBlockedReason?: string | null
}

interface NativeTurnStatusGuardResult {
  finalStatus: TurnStatus
  summary: string
  blockedReason: string | null
  doneDefinitionCheck: PlanDoneDefinitionCheck
  deltaReasons: string[]
  statusChange: string
  failureEntry: FailureEntry | null
  northStarSemanticOpenRequiredActions: NorthStarSemanticGateRequiredAction[]
}

interface NativeTurnPlanDeltaInput {
  orchestrationMode: ResolvedOrchestrationMode
  activePlanId: string
  statusChange: string
  deltaText: string
  planEvidencePaths: string[]
  turnStatus: TurnStatus
  dropReason: string
  replacedBy?: string | null
  allowStructuralPlanChanges: boolean
  coTouchedPlanIds: string[]
  currentBoard: PlanBoardItem[]
  projectedUpdate?: ProjectUpdate
  workspaceWriteTouches: string[]
}

interface NativeTurnPlanDeltaResult {
  turnStatus: TurnStatus
  summary: string
  blockedReason: string | null
  planDeltaApplied: boolean
  planDeltaWarning: string
  coPlanStatusChanges: string[]
  coPlanWarnings: string[]
}

interface NativeTurnProjectMutationInput {
  orchestrationMode: ResolvedOrchestrationMode
  northStarEvaluation: NorthStarEvaluation
  preflightNotes: string[]
  outcomeUpdateSummary: string[]
  planAttribution: PlanAttributionResult
  activePlanId: string
  coTouchedPlanIds: string[]
  coTouchedDeliverablePlanIds: string[]
  doneDefinitionCheck: PlanDoneDefinitionCheck
  microCheckpointApplied: boolean
  microCheckpointDeliverable: string
  missingOutcomeEvidencePaths: string[]
  northStarSemanticGateAudit: NorthStarSemanticGateAuditRecord
  codingAgentSessionObservation: CodingAgentSessionObservation
  outcomeProjectUpdate?: ProjectUpdate
  plannerCheckpointDue: boolean
  evidenceRefMap: Record<string, string>
  resultPath: string
  toolEvents: ToolEventRecord[]
  artifactsDir: string
  projectedPlanItem: PlanBoardItem | null
  statusChange: string
  deltaText: string
  planEvidencePaths: string[]
  currentProject: TurnContext['project']
  finalStatus: TurnStatus
  summary: string
  blockedReason: string | null
  dropReason: string
  replacedBy?: string | null
  currentBoard: PlanBoardItem[]
  projectedPlanUpdate?: ProjectUpdate
  workspaceWriteTouches: string[]
  businessArtifactEvidencePaths: string[]
  normalizedOutcomeEvidencePaths: string[]
  runtimeControlEvidencePaths: string[]
  literatureCachePaths: string[]
  actionFingerprint: string
  deltaReasons: string[]
  consumedPendingUserInputs: boolean
  pendingUserInputs: PendingUserInput[]
  plannerCheckpoint?: PlannerCheckpointInfo
  failureEntry: FailureEntry | null
  clearedBlocked: boolean
  northStarSemanticOpenRequiredActions: NorthStarSemanticGateRequiredAction[]
}

interface NativeTurnProjectMutationResult {
  finalStatus: TurnStatus
  summary: string
  blockedReason: string | null
  updateSummaryLines: string[]
  plannerCheckpointRejections: string[]
  persistedProject: TurnContext['project']
  planDeltaApplied: boolean
  planDeltaWarning: string
  coPlanStatusChanges: string[]
  coPlanWarnings: string[]
  clearedRedundancyBlocked: boolean
  doneEntries: Array<{ text: string, evidencePath: string }>
}

interface NativeTurnResultPayloadBuildResult {
  resultPayload: Record<string, unknown>
  stageStatus: StageStatus
}

interface NativeTurnPlanProgressInput {
  orchestrationMode: ResolvedOrchestrationMode
  plannerCheckpointDue: boolean
  outcomeProjectUpdate?: ProjectUpdate
  currentBoard: PlanBoardItem[]
  explicitPlanEvidencePaths: string[]
  workspaceWriteTouches: string[]
  hintedActivePlanId: string
  clearedBlocked: boolean
  finalStatus: TurnStatus
  planEvidencePaths: string[]
  hintedDeltaText: string
  primaryAction: string
  businessArtifactEvidencePaths: string[]
  workspaceChangedFiles: string[]
  failureRecorded: boolean
}

interface NativeTurnPlanProgressResult {
  projectedPlanUpdate?: ProjectUpdate
  planAttribution: PlanAttributionResult
  activePlanId: string
  coTouchedPlanIds: string[]
  planExists: boolean
  projectedPlanItem: PlanBoardItem | null
  statusChange: string
  doneDefinitionCheck: PlanDoneDefinitionCheck
  microCheckpointApplied: boolean
  microCheckpointDeliverable: string
  coTouchedDeliverablePlanIds: string[]
  deltaText: string
}

interface NativeTurnFilePaths {
  cmdPath: string
  stdoutPath: string
  stderrPath: string
  exitCodePath: string
  resultPath: string
  actionPath: string
  toolEventsPath: string
  rawOutputPath: string
}

interface NativeTurnOutcomeExecution {
  outcome: TurnRunOutcome
  consumedPendingUserInputs: boolean
}

type PathAnchorMode = 'recover' | 'fail'

interface PathRewriteEvent {
  from: string
  to: string
  reason: string
}

interface PathAnchorAuditResult {
  detected: boolean
  count: number
  samples: string[]
  rewriteEvents: PathRewriteEvent[]
  scannedPaths: number
  nestedRunsCount: number
  rewrittenCount: number
  mode: PathAnchorMode
}

interface ResolvedRepoTarget {
  repoId: string
  repoPath: string
  source: 'repo_id' | 'cwd' | 'none'
}

export class YoloSession {
  readonly yoloRoot: string
  readonly runsDir: string
  readonly projectFilePath: string
  readonly failuresFilePath: string
  readonly userInputQueuePath: string

  private readonly projectStore: ProjectStore
  private readonly failureStore: FailureStore
  private readonly now: () => Date
  private readonly pathAnchorAuditEnabled: boolean
  private readonly pathAnchorMode: PathAnchorMode
  private readonly requireRepoTarget: boolean
  private readonly artifactUriPreferred: boolean
  private readonly configuredOrchestrationMode: OrchestrationMode
  private latchedOrchestrationMode: ResolvedOrchestrationMode | null = null
  private activeTurnArtifactsDirRel = ''
  private runtimeVersionInfoPromise: Promise<RuntimeVersionInfo> | null = null
  private initialized = false

  private static readonly NORTHSTAR_PIVOT_HARD_VIOLATIONS = new Set<string>([
    'northstar_pivot_locked',
    'northstar_missing_pivot_rationale',
    'northstar_missing_pivot_evidence',
    'northstar_contract_invalid'
  ])

  constructor(private readonly config: CreateYoloSessionConfig) {
    this.now = config.now ?? (() => new Date())
    this.yoloRoot = config.projectPath
    this.runsDir = path.join(this.yoloRoot, 'runs')

    const fallbackRuntime = config.defaultRuntime?.trim() || DEFAULT_RUNTIME
    this.projectStore = new ProjectStore(this.yoloRoot, config.goal, config.successCriteria ?? [], fallbackRuntime)
    this.failureStore = new FailureStore(this.yoloRoot, this.now)
    const envAudit = normalizeText(process.env.YOLO_PATH_ANCHOR_AUDIT || '')
    const envMode = normalizeText(process.env.YOLO_PATH_ANCHOR_MODE || '')
    const configuredMode = normalizeText(config.pathAnchor?.mode || '')
    const configuredAudit = typeof config.pathAnchor?.audit === 'boolean' ? config.pathAnchor.audit : undefined
    this.pathAnchorAuditEnabled = configuredAudit ?? (envAudit ? ['1', 'true', 'yes', 'on'].includes(envAudit) : true)
    this.pathAnchorMode = (configuredMode === 'fail' || configuredMode === 'recover')
      ? configuredMode
      : (envMode === 'fail' ? 'fail' : 'recover')
    const envRequireRepoTarget = normalizeText(process.env.YOLO_REQUIRE_REPO_TARGET || '')
    this.requireRepoTarget = typeof config.requireRepoTarget === 'boolean'
      ? config.requireRepoTarget
      : ['1', 'true', 'yes', 'on'].includes(envRequireRepoTarget)
    const envArtifactUriPreferred = normalizeText(process.env.YOLO_ARTIFACT_URI_PREFERRED || '')
    this.artifactUriPreferred = typeof config.artifactUriPreferred === 'boolean'
      ? config.artifactUriPreferred
      : ['1', 'true', 'yes', 'on'].includes(envArtifactUriPreferred)
    const envOrchestrationMode = normalizeText(process.env.YOLO_ORCHESTRATION_MODE || '')
    const requestedOrchestrationMode = normalizeText(config.orchestrationMode || envOrchestrationMode)
    if (
      requestedOrchestrationMode === 'artifact_gravity_v3_paper'
      || requestedOrchestrationMode === 'auto'
    ) {
      this.configuredOrchestrationMode = requestedOrchestrationMode
    } else {
      this.configuredOrchestrationMode = DEFAULT_ORCHESTRATION_MODE
    }

    this.projectFilePath = this.projectStore.filePath
    this.failuresFilePath = this.failureStore.filePath
    this.userInputQueuePath = path.join(this.yoloRoot, 'user-input-queue.json')
  }

  async init(): Promise<void> {
    if (this.initialized) return

    await ensureDir(this.yoloRoot)
    await ensureDir(this.runsDir)
    await this.projectStore.init()
    await this.failureStore.init()
    await this.ensureUserInputQueueFile()

    this.initialized = true
  }

  async runNextTurn(): Promise<TurnExecutionResult> {
    await this.init()

    let project = await this.projectStore.load()
    const failures = await this.failureStore.load()
    const turnNumber = await this.computeNextTurnNumber()
    const turnDir = path.join(this.runsDir, formatTurnId(turnNumber))
    const artifactsDir = path.join(turnDir, 'artifacts')
    const evidenceDir = path.join(artifactsDir, 'evidence')

    await ensureDir(turnDir)
    await ensureDir(artifactsDir)
    await ensureDir(evidenceDir)

    const orchestration = await this.resolveOrchestration(project)
    const preflightNotes: string[] = [...orchestration.notes]

    if (orchestration.mode === 'artifact_gravity_v3_paper') {
      await this.ensurePaperBootstrapScaffold()
    }

    const pendingUserInputs = await this.materializePendingUserInputs(artifactsDir)
    const stagnation = await this.detectStagnation()
    const noDeltaStreak = await this.countConsecutiveNoDeltaTurns(12, turnNumber - 1)
    const noRealityCheckExecutionStreak = isArtifactGravityPaperMode(orchestration.mode)
      ? await this.countConsecutiveTurnsWithoutRealityCheckExecution(12, turnNumber - 1)
      : 0
    const northStarPivotAllowed = (
      noDeltaStreak >= NORTHSTAR_NO_DELTA_PIVOT_THRESHOLD
      || (isArtifactGravityPaperMode(orchestration.mode)
        && noRealityCheckExecutionStreak >= NORTHSTAR_REALITYCHECK_NO_EXEC_PIVOT_THRESHOLD)
    )
    const evidenceTrust = await this.buildEvidenceTrustContext({ project, turnNumber })
    const workspaceGitRepos = await this.discoverWorkspaceGitRepos()
    const northStarSemanticFeedback = await this.loadNorthStarSemanticFeedbackForContext(turnNumber - 1)
    const context: TurnContext = {
      turnNumber,
      projectRoot: this.config.projectPath,
      yoloRoot: this.yoloRoot,
      runsDir: this.runsDir,
      orchestrationMode: orchestration.mode,
      northStar: orchestration.northStar ?? undefined,
      northStarPivotAllowed,
      workspaceGitRepos,
      project,
      failures,
      recentTurns: await this.loadRecentTurns(this.config.recentTurnsToLoad ?? DEFAULT_RECENT_TURNS_TO_LOAD),
      pendingUserInputs,
      trustedEvidencePaths: evidenceTrust.trustedEvidencePaths,
      untrustedEvidenceHints: evidenceTrust.untrustedEvidenceHints,
      stagnation: stagnation.stagnant ? stagnation : undefined,
      plannerCheckpoint: undefined,
      northStarSemantic: northStarSemanticFeedback
    }

    return this.runNativeTurn({
      context,
      turnNumber,
      turnDir,
      artifactsDir,
      pendingUserInputs,
      preflightNotes
    })
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

  private getNorthStarFilePath(): string {
    return path.join(this.yoloRoot, NORTHSTAR_FILE_NAME)
  }

  private normalizeNorthStarSectionKey(raw: string): string {
    return normalizeText(raw)
      .replace(/[()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private async resolveOrchestration(project: TurnContext['project']): Promise<OrchestrationResolution> {
    const requested = this.configuredOrchestrationMode
    const northStarPath = this.getNorthStarFilePath()

    if (!(await fileExists(northStarPath))) {
      await this.bootstrapNorthStar(project.goal)
    }

    const loaded = await this.loadNorthStarContract({
      filePath: northStarPath,
      fallbackGoal: project.goal
    })
    const hasPaperGate = Boolean(
      loaded.contract
      && loaded.contract.artifactPaths.length > 0
      && loaded.contract.paperArtifactPathsEligible
      && loaded.contract.internalCheckCommands.length > 0
      && loaded.contract.internalCheckAllowlistValid
      && loaded.contract.externalCheckCommands.length > 0
      && loaded.contract.externalCheckAllowlistValid
      && loaded.contract.scoreboardMetricPaths.length > 0
      && loaded.contract.scoreboardMetricPathsValid
    )

    this.latchedOrchestrationMode = 'artifact_gravity_v3_paper'
    const incompleteMessage = requested === 'auto'
      ? 'NORTHSTAR.md paper gate is incomplete; staying in artifact_gravity_v3_paper (auto mode).'
      : 'NORTHSTAR.md paper gate is incomplete; staying in artifact_gravity_v3_paper (forced mode).'
    return {
      mode: 'artifact_gravity_v3_paper',
      northStar: loaded.contract,
      notes: dedupeStrings([
        ...loaded.notes,
        ...(!hasPaperGate ? [incompleteMessage] : [])
      ])
    }
  }

  private async bootstrapNorthStar(goal: string): Promise<void> {
    const filePath = this.getNorthStarFilePath()
    if (await fileExists(filePath)) return

    await this.ensurePaperBootstrapScaffold()

    const template = [
      '# North Star',
      '',
      '## Goal',
      goal.trim() || 'Define a single project goal.',
      '',
      '## Current Objective (this sprint)',
      '- Raise verified-claim coverage and produce one external smoke result.',
      '- objective_id: obj-bootstrap-paper-v1',
      '- objective_version: 1',
      '',
      '## Definition of Done (mechanical)',
      '- [ ] Internal checks pass (gate policy)',
      '- [ ] Scoreboard improves vs previous turn',
      '- [ ] External friction quota is satisfied',
      '- [ ] Evidence bundle exists: runs/turn-xxxx/result.json',
      '',
      '## NorthStarArtifact',
      '- type: paper',
      '- gate: any',
      '- path: artifacts/paper_draft.md',
      '- path: artifacts/claims.csv',
      '- path: artifacts/results/smoke.json',
      '',
      '## RealityCheck (Internal)',
      '- gate: any',
      '- cmd: python scripts/check_claims.py artifacts/claims.csv --emit-metrics artifacts/metrics_claims.json',
      '- cmd: python scripts/check_paper.py artifacts/paper_draft.md artifacts/claims.csv --emit-metrics artifacts/metrics_paper.json',
      '',
      '## RealityCheck (External)',
      '- gate: any',
      '- cmd: python experiments/run_smoke.py --out artifacts/results/smoke.json',
      '',
      '## Gate Policy',
      '- gate: any',
      '',
      '## External Friction Policy',
      `- require_external_every: ${NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_DEFAULT}`,
      '',
      '## Scoreboard',
      '- path: artifacts/metrics_claims.json',
      '- path: artifacts/metrics_paper.json',
      '',
      '## Semantic Review Policy',
      '- mode: enforce_downgrade_only',
      '- confidence_threshold: 0.80',
      '- allow_upgrade: false',
      '- required_action_budget_per_turn: 1',
      '- must_action_max_open: 1',
      '- recent_window_turns: 4',
      '',
      '## Next Action (one line)',
      'Improve claims evidence quality, run one external smoke check, and update paper sections using verified claims.',
      '',
      '## Pivot Rule',
      '- pivot_allowed_when:',
      '  - no_delta_streak >= 2',
      '  - OR realitycheck_no_exec_streak >= 2',
      '- pivot_action:',
      '- rationale: (fill only when pivoting after repeated no_delta)',
      '- evidence: runs/turn-xxxx/result.json',
      ''
    ].join('\n')

    await writeText(filePath, template)
  }

  private async ensurePaperBootstrapScaffold(): Promise<void> {
    const artifactsDir = path.join(this.config.projectPath, 'artifacts')
    const scriptsDir = path.join(this.config.projectPath, 'scripts')
    const experimentsDir = path.join(this.config.projectPath, 'experiments')
    const resultsDir = path.join(artifactsDir, 'results')
    await ensureDir(artifactsDir)
    await ensureDir(scriptsDir)
    await ensureDir(experimentsDir)
    await ensureDir(resultsDir)

    const maybeWrite = async (
      relativePath: string,
      content: string,
      shouldUpgrade?: (existingContent: string) => boolean
    ): Promise<void> => {
      const absolutePath = path.join(this.config.projectPath, relativePath)
      if (await fileExists(absolutePath)) {
        if (!shouldUpgrade) return
        const existingContent = await readTextOrEmpty(absolutePath)
        if (!shouldUpgrade(existingContent)) return
        await writeText(absolutePath, content)
        return
      }
      await ensureDir(path.dirname(absolutePath))
      await writeText(absolutePath, content)
    }

    await maybeWrite('artifacts/paper_draft.md', [
      '# Paper Draft',
      '',
      '## Abstract',
      '',
      '## Introduction',
      '',
      '## Method',
      '',
      '## Experiments',
      '',
      '## Related Work',
      '',
      '## Limitations',
      '',
      '## Conclusion',
      ''
    ].join('\n'))

    await maybeWrite('artifacts/claims.csv', [
      'id,type,claim,evidence,status',
      'C1,method,"Describe baseline method in one sentence.",cite:bootstrap,draft'
    ].join('\n'))

    await maybeWrite('scripts/check_claims.py', [
      '#!/usr/bin/env python3',
      'import argparse',
      'import csv',
      'import json',
      'import os',
      'import re',
      'import sys',
      '',
      'ID_RE = re.compile(r"^C\\d+$")',
      'STRONG_EVIDENCE_RE = re.compile(r"^(runs/turn-\\d{4}/|doi:|cite:|arxiv:|pmid:|openalex:)", re.IGNORECASE)',
      'WEAK_EVIDENCE_RE = re.compile(r"^(logic:|proposal:|link:|note:|hypothesis:)", re.IGNORECASE)',
      '',
      'def split_evidence(raw: str) -> list[str]:',
      '    value = str(raw or "").strip()',
      '    if not value:',
      '        return []',
      '    parts = re.split(r"\\s*[;|]\\s*", value)',
      '    return [part.strip() for part in parts if part.strip()]',
      '',
      'def classify_evidence(raw: str) -> str:',
      '    entries = split_evidence(raw)',
      '    if not entries:',
      '        return "missing"',
      '    has_strong = False',
      '    has_weak = False',
      '    for entry in entries:',
      '        if STRONG_EVIDENCE_RE.match(entry):',
      '            has_strong = True',
      '        elif WEAK_EVIDENCE_RE.match(entry):',
      '            has_weak = True',
      '        else:',
      '            has_weak = True',
      '    if has_strong:',
      '        return "strong"',
      '    if has_weak:',
      '        return "weak"',
      '    return "missing"',
      '',
      'def main() -> int:',
      '    parser = argparse.ArgumentParser()',
      '    parser.add_argument("claims_csv")',
      '    parser.add_argument("--emit-metrics", default="")',
      '    args = parser.parse_args()',
      '',
      '    if not os.path.exists(args.claims_csv):',
      '        print(f"missing file: {args.claims_csv}", file=sys.stderr)',
      '        return 2',
      '',
      '    with open(args.claims_csv, "r", encoding="utf-8", newline="") as f:',
      '        reader = csv.DictReader(f)',
      '        rows = list(reader)',
      '',
      '    required = {"id", "type", "claim", "evidence", "status"}',
      '    missing_cols = sorted(required - set(rows[0].keys() if rows else []))',
      '    if missing_cols:',
      '        print("missing columns: " + ", ".join(missing_cols), file=sys.stderr)',
      '        return 2',
      '',
      '    ids = [str(row.get("id", "")).strip() for row in rows]',
      '    id_ok = all(ID_RE.match(cid) for cid in ids if cid)',
      '    unique_ok = len(set(ids)) == len(ids)',
      '    non_empty_claims = sum(1 for row in rows if str(row.get("claim", "")).strip())',
      '    evidence_non_empty = sum(1 for row in rows if str(row.get("evidence", "")).strip())',
      '    total = len(rows)',
      '    evidence_classification = [classify_evidence(str(row.get("evidence", ""))) for row in rows]',
      '    evidence_strong = sum(1 for state in evidence_classification if state == "strong")',
      '    evidence_weak = sum(1 for state in evidence_classification if state == "weak")',
      '    verified_raw = sum(1 for row in rows if str(row.get("status", "")).strip().lower() == "verified")',
      '    verified = sum(1 for row, state in zip(rows, evidence_classification) if str(row.get("status", "")).strip().lower() == "verified" and state == "strong")',
      '    verified_invalid = max(verified_raw - verified, 0)',
      '    missing_evidence = max(total - evidence_non_empty, 0)',
      '    evidence_coverage = (evidence_non_empty / total) if total else 0.0',
      '    evidence_valid_coverage = (evidence_strong / total) if total else 0.0',
      '',
      '    metrics = {',
      '        "claims_total": total,',
      '        "claims_verified": verified,',
      '        "claims_verified_raw": verified_raw,',
      '        "claims_verified_invalid_evidence": verified_invalid,',
      '        "claims_missing_evidence": missing_evidence,',
      '        "evidence_invalid_count": evidence_weak,',
      '        "evidence_coverage": round(evidence_coverage, 6),',
      '        "evidence_valid_coverage": round(evidence_valid_coverage, 6),',
      '    }',
      '',
      '    if args.emit_metrics:',
      '        os.makedirs(os.path.dirname(args.emit_metrics) or ".", exist_ok=True)',
      '        with open(args.emit_metrics, "w", encoding="utf-8") as mf:',
      '            json.dump(metrics, mf, ensure_ascii=False, indent=2)',
      '',
      '    print(json.dumps(metrics, ensure_ascii=False))',
      '',
      '    if not id_ok:',
      '        print("invalid claim ids (expect C<number>)", file=sys.stderr)',
      '        return 2',
      '    if not unique_ok:',
      '        print("duplicate claim ids", file=sys.stderr)',
      '        return 2',
      '    if non_empty_claims == 0:',
      '        print("all claims are empty", file=sys.stderr)',
      '        return 2',
      '    if verified_invalid > 0:',
      '        print("verified claims require verifiable evidence (runs/turn-xxxx, doi:, cite:, arxiv:, pmid:, openalex:)", file=sys.stderr)',
      '        return 2',
      '    return 0',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      ''
    ].join('\n'), (existing) => (
      existing.includes('evidence_non_empty = sum(')
      && !existing.includes('evidence_valid_coverage')
      && existing.includes('claims_missing_evidence')
    ))

    await maybeWrite('scripts/check_paper.py', [
      '#!/usr/bin/env python3',
      'import argparse',
      'import csv',
      'import json',
      'import os',
      'import re',
      'import sys',
      '',
      'REQUIRED_SECTIONS = [',
      '    "## Abstract",',
      '    "## Introduction",',
      '    "## Method",',
      '    "## Experiments",',
      '    "## Related Work",',
      '    "## Limitations",',
      ']',
      '',
      'def load_claim_ids(path: str) -> set[str]:',
      '    if not os.path.exists(path):',
      '        return set()',
      '    with open(path, "r", encoding="utf-8", newline="") as f:',
      '        rows = list(csv.DictReader(f))',
      '    return {str(row.get("id", "")).strip() for row in rows if str(row.get("id", "")).strip()}',
      '',
      'def main() -> int:',
      '    parser = argparse.ArgumentParser()',
      '    parser.add_argument("paper_md")',
      '    parser.add_argument("claims_csv")',
      '    parser.add_argument("--emit-metrics", default="")',
      '    args = parser.parse_args()',
      '',
      '    if not os.path.exists(args.paper_md):',
      '        print(f"missing file: {args.paper_md}", file=sys.stderr)',
      '        return 2',
      '',
      '    text = open(args.paper_md, "r", encoding="utf-8").read()',
      '    required_missing = [sec for sec in REQUIRED_SECTIONS if sec not in text]',
      '    todo_count = len(re.findall(r"\\bTODO\\b", text, flags=re.IGNORECASE))',
      '    cite_needed_count = len(re.findall(r"\\bCITE_NEEDED\\b", text, flags=re.IGNORECASE))',
      '',
      '    claim_refs = set(re.findall(r"\\[(C\\d+)\\]", text))',
      '    known_claim_ids = load_claim_ids(args.claims_csv)',
      '    missing_claim_refs = sorted(ref for ref in claim_refs if ref not in known_claim_ids)',
      '',
      '    metrics = {',
      '        "paper_todo_count": todo_count,',
      '        "paper_cite_needed_count": cite_needed_count,',
      '        "paper_claim_refs_missing": len(missing_claim_refs),',
      '        "paper_claim_refs_total": len(claim_refs),',
      '        "paper_required_sections_missing": len(required_missing),',
      '    }',
      '',
      '    if args.emit_metrics:',
      '        os.makedirs(os.path.dirname(args.emit_metrics) or ".", exist_ok=True)',
      '        with open(args.emit_metrics, "w", encoding="utf-8") as mf:',
      '            json.dump(metrics, mf, ensure_ascii=False, indent=2)',
      '',
      '    print(json.dumps(metrics, ensure_ascii=False))',
      '',
      '    if required_missing:',
      '        print("missing sections: " + ", ".join(required_missing), file=sys.stderr)',
      '        return 2',
      '    if missing_claim_refs:',
      '        print("unknown claim refs: " + ", ".join(missing_claim_refs), file=sys.stderr)',
      '        return 2',
      '    return 0',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      ''
    ].join('\n'))

    await maybeWrite('experiments/run_smoke.py', [
      '#!/usr/bin/env python3',
      'import argparse',
      'import json',
      'import os',
      'from datetime import datetime, timezone',
      '',
      'def main() -> int:',
      '    parser = argparse.ArgumentParser()',
      '    parser.add_argument("--out", required=True)',
      '    args = parser.parse_args()',
      '',
      '    payload = {',
      '        "smoke_ok": True,',
      '        "generated_at": datetime.now(timezone.utc).isoformat(),',
      '        "runtime_ms": 1,',
      '        "sample_size": 1,',
      '    }',
      '    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)',
      '    with open(args.out, "w", encoding="utf-8") as f:',
      '        json.dump(payload, f, ensure_ascii=False, indent=2)',
      '    print(json.dumps({"out": args.out, "smoke_ok": True}, ensure_ascii=False))',
      '    return 0',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      ''
    ].join('\n'))
  }

  private normalizeNorthStarPath(rawPath: string): string {
    const trimmed = rawPath
      .trim()
      .replace(/^`+|`+$/g, '')
      .replace(/^"+|"+$/g, '')
      .replace(/^'+|'+$/g, '')
      .replace(/^\.\//, '')
    if (!trimmed) return ''
    if (trimmed.includes('<') || trimmed.includes('>')) return ''

    const parsedArtifactUri = parseArtifactUri(trimmed)
    if (parsedArtifactUri) return ''

    if (path.isAbsolute(trimmed)) return ''

    const normalized = toPosixPath(trimmed)
    if (!normalized || normalized.startsWith('../') || normalized === '..') return ''
    if (NORTHSTAR_SCOPED_RUNS_RE.test(normalized)) return ''
    return normalized
  }

  private extractNorthStarArtifactPaths(lines: string[]): string[] {
    const paths: string[] = []

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      const pathMatch = /^(?:[-*]\s*)?path\s*:\s*(.+)$/i.exec(line)
      if (pathMatch?.[1]) {
        const candidates = pathMatch[1]
          .split(/[;,|]/g)
          .map((value) => this.normalizeNorthStarPath(value))
          .filter(Boolean)
        paths.push(...candidates)
        continue
      }

      const bulletPath = /^[-*]\s+(.+)$/.exec(line)?.[1] ?? ''
      if (!bulletPath) continue
      if (!/[/.]/.test(bulletPath)) continue
      const normalized = this.normalizeNorthStarPath(bulletPath)
      if (normalized) paths.push(normalized)
    }

    return dedupeStrings(paths)
  }

  private extractNorthStarArtifactGate(lines: string[]): 'any' | 'all' {
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const gateMatch = /^(?:[-*]\s*)?gate\s*:\s*(.+)$/i.exec(line)
      if (!gateMatch?.[1]) continue
      const normalized = normalizeText(gateMatch[1])
      if (normalized === 'all') return 'all'
      if (normalized === 'any') return 'any'
    }
    return 'any'
  }

  private extractNorthStarVerifyCmd(lines: string[]): string {
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const cmdMatch = /^(?:[-*]\s*)?cmd\s*:\s*(.+)$/i.exec(line)
      if (!cmdMatch?.[1]) continue
      const rawValue = cmdMatch[1]
        .trim()
        .replace(/^`+|`+$/g, '')
      const wrappedInMatchingQuotes = (
        (rawValue.startsWith('"') && rawValue.endsWith('"'))
        || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
      )
      const value = wrappedInMatchingQuotes
        ? rawValue.slice(1, -1).trim()
        : rawValue
      if (!value || value.includes('<') || value.includes('>')) continue
      return value
    }
    return ''
  }

  private normalizeNorthStarCommand(raw: string): string {
    const value = raw
      .trim()
      .replace(/^`+|`+$/g, '')
      .replace(/^"+|"+$/g, '')
      .replace(/^'+|'+$/g, '')
    if (!value) return ''
    if (value.includes('<') || value.includes('>')) return ''
    return value.replace(/\s+/g, ' ').trim()
  }

  private extractNorthStarCommandLines(lines: string[]): string[] {
    const commands: string[] = []
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const cmdMatch = /^(?:[-*]\s*)?cmd\s*:\s*(.+)$/i.exec(line)
      if (cmdMatch?.[1]) {
        const normalized = this.normalizeNorthStarCommand(cmdMatch[1])
        if (normalized) commands.push(normalized)
        continue
      }

      const bullet = /^[-*]\s+(.+)$/.exec(line)?.[1] ?? ''
      if (!bullet) continue
      const normalized = this.normalizeNorthStarCommand(bullet)
      if (!normalized) continue
      if (/^(python|python3|uv|node|npm)\b/i.test(normalized)) {
        commands.push(normalized)
      }
    }
    return dedupeStrings(commands)
  }

  private commandPassesCheckAllowlist(command: string, kind: 'internal' | 'external'): boolean {
    const normalized = this.normalizeCommandForMatch(command)
    if (!normalized) return false
    if (NORTHSTAR_REALITYCHECK_CMD_DENY_RE.test(normalized)) return false
    const allowlist = kind === 'internal'
      ? NORTHSTAR_INTERNAL_CHECK_CMD_ALLOWLIST
      : NORTHSTAR_EXTERNAL_CHECK_CMD_ALLOWLIST
    return allowlist.some((pattern) => pattern.test(normalized))
  }

  private validateCheckCommands(commands: string[], kind: 'internal' | 'external'): { valid: boolean; invalidCommands: string[] } {
    const invalidCommands = commands.filter((command) => !this.commandPassesCheckAllowlist(command, kind))
    return {
      valid: invalidCommands.length === 0,
      invalidCommands: dedupeStrings(invalidCommands)
    }
  }

  private async evaluatePaperArtifactPathEligibility(paths: string[]): Promise<{ eligible: boolean; invalidPaths: string[] }> {
    if (paths.length === 0) {
      return {
        eligible: false,
        invalidPaths: []
      }
    }

    const invalidPaths: string[] = []
    for (const artifactPath of paths) {
      const normalized = this.normalizeNorthStarPath(artifactPath)
      if (!normalized) {
        invalidPaths.push(artifactPath)
        continue
      }
      if (!NORTHSTAR_PAPER_ARTIFACT_PATH_RE.test(normalized) || !normalized.startsWith('artifacts/')) {
        invalidPaths.push(normalized)
        continue
      }
      try {
        const absolutePath = this.ensureSafeTargetPath(normalized)
        const parent = path.dirname(absolutePath)
        const parentRelative = toPosixPath(path.relative(this.config.projectPath, parent))
        if (parentRelative !== 'artifacts' && !parentRelative.startsWith('artifacts/')) {
          invalidPaths.push(normalized)
          continue
        }
      } catch {
        invalidPaths.push(normalized)
      }
    }

    return {
      eligible: invalidPaths.length === 0,
      invalidPaths: dedupeStrings(invalidPaths)
    }
  }

  private extractNorthStarGatePolicy(lines: string[]): 'any' | 'all' {
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const gateMatch = /^(?:[-*]\s*)?gate\s*:\s*(.+)$/i.exec(line)
      if (!gateMatch?.[1]) continue
      const normalized = normalizeText(gateMatch[1])
      if (normalized === 'all') return 'all'
      if (normalized === 'any') return 'any'
    }
    return 'any'
  }

  private extractNorthStarExternalRequireEvery(lines: string[]): number {
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const match = /^(?:[-*]\s*)?require_external_every\s*:\s*(\d+)$/i.exec(line)
      if (!match?.[1]) continue
      const parsed = Number.parseInt(match[1], 10)
      if (!Number.isFinite(parsed)) continue
      return Math.min(
        NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MAX,
        Math.max(NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MIN, parsed)
      )
    }
    return NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_DEFAULT
  }

  private extractNorthStarScoreboardPaths(lines: string[]): string[] {
    const paths: string[] = []
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const pathMatch = /^(?:[-*]\s*)?path\s*:\s*(.+)$/i.exec(line)
      const candidate = pathMatch?.[1]
        ? pathMatch[1]
        : (/^[-*]\s+(.+)$/.exec(line)?.[1] ?? '')
      if (!candidate) continue
      const normalized = this.normalizeNorthStarPath(candidate)
      if (!normalized) continue
      paths.push(normalized)
    }
    return dedupeStrings(paths)
  }

  private extractMetricPathsFromCommands(commands: string[]): string[] {
    const collected: string[] = []
    for (const command of commands) {
      const emitMatch = /--emit[-_]metrics\s+([^\s]+)/i.exec(command)
      if (!emitMatch?.[1]) continue
      const normalized = this.normalizeNorthStarPath(emitMatch[1])
      if (!normalized) continue
      collected.push(normalized)
    }
    return dedupeStrings(collected)
  }

  private validateNorthStarScoreboardPaths(paths: string[]): { valid: boolean; invalidPaths: string[] } {
    const invalidPaths: string[] = []
    for (const metricPath of paths) {
      const normalized = this.normalizeNorthStarPath(metricPath)
      if (!normalized) {
        invalidPaths.push(metricPath)
        continue
      }
      if (!NORTHSTAR_SCOREBOARD_PATH_RE.test(normalized)) {
        invalidPaths.push(normalized)
      }
    }
    return {
      valid: invalidPaths.length === 0,
      invalidPaths: dedupeStrings(invalidPaths)
    }
  }

  private extractFirstMeaningfulSectionLine(lines: string[]): string {
    for (const rawLine of lines) {
      const normalized = rawLine
        .trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim()
      if (!normalized) continue
      return normalized
    }
    return ''
  }

  private parseNorthStarObjectiveMetadata(lines: string[], fallbackObjective: string): {
    objectiveId: string
    objectiveVersion: number
  } {
    let objectiveId = ''
    let objectiveVersion = 0
    let objectiveSeed = ''

    for (const rawLine of lines) {
      const line = rawLine
        .trim()
        .replace(/^[-*]\s+/, '')
        .trim()
      if (!line) continue

      const idMatch = /^objective[_\s-]?id\s*:\s*(.+)$/i.exec(line)
      if (idMatch?.[1]) {
        objectiveId = idMatch[1].trim()
        continue
      }

      const versionMatch = /^objective[_\s-]?version\s*:\s*(\d+)$/i.exec(line)
      if (versionMatch?.[1]) {
        const parsed = Number.parseInt(versionMatch[1], 10)
        if (Number.isFinite(parsed) && parsed > 0) objectiveVersion = parsed
        continue
      }

      if (!objectiveSeed && !/:/.test(line)) {
        objectiveSeed = line
      }
    }

    const seed = objectiveSeed || fallbackObjective || 'northstar-objective'
    if (!objectiveId) {
      objectiveId = `obj-${hashStable(normalizeText(seed) || seed)}`
    }
    if (!objectiveVersion || !Number.isFinite(objectiveVersion) || objectiveVersion < 1) {
      objectiveVersion = 1
    }

    return {
      objectiveId,
      objectiveVersion
    }
  }

  private parseNorthStarSemanticReviewPolicy(lines: string[]): NorthStarContract['semanticReviewPolicy'] {
    let mode: NorthStarSemanticGateMode = DEFAULT_NORTHSTAR_SEMANTIC_GATE_MODE
    let confidenceThreshold = DEFAULT_NORTHSTAR_SEMANTIC_GATE_CONFIDENCE
    let allowUpgrade = false
    let requiredActionBudgetPerTurn = DEFAULT_NORTHSTAR_SEMANTIC_REQUIRED_ACTION_BUDGET
    let mustActionMaxOpen = DEFAULT_NORTHSTAR_SEMANTIC_MUST_MAX_OPEN
    let recentWindowTurns = DEFAULT_NORTHSTAR_SEMANTIC_RECENT_WINDOW

    for (const rawLine of lines) {
      const line = rawLine
        .trim()
        .replace(/^[-*]\s+/, '')
        .trim()
      if (!line) continue

      const modeMatch = /^mode\s*:\s*(.+)$/i.exec(line)
      if (modeMatch?.[1]) {
        const value = normalizeText(modeMatch[1]).replace(/\s+/g, '_')
        if (
          value === 'off'
          || value === 'shadow'
          || value === 'enforce_downgrade_only'
          || value === 'enforce_balanced'
        ) {
          mode = value
        }
        continue
      }

      const confidenceMatch = /^confidence[_\s-]?threshold\s*:\s*([0-9]*\.?[0-9]+)$/i.exec(line)
      if (confidenceMatch?.[1]) {
        const parsed = Number(confidenceMatch[1])
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          confidenceThreshold = parsed
        }
        continue
      }

      const allowUpgradeMatch = /^allow[_\s-]?upgrade\s*:\s*(true|false|yes|no|on|off|1|0)$/i.exec(line)
      if (allowUpgradeMatch?.[1]) {
        const normalized = normalizeText(allowUpgradeMatch[1])
        allowUpgrade = normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1'
        continue
      }

      const budgetMatch = /^required[_\s-]?action[_\s-]?budget[_\s-]?per[_\s-]?turn\s*:\s*(\d+)$/i.exec(line)
      if (budgetMatch?.[1]) {
        const parsed = Number.parseInt(budgetMatch[1], 10)
        if (Number.isFinite(parsed) && parsed >= 0) {
          requiredActionBudgetPerTurn = Math.min(3, Math.max(0, parsed))
        }
        continue
      }

      const mustMaxMatch = /^must[_\s-]?action[_\s-]?max[_\s-]?open\s*:\s*(\d+)$/i.exec(line)
      if (mustMaxMatch?.[1]) {
        const parsed = Number.parseInt(mustMaxMatch[1], 10)
        if (Number.isFinite(parsed) && parsed >= 0) {
          mustActionMaxOpen = Math.min(3, Math.max(0, parsed))
        }
        continue
      }

      const recentWindowMatch = /^recent[_\s-]?window[_\s-]?turns\s*:\s*(\d+)$/i.exec(line)
      if (recentWindowMatch?.[1]) {
        const parsed = Number.parseInt(recentWindowMatch[1], 10)
        if (Number.isFinite(parsed) && parsed >= 1) {
          recentWindowTurns = Math.min(12, Math.max(1, parsed))
        }
      }
    }

    return {
      mode,
      confidenceThreshold,
      allowUpgrade,
      requiredActionBudgetPerTurn,
      mustActionMaxOpen,
      recentWindowTurns
    }
  }

  private async loadNorthStarContract(input: {
    filePath: string
    fallbackGoal: string
  }): Promise<{ contract: NorthStarContract | null; notes: string[] }> {
    if (!(await fileExists(input.filePath))) {
      return {
        contract: null,
        notes: ['NORTHSTAR.md not found.']
      }
    }

    const raw = await readTextOrEmpty(input.filePath)
    if (!raw.trim()) {
      return {
        contract: null,
        notes: ['NORTHSTAR.md is empty.']
      }
    }

    const sections = new Map<string, string[]>()
    let activeSection = ''
    for (const rawLine of raw.split(/\r?\n/)) {
      const headingMatch = /^\s*##\s+(.+?)\s*$/.exec(rawLine)
      if (headingMatch?.[1]) {
        activeSection = this.normalizeNorthStarSectionKey(headingMatch[1])
        if (!sections.has(activeSection)) sections.set(activeSection, [])
        continue
      }
      if (!sections.has(activeSection)) sections.set(activeSection, [])
      sections.get(activeSection)!.push(rawLine)
    }

    const section = (...keys: string[]): string[] => {
      for (const key of keys) {
        const normalized = this.normalizeNorthStarSectionKey(key)
        if (sections.has(normalized)) return sections.get(normalized) ?? []
      }
      return []
    }
    const sectionPrefix = (...keys: string[]): string[] => {
      const rows: string[] = []
      for (const [sectionKey, sectionLines] of sections.entries()) {
        for (const key of keys) {
          const normalized = this.normalizeNorthStarSectionKey(key)
          if (sectionKey === normalized || sectionKey.startsWith(`${normalized} `)) {
            rows.push(...sectionLines)
            break
          }
        }
      }
      return rows
    }

    const goal = this.extractFirstMeaningfulSectionLine(section('goal')) || input.fallbackGoal
    const currentObjectiveSection = section('current objective', 'current objective this sprint')
    const currentObjective = this.extractFirstMeaningfulSectionLine(currentObjectiveSection)
    const objectiveMeta = this.parseNorthStarObjectiveMetadata(currentObjectiveSection, currentObjective || goal)
    const nextAction = this.extractFirstMeaningfulSectionLine(section('next action', 'next action one line'))
    const artifactSectionLines = section('northstarartifact', 'north star artifact')
    const verifySectionLines = sectionPrefix('verify')
    const genericRealityCheckSectionLines = section('realitycheck', 'reality check')
    let internalRealityCheckSectionLines = sectionPrefix('realitycheck internal', 'reality check internal')
    let externalRealityCheckSectionLines = sectionPrefix('realitycheck external', 'reality check external')
    if (internalRealityCheckSectionLines.length === 0 && externalRealityCheckSectionLines.length === 0) {
      internalRealityCheckSectionLines = genericRealityCheckSectionLines
    }
    const gatePolicySectionLines = section('gate policy')
    const semanticReviewPolicySectionLines = section('semantic review policy')
    const externalFrictionPolicyLines = section('external friction policy')
    const scoreboardSectionLines = section('scoreboard')
    const artifactType = this.extractFirstMeaningfulSectionLine(
      artifactSectionLines.filter((line) => /type\s*:/i.test(line))
    ).replace(/^type\s*:\s*/i, '').trim()
    const artifactGate = this.extractNorthStarArtifactGate(artifactSectionLines)
    const artifactPaths = this.extractNorthStarArtifactPaths(artifactSectionLines)
    const paperArtifactEligibility = await this.evaluatePaperArtifactPathEligibility(artifactPaths)
    const fallbackRealityCheckGate = this.extractNorthStarGatePolicy(gatePolicySectionLines)
    const internalCheckCommands = this.extractNorthStarCommandLines(internalRealityCheckSectionLines)
    const externalCheckCommands = this.extractNorthStarCommandLines(externalRealityCheckSectionLines)
    const internalCheckGate = internalRealityCheckSectionLines.length > 0
      ? this.extractNorthStarGatePolicy(internalRealityCheckSectionLines)
      : fallbackRealityCheckGate
    const externalCheckGate = externalRealityCheckSectionLines.length > 0
      ? this.extractNorthStarGatePolicy(externalRealityCheckSectionLines)
      : 'any'
    const internalCheckValidation = this.validateCheckCommands(internalCheckCommands, 'internal')
    const externalCheckValidation = this.validateCheckCommands(externalCheckCommands, 'external')
    const externalCheckRequireEvery = this.extractNorthStarExternalRequireEvery(externalFrictionPolicyLines)
    const scoreboardMetricPaths = dedupeStrings([
      ...this.extractNorthStarScoreboardPaths(scoreboardSectionLines),
      ...this.extractMetricPathsFromCommands(internalCheckCommands)
    ])
    const scoreboardValidation = this.validateNorthStarScoreboardPaths(scoreboardMetricPaths)
    const realityCheckCommands = dedupeStrings([...internalCheckCommands, ...externalCheckCommands])
    const realityCheckGate = fallbackRealityCheckGate
    const realityCheckAllowlistValid = internalCheckValidation.valid && externalCheckValidation.valid
    const verifyCmd = this.extractNorthStarVerifyCmd(verifySectionLines)
    const verifySuccessSignal = this.extractFirstMeaningfulSectionLine(
      verifySectionLines.filter((line) => /success signal\s*:/i.test(line))
    ).replace(/^success signal\s*:\s*/i, '').trim()
    const semanticReviewPolicy = this.parseNorthStarSemanticReviewPolicy(semanticReviewPolicySectionLines)

    const notes: string[] = []
    if (artifactSectionLines.some((line) => NORTHSTAR_SCOPED_RUNS_RE.test(line.trim()))) {
      notes.push('NORTHSTAR.md path under runs/turn-xxxx is invalid; use stable project-relative artifact paths.')
    }
    if (artifactSectionLines.some((line) => /\bartifact:\/\//i.test(line)) && artifactPaths.length === 0) {
      notes.push('NORTHSTAR.md does not accept artifact:// URIs; use plain project-relative paths.')
    }
    if (artifactPaths.length === 0) {
      notes.push('NORTHSTAR.md has no valid NorthStarArtifact path.')
    }
    if (!paperArtifactEligibility.eligible && artifactPaths.length > 0) {
      notes.push(`NORTHSTAR.md paper artifact paths must be stable artifacts/* paths (invalid: ${paperArtifactEligibility.invalidPaths.join(', ') || 'unknown'}).`)
    }
    if (internalCheckCommands.length === 0) {
      notes.push('NORTHSTAR.md has no RealityCheck (Internal) cmd entries.')
    }
    if (!internalCheckValidation.valid && internalCheckValidation.invalidCommands.length > 0) {
      notes.push(`NORTHSTAR.md internal RealityCheck allowlist rejected cmd(s): ${internalCheckValidation.invalidCommands.join(' | ')}`)
    }
    if (externalCheckCommands.length === 0) {
      notes.push('NORTHSTAR.md has no RealityCheck (External) cmd entries.')
    }
    if (!externalCheckValidation.valid && externalCheckValidation.invalidCommands.length > 0) {
      notes.push(`NORTHSTAR.md external RealityCheck allowlist rejected cmd(s): ${externalCheckValidation.invalidCommands.join(' | ')}`)
    }
    if (scoreboardMetricPaths.length === 0) {
      notes.push('NORTHSTAR.md has no Scoreboard metric path entries.')
    }
    if (!scoreboardValidation.valid && scoreboardValidation.invalidPaths.length > 0) {
      notes.push(`NORTHSTAR.md Scoreboard path rejected (must be artifacts/*.json): ${scoreboardValidation.invalidPaths.join(', ')}`)
    }
    if (!verifyCmd) {
      notes.push('NORTHSTAR.md has no verify cmd; artifact-diff gate only.')
    }

    const contract: NorthStarContract = {
      filePath: this.toEvidencePath(input.filePath),
      goal: goal.trim(),
      currentObjective: currentObjective.trim(),
      objectiveId: objectiveMeta.objectiveId,
      objectiveVersion: objectiveMeta.objectiveVersion,
      artifactType: artifactType || 'unknown',
      artifactGate,
      artifactPaths,
      paperArtifactPathsEligible: paperArtifactEligibility.eligible,
      internalCheckCommands,
      internalCheckGate,
      internalCheckAllowlistValid: internalCheckValidation.valid,
      externalCheckCommands,
      externalCheckGate,
      externalCheckAllowlistValid: externalCheckValidation.valid,
      externalCheckRequireEvery,
      scoreboardMetricPaths,
      scoreboardMetricPathsValid: scoreboardValidation.valid,
      scoreboardMetricPathsInvalid: scoreboardValidation.invalidPaths,
      realityCheckCommands,
      realityCheckGate,
      realityCheckAllowlistValid,
      verifyCmd: verifyCmd || undefined,
      verifySuccessSignal: verifySuccessSignal || undefined,
      semanticReviewPolicy,
      nextAction: nextAction.trim()
    }

    return {
      contract,
      notes: dedupeStrings(notes)
    }
  }

  private async countConsecutiveNoDeltaTurns(limit: number = 12, maxTurnNumber: number = Number.MAX_SAFE_INTEGER): Promise<number> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    if (turnNumbers.length === 0) return 0

    let count = 0
    const selected = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .slice(-Math.max(0, limit))
      .reverse()
    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const status = normalizeText(parsed.status)
        const blockedReason = normalizeText(parsed.blocked_reason)
        const noDeltaEquivalent = (
          status === 'no_delta'
          || (status === 'blocked' && blockedReason === 'redundant_no_delta')
        )
        if (!noDeltaEquivalent) break
        count += 1
      } catch {
        continue
      }
    }

    return count
  }

  private async countConsecutiveTurnsWithoutRealityCheckExecution(
    limit: number = 12,
    maxTurnNumber: number = Number.MAX_SAFE_INTEGER
  ): Promise<number> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    if (turnNumbers.length === 0) return 0

    let count = 0
    const selected = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .slice(-Math.max(0, limit))
      .reverse()

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northStar = toPlainObject(parsed.northstar)
        const executedCount = typeof northStar?.internal_check_executed_count === 'number'
          ? northStar.internal_check_executed_count
          : (typeof northStar?.reality_check_executed_count === 'number'
              ? northStar.reality_check_executed_count
              : 0)
        if (executedCount > 0) break
        count += 1
      } catch {
        continue
      }
    }

    return count
  }

  private async countConsecutiveTurnsWithoutExternalCheckSuccess(
    limit: number = 20,
    maxTurnNumber: number = Number.MAX_SAFE_INTEGER
  ): Promise<number> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    if (turnNumbers.length === 0) return 0

    let count = 0
    const selected = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .slice(-Math.max(0, limit))
      .reverse()

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northStar = toPlainObject(parsed.northstar)
        if (northStar && typeof northStar.external_check_credit_granted === 'boolean') {
          if (northStar.external_check_credit_granted) break
          count += 1
          continue
        }

        const meaningfulCount = typeof northStar?.external_check_meaningful_artifact_count === 'number'
          ? northStar.external_check_meaningful_artifact_count
          : 0
        if (meaningfulCount > 0) break

        const succeededCount = typeof northStar?.external_check_succeeded_count === 'number'
          ? northStar.external_check_succeeded_count
          : 0
        if (succeededCount > 0) break
        count += 1
      } catch {
        continue
      }
    }

    return count
  }

  private flattenNumericMetrics(
    value: unknown,
    prefix: string,
    target: Record<string, number>,
    depth: number = 0
  ): void {
    if (depth > 4 || value === null || value === undefined) return
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (prefix) target[prefix] = value
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        this.flattenNumericMetrics(entry, prefix ? `${prefix}[${index}]` : `[${index}]`, target, depth + 1)
      })
      return
    }
    if (typeof value !== 'object') return

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key
      this.flattenNumericMetrics(entry, childPrefix, target, depth + 1)
    }
  }

  private async loadNorthStarScoreboardValues(metricPaths: string[]): Promise<Record<string, number>> {
    const values: Record<string, number> = {}
    for (const metricPath of metricPaths) {
      const normalized = this.normalizeNorthStarPath(metricPath)
      if (!normalized) continue
      let absolutePath = ''
      try {
        absolutePath = this.ensureSafeTargetPath(normalized)
      } catch {
        continue
      }
      if (!(await fileExists(absolutePath))) continue
      const raw = await readTextOrEmpty(absolutePath)
      if (!raw.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const flattened: Record<string, number> = {}
      this.flattenNumericMetrics(parsed, '', flattened)
      for (const [metricKey, metricValue] of Object.entries(flattened)) {
        values[`${normalized}:${metricKey}`] = metricValue
      }
    }
    return values
  }

  private async loadPreviousNorthStarScoreboard(maxTurnNumber: number): Promise<Record<string, number>> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .reverse()

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northStar = toPlainObject(parsed.northstar)
        const previousValues = toPlainObject(northStar?.scoreboard_values)
        if (!previousValues) continue
        const normalized: Record<string, number> = {}
        for (const [key, value] of Object.entries(previousValues)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            normalized[key] = value
          }
        }
        if (Object.keys(normalized).length > 0) return normalized
      } catch {
        continue
      }
    }

    return {}
  }

  private metricDirection(metricKey: string): 'up' | 'down' | 'neutral' {
    const normalized = normalizeText(metricKey)
    if (!normalized) return 'neutral'
    if (/(missing|todo|cite_needed|error|errors|fail|failed|latency|runtime|cost|regret|loss|violation)/.test(normalized)) {
      return 'down'
    }
    if (/(verified|coverage|pass|accuracy|auc|f1|precision|recall|score|quality|gain|improvement|uplist|success)/.test(normalized)) {
      return 'up'
    }
    if (/(claims_total|paper_claim_refs_total|\btotal\b|\bcount\b|\brows?\b|\bnum\b)/.test(normalized)) {
      return 'neutral'
    }
    return 'neutral'
  }

  private compareScoreboard(
    previous: Record<string, number>,
    current: Record<string, number>
  ): {
    ready: boolean
    improved: boolean
    regressed: boolean
    changedKeys: string[]
    improvedKeys: string[]
    regressedKeys: string[]
  } {
    const currentKeys = Object.keys(current)
    if (currentKeys.length === 0) {
      return {
        ready: false,
        improved: false,
        regressed: false,
        changedKeys: [],
        improvedKeys: [],
        regressedKeys: []
      }
    }

    if (Object.keys(previous).length === 0) {
      return {
        ready: true,
        improved: true,
        regressed: false,
        changedKeys: currentKeys,
        improvedKeys: currentKeys,
        regressedKeys: []
      }
    }

    const changedKeys: string[] = []
    const improvedKeys: string[] = []
    const regressedKeys: string[] = []

    for (const key of currentKeys) {
      const direction = this.metricDirection(key)
      if (!(key in previous)) {
        changedKeys.push(key)
        if (direction !== 'neutral') {
          improvedKeys.push(key)
        }
        continue
      }
      const before = previous[key]
      const after = current[key]
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue
      if (after === before) continue
      changedKeys.push(key)
      if (direction === 'neutral') continue
      if ((direction === 'up' && after > before) || (direction === 'down' && after < before)) {
        improvedKeys.push(key)
      } else if ((direction === 'up' && after < before) || (direction === 'down' && after > before)) {
        regressedKeys.push(key)
      }
    }

    return {
      ready: true,
      improved: improvedKeys.length > 0,
      regressed: regressedKeys.length > 0,
      changedKeys: dedupeStrings(changedKeys),
      improvedKeys: dedupeStrings(improvedKeys),
      regressedKeys: dedupeStrings(regressedKeys)
    }
  }

  private collectProjectEvidencePointers(project: TurnContext['project']): string[] {
    const collected = [
      ...project.keyArtifacts,
      ...project.facts.map((item) => item.evidencePath),
      ...project.constraints.map((item) => item.evidencePath),
      ...project.done.map((item) => item.evidencePath),
      ...project.claims.flatMap((item) => item.evidencePaths),
      ...project.planBoard.flatMap((item) => item.evidencePaths ?? [])
    ]
    return dedupeStrings(
      collected
        .map((entry) => this.normalizeProjectPathPointer(entry))
        .filter((entry) => Boolean(entry) && EVIDENCE_PATH_RE.test(entry))
    )
  }

  private extractClaimedEvidenceFromProjectUpdate(projectUpdate: Record<string, unknown>): string[] {
    const paths: string[] = []
    const pushPath = (candidate: unknown): void => {
      if (typeof candidate !== 'string') return
      const normalized = this.normalizeProjectPathPointer(candidate)
      if (!normalized || !EVIDENCE_PATH_RE.test(normalized)) return
      paths.push(normalized)
    }
    const readEvidencePathFromRows = (value: unknown): void => {
      if (!Array.isArray(value)) return
      for (const row of value) {
        const plain = toPlainObject(row)
        if (!plain) continue
        pushPath(plain.evidencePath)
      }
    }

    if (Array.isArray(projectUpdate.keyArtifacts)) {
      for (const row of projectUpdate.keyArtifacts) pushPath(row)
    }

    readEvidencePathFromRows(projectUpdate.facts)
    readEvidencePathFromRows(projectUpdate.constraints)
    readEvidencePathFromRows(projectUpdate.done)

    if (Array.isArray(projectUpdate.claims)) {
      for (const row of projectUpdate.claims) {
        const plain = toPlainObject(row)
        if (!plain || !Array.isArray(plain.evidencePaths)) continue
        for (const evidencePath of plain.evidencePaths) pushPath(evidencePath)
      }
    }

    if (Array.isArray(projectUpdate.planBoard)) {
      for (const row of projectUpdate.planBoard) {
        const plain = toPlainObject(row)
        if (!plain || !Array.isArray(plain.evidencePaths)) continue
        for (const evidencePath of plain.evidencePaths) pushPath(evidencePath)
      }
    }

    return dedupeStrings(paths)
  }

  private async loadClaimedEvidencePathsFromTurn(turnNumber: number): Promise<string[]> {
    const agentOutputPath = path.join(this.runsDir, formatTurnId(turnNumber), 'artifacts', 'agent-output.txt')
    if (!(await fileExists(agentOutputPath))) return []
    const raw = await readTextOrEmpty(agentOutputPath)
    if (!raw.trim()) return []
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const projectUpdate = toPlainObject(parsed.projectUpdate)
      if (!projectUpdate) return []
      return this.extractClaimedEvidenceFromProjectUpdate(projectUpdate)
    } catch {
      return []
    }
  }

  private async buildEvidenceTrustContext(input: {
    project: TurnContext['project']
    turnNumber: number
  }): Promise<{
      trustedEvidencePaths: string[]
      untrustedEvidenceHints: EvidenceTrustHint[]
    }> {
    const trusted: string[] = []
    const hintsByPath = new Map<string, EvidenceTrustHint>()
    const existenceCache = new Map<string, boolean>()

    const pathExists = async (pointer: string): Promise<boolean> => {
      if (existenceCache.has(pointer)) return existenceCache.get(pointer) === true
      const exists = await fileExists(path.join(this.yoloRoot, pointer))
      existenceCache.set(pointer, exists)
      return exists
    }

    const addHint = (hint: EvidenceTrustHint): void => {
      if (trusted.includes(hint.path)) return
      const existing = hintsByPath.get(hint.path)
      if (!existing) {
        hintsByPath.set(hint.path, hint)
        return
      }
      if (existing.state === 'claimed_only') return
      if (hint.state === 'claimed_only') {
        hintsByPath.set(hint.path, hint)
      }
    }

    const pointers = this.collectProjectEvidencePointers(input.project)
    for (const pointer of pointers) {
      if (await pathExists(pointer)) {
        trusted.push(pointer)
      } else {
        addHint({
          path: pointer,
          state: 'stale_or_missing',
          reason: 'Referenced in PROJECT state but file is currently missing.'
        })
      }
    }

    if (input.turnNumber > 1) {
      const previousTurn = input.turnNumber - 1
      const previousResultPath = path.join(this.runsDir, formatTurnId(previousTurn), 'result.json')
      const resultRaw = await readTextOrEmpty(previousResultPath)
      if (resultRaw.trim()) {
        try {
          const parsed = JSON.parse(resultRaw) as Record<string, unknown>
          const missedTouch = (
            normalizeText(parsed.status) === 'no_delta'
            && normalizeText(parsed.blocked_reason) === 'missing_plan_deliverable_touch'
          )
          if (missedTouch) {
            const claimed = await this.loadClaimedEvidencePathsFromTurn(previousTurn)
            for (const pointer of claimed) {
              if (await pathExists(pointer)) continue
              addHint({
                path: pointer,
                state: 'claimed_only',
                sourceTurn: previousTurn,
                reason: 'Claimed by previous no_delta turn; verify/create before treating as evidence.'
              })
            }
          }
        } catch {
          // Ignore malformed prior turn result rows.
        }
      }
    }

    return {
      trustedEvidencePaths: dedupeStrings(trusted).slice(0, MAX_TRUSTED_EVIDENCE_PATHS),
      untrustedEvidenceHints: Array.from(hintsByPath.values()).slice(0, MAX_UNTRUSTED_EVIDENCE_HINTS)
    }
  }

  private async runPreTurnCalibration(input: {
    project: TurnContext['project']
    turnNumber: number
  }): Promise<{ project: TurnContext['project']; notes: string[] }> {
    const candidate = input.project.planBoard
      .filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
      .sort((a, b) => a.priority - b.priority)
      .find((item) => item.status === 'ACTIVE')
      ?? input.project.planBoard
        .filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
        .sort((a, b) => a.priority - b.priority)[0]

    if (!candidate) return { project: input.project, notes: [] }

    const parsed = this.parseDoneDefinitionRules(candidate.doneDefinition ?? [])
    const retryAfterTouchMiss = await this.didPreviousTurnMissDeliverableTouch({
      turnNumber: input.turnNumber,
      activePlanId: candidate.id
    })
    if (!retryAfterTouchMiss && parsed.invalidRows.length === 0 && parsed.deliverables.length > 0) {
      return { project: input.project, notes: [] }
    }

    const inferredDeliverable = await this.inferPreflightDeliverableCandidate({
      project: input.project,
      activePlanId: candidate.id,
      turnNumber: input.turnNumber,
      fallbackText: candidate.nextMinStep ?? ''
    })
    if (!inferredDeliverable) {
      return { project: input.project, notes: [] }
    }

    const aligned = this.alignDoneDefinitionDeliverable(candidate.doneDefinition ?? [], inferredDeliverable)
    if (JSON.stringify(aligned) === JSON.stringify(candidate.doneDefinition ?? [])) {
      return { project: input.project, notes: [] }
    }

    await this.projectStore.applyUpdate({
      planBoard: [{
        id: candidate.id,
        title: candidate.title,
        status: candidate.status,
        doneDefinition: aligned,
        evidencePaths: [...(candidate.evidencePaths ?? [])],
        nextMinStep: candidate.nextMinStep,
        dropReason: candidate.dropReason,
        replacedBy: candidate.replacedBy ?? null,
        priority: candidate.priority
      }]
    })

    return {
      project: await this.projectStore.load(),
      notes: [`Preflight calibration: aligned ${candidate.id} done_definition -> deliverable: ${inferredDeliverable}`]
    }
  }

  private async didPreviousTurnMissDeliverableTouch(input: {
    turnNumber: number
    activePlanId: string
  }): Promise<boolean> {
    if (input.turnNumber <= 1) return false
    const previousResultPath = path.join(this.runsDir, formatTurnId(input.turnNumber - 1), 'result.json')
    const raw = await readTextOrEmpty(previousResultPath)
    if (!raw.trim()) return false
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return (
        normalizeText(parsed.status) === 'no_delta'
        && normalizeText(parsed.blocked_reason) === 'missing_plan_deliverable_touch'
        && normalizePlanId(parsed.active_plan_id) === input.activePlanId
      )
    } catch {
      return false
    }
  }

  private async inferPreflightDeliverableCandidate(input: {
    project: TurnContext['project']
    activePlanId: string
    turnNumber: number
    fallbackText: string
  }): Promise<string> {
    const prioritized: string[] = []
    const fallback: string[] = []

    if (input.turnNumber > 1) {
      const previousResultPath = path.join(this.runsDir, formatTurnId(input.turnNumber - 1), 'result.json')
      const raw = await readTextOrEmpty(previousResultPath)
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const evidencePaths = Array.isArray(parsed.evidence_paths)
            ? parsed.evidence_paths.filter((entry): entry is string => typeof entry === 'string')
            : []
          const deliverables = evidencePaths.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean)
          if (
            normalizePlanId(parsed.active_plan_id ?? '') === input.activePlanId
            && normalizeText(parsed.status) === 'no_delta'
            && normalizeText(parsed.blocked_reason) === 'missing_plan_deliverable_touch'
          ) {
            prioritized.push(...deliverables)
          } else {
            fallback.push(...deliverables)
          }
        } catch {
          // Ignore malformed previous result rows.
        }
      }
    }

    const fromPlanEvidence = input.project.planBoard
      .find((item) => item.id === input.activePlanId)
      ?.evidencePaths
      ?? []
    fallback.push(...fromPlanEvidence.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean))
    fallback.push(...(input.project.keyArtifacts ?? []).map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean))

    const hinted = this.extractDeliverableHintsFromText(input.fallbackText)
    fallback.push(...hinted)

    return dedupeStrings([...prioritized, ...fallback])[0] || ''
  }

  private extractDeliverableHintsFromText(raw: string): string[] {
    if (!raw.trim()) return []
    const matches = raw.match(/artifacts\/[a-z0-9_./-]+/gi) ?? []
    return dedupeStrings(matches.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean))
  }

  private async resolveRuntimeVersionInfo(): Promise<RuntimeVersionInfo> {
    if (!this.runtimeVersionInfoPromise) {
      this.runtimeVersionInfoPromise = (async () => {
        const modulePath = fileURLToPath(import.meta.url)
        const moduleDir = path.dirname(modulePath)
        const repoRoot = path.resolve(moduleDir, '..', '..', '..')

        let packageVersion = ''
        try {
          const packageRaw = await readTextOrEmpty(path.join(repoRoot, 'package.json'))
          if (packageRaw.trim()) {
            const parsed = JSON.parse(packageRaw) as Record<string, unknown>
            packageVersion = safeString(parsed.version).trim()
          }
        } catch {
          packageVersion = ''
        }

        let gitCommit = ''
        try {
          const { stdout } = await execFile('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'])
          gitCommit = stdout.trim()
        } catch {
          gitCommit = ''
        }

        let buildTime = ''
        try {
          const stat = await fs.stat(modulePath)
          buildTime = stat.mtime.toISOString()
        } catch {
          buildTime = ''
        }

        return {
          packageVersion,
          gitCommit,
          buildTime,
          desktopVersion: safeString((process as unknown as { versions?: Record<string, string> }).versions?.electron).trim(),
          nodeVersion: process.version
        }
      })()
    }

    return this.runtimeVersionInfoPromise
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

  async submitUserInput(text: string): Promise<QueuedUserInput> {
    await this.init()

    const normalized = text.trim()
    if (!normalized) {
      throw new Error('User input text is required')
    }

    const queue = await this.loadQueuedUserInputs()
    const item: QueuedUserInput = {
      id: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: normalized,
      submittedAt: toIso(this.now)
    }

    queue.push(item)
    await this.saveQueuedUserInputs(queue)
    return item
  }

  private normalizeNativeStatus(status: unknown): TurnStatus {
    const normalized = typeof status === 'string' ? status.trim().toLowerCase() : ''
    if (normalized === 'success') return 'success'
    if (normalized === 'no_delta') return 'no_delta'
    if (normalized === 'blocked') return 'blocked'
    if (normalized === 'ask_user') return 'ask_user'
    if (normalized === 'stopped') return 'stopped'
    return 'failure'
  }

  private async discoverWorkspaceGitRepos(): Promise<string[]> {
    const projectRoot = path.resolve(this.config.projectPath)
    const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: projectRoot, rel: '.', depth: 0 }]
    const found: string[] = []

    while (queue.length > 0 && found.length < REPO_SCAN_MAX_RESULTS) {
      const current = queue.shift()!
      if (current.depth > REPO_SCAN_MAX_DEPTH) continue

      if (current.depth > 0) {
        const gitPath = path.join(current.abs, '.git')
        try {
          const details = await fs.stat(gitPath)
          if (details.isDirectory() || details.isFile()) {
            found.push(current.rel)
            continue
          }
        } catch {
          // Not a git repo root.
        }
      }

      if (current.depth >= REPO_SCAN_MAX_DEPTH) continue

      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(current.abs, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (REPO_SCAN_SKIP_DIRS.has(entry.name)) continue
        const nextAbs = path.join(current.abs, entry.name)
        const nextRel = current.rel === '.'
          ? entry.name
          : `${current.rel}/${entry.name}`
        queue.push({ abs: nextAbs, rel: toPosixPath(nextRel), depth: current.depth + 1 })
      }
    }

    if (await fileExists(path.join(projectRoot, '.git'))) {
      return dedupeStrings(['.', ...found])
    }

    return dedupeStrings(found)
  }

  private inferPrimaryActionFromToolEvents(toolEvents: ToolEventRecord[]): string {
    const calls = toolEvents
      .filter((event) => event.phase === 'call')
      .slice(-3)
      .map((event) => {
        const tool = event.tool?.trim() || 'tool'
        const input = toPlainObject(event.input)
        if (!input) return tool
        const command = safeString(input.command).trim()
        const targetPath = safeString(input.path).trim()
        const url = safeString(input.url).trim()
        if (command) return `${tool}: ${command}`
        if (targetPath) return `${tool}: ${targetPath}`
        if (url) return `${tool}: ${url}`
        return tool
      })
      .filter(Boolean)

    if (calls.length === 0) return 'agent.run'
    return calls.join(' | ')
  }

  private extractLastBashSnapshot(toolEvents: ToolEventRecord[], runtime: string): {
    cmd: string
    cwd: string
    stdout: string
    stderr: string
    exitCode: number
    runtime: string
  } | null {
    let lastCommand = ''
    let lastCwd = this.config.projectPath
    let snapshot: {
      cmd: string
      cwd: string
      stdout: string
      stderr: string
      exitCode: number
      runtime: string
    } | null = null

    for (const event of toolEvents) {
      const tool = normalizeText(event.tool || '')
      if (tool !== 'bash') continue

      if (event.phase === 'call') {
        const input = toPlainObject(event.input)
        const command = safeString(input?.command).trim()
        const cwd = safeString(input?.cwd).trim()
        if (command) lastCommand = command
        if (cwd) {
          try {
            lastCwd = this.ensureSafeTargetPath(cwd)
          } catch {
            lastCwd = this.config.projectPath
          }
        }
        continue
      }

      const result = toPlainObject(event.result)
      const data = toPlainObject(result?.data)
      const stdout = safeString(data?.stdout)
      const stderr = safeString(data?.stderr, safeString(result?.error))
      const exitCode = typeof data?.exitCode === 'number'
        ? data.exitCode
        : (event.success === true ? 0 : 1)

      snapshot = {
        cmd: lastCommand || 'bash',
        cwd: lastCwd || this.config.projectPath,
        stdout,
        stderr,
        exitCode,
        runtime
      }
    }

    return snapshot
  }

  private classifyRuntimeFailure(input: {
    tool: string
    exitCode: number | null
    stdout: string
    stderr: string
    errorText: string
    skillId?: string
    skillScript?: string
    structuredStatus?: string
  }): RuntimeFailureKind {
    const tool = normalizeText(input.tool)
    const stdout = input.stdout.trim()
    const stderr = input.stderr.trim()
    const errorText = input.errorText.trim()
    const hasOutput = Boolean(stdout || stderr)
    const hasExitCode = typeof input.exitCode === 'number'

    if (tool === 'bash') {
      if (hasOutput || (hasExitCode && input.exitCode !== 0)) {
        return 'command_failure'
      }
      if (TOOL_LAYER_FAILURE_RE.test(errorText)) {
        return 'tool_invocation_failure'
      }
      return 'tool_invocation_failure'
    }

    if (tool === 'skill-script-run') {
      const joint = `${errorText}\n${stderr}\n${stdout}`.trim()
      const skillId = normalizeText(input.skillId || '')
      const skillScript = normalizeText(input.skillScript || '')
      const structuredStatus = normalizeText(input.structuredStatus || '')

      if (skillId === 'coding-large-repo' && skillScript === 'agent-run-to-completion') {
        if (input.exitCode === 143 || structuredStatus === 'running') {
          return 'command_failure'
        }
        if (/\bunknown argument|invalid --|no_delta:|agent session failed|verify-targets failed|max-wait-sec\b/i.test(joint)) {
          return 'command_failure'
        }
      }

      if (TOOL_LAYER_FAILURE_RE.test(joint)) {
        return 'tool_invocation_failure'
      }
      return 'unknown_failure'
    }

    const joint = `${errorText}\n${stderr}\n${stdout}`.trim()
    if (TOOL_LAYER_FAILURE_RE.test(joint)) {
      return 'tool_invocation_failure'
    }
    return 'unknown_failure'
  }

  private buildFailureExcerpt(input: {
    stdout: string
    stderr: string
    errorText: string
  }): string {
    const stderrLine = firstNonEmptyLine(input.stderr)
    const stdoutLine = firstNonEmptyLine(input.stdout)
    const errorLine = firstNonEmptyLine(input.errorText)
    let primary = stderrLine || stdoutLine || errorLine || input.errorText || 'Tool reported failure.'
    if (/script exited with code 143/i.test(input.errorText)) {
      primary = 'Script exited with code 143 (wrapper timeout/termination).'
    } else if (stderrLine && /unknown argument|error:|no_delta:|agent session failed|verify-targets failed|max-wait-sec/i.test(stderrLine)) {
      primary = stderrLine
    }
    return clipText(primary.replace(/\s+/g, ' ').trim(), 260)
  }

  private extractLatestFailureSnapshot(toolEvents: ToolEventRecord[]): RuntimeFailureSnapshot | null {
    const lastCallByTool = new Map<string, {
      cmd: string
      cwd: string
      skillId: string
      skillScript: string
      skillArgs: string[]
      toolTimeoutMs: number | null
    }>()
    let latest: RuntimeFailureSnapshot | null = null

    for (const event of toolEvents) {
      const toolRaw = event.tool?.trim() || 'tool'
      const tool = normalizeText(toolRaw) || 'tool'

      if (event.phase === 'call') {
        const input = toPlainObject(event.input)
        const command = safeString(input?.command).trim()
        const targetPath = safeString(input?.path).trim()
        const url = safeString(input?.url).trim()
        const cwdRaw = safeString(input?.cwd).trim()
        const skillId = safeString(input?.skillId).trim()
        const skillScript = safeString(input?.script).trim()
        const skillArgs = this.extractScriptArgs(input?.args)
        const toolTimeoutMs = typeof input?.timeout === 'number' && Number.isFinite(input.timeout)
          ? Math.max(0, Math.floor(input.timeout))
          : null
        const skillCmd = (
          tool === 'skill-script-run' && (skillId || skillScript)
            ? `${toolRaw}:${skillId || 'unknown'}/${skillScript || 'unknown'}`
            : ''
        )
        let cwd = this.config.projectPath
        if (cwdRaw) {
          try {
            cwd = this.ensureSafeTargetPath(cwdRaw)
          } catch {
            cwd = this.config.projectPath
          }
        }
        lastCallByTool.set(tool, {
          cmd: command || skillCmd || targetPath || url || toolRaw,
          cwd,
          skillId,
          skillScript,
          skillArgs,
          toolTimeoutMs
        })
        continue
      }

      if (event.phase !== 'result') continue
      const result = toPlainObject(event.result)
      const success = typeof event.success === 'boolean'
        ? event.success
        : (typeof result?.success === 'boolean' ? result.success : undefined)
      if (success !== false) continue

      const data = toPlainObject(result?.data)
      const structured = toPlainObject(data?.structuredResult)
      const stdout = safeString(data?.stdout)
      const stderr = safeString(data?.stderr)
      const errorText = safeString(result?.error, safeString(event.error)).trim()
      const exitCode = typeof data?.exitCode === 'number' ? data.exitCode : null
      const hasOutput = Boolean(stdout.trim() || stderr.trim())
      const lastCall = lastCallByTool.get(tool)
      const cmd = lastCall?.cmd?.trim() || toolRaw
      const cwd = lastCall?.cwd || this.config.projectPath
      const sessionIdFromOutput = (
        `${stdout}\n${stderr}`.match(/(?:^|\n)\s*session_id:\s*([^\s]+)/i)?.[1] || ''
      ).trim()
      const logPathFromOutput = (
        `${stdout}\n${stderr}`.match(/(?:^|\n)\s*(?:agent_)?log_path:\s*([^\s]+)/i)?.[1] || ''
      ).trim()
      const sessionId = safeString(structured?.session_id).trim()
        || this.extractScriptArgValue(lastCall?.skillArgs ?? [], '--session-id')
        || sessionIdFromOutput
      const logPath = safeString(structured?.log_path, safeString(structured?.agent_log_path)).trim()
        || logPathFromOutput
      const deliverable = this.extractScriptArgValue(lastCall?.skillArgs ?? [], '--deliverable')
      const structuredStatus = normalizeText(safeString(structured?.status).trim())
      const failureKind = this.classifyRuntimeFailure({
        tool: toolRaw,
        exitCode,
        stdout,
        stderr,
        errorText,
        skillId: lastCall?.skillId || '',
        skillScript: lastCall?.skillScript || '',
        structuredStatus
      })
      let errorExcerpt = this.buildFailureExcerpt({
        stdout,
        stderr,
        errorText
      })
      const structuredError = safeString(structured?.error).trim()
      if (structuredError) {
        errorExcerpt = clipText(structuredError, 260)
      } else if (
        failureKind === 'command_failure'
        && normalizeText(lastCall?.skillId || '') === 'coding-large-repo'
        && normalizeText(lastCall?.skillScript || '') === 'agent-run-to-completion'
        && exitCode === 143
      ) {
        const sessionLabel = sessionId || 'coding-agent session'
        errorExcerpt = `wrapper timeout/termination (exit 143) while ${sessionLabel} was still running`
      }

      latest = {
        tool: toolRaw,
        cmd,
        cwd,
        exitCode,
        stdout,
        stderr,
        errorText,
        errorExcerpt,
        hasOutput,
        failureKind,
        skillId: lastCall?.skillId || undefined,
        skillScript: lastCall?.skillScript || undefined,
        skillArgs: lastCall?.skillArgs?.length ? [...lastCall.skillArgs] : undefined,
        toolTimeoutMs: lastCall?.toolTimeoutMs ?? undefined,
        sessionId: sessionId || undefined,
        logPath: logPath || undefined,
        deliverable: deliverable || undefined,
        structuredStatus: structuredStatus || undefined
      }
    }

    return latest
  }

  private async reconcileCodingLargeRepoTimeoutFailure(input: {
    finalStatus: TurnStatus
    latestFailure: RuntimeFailureSnapshot | null
    turnStartedAt: Date
  }): Promise<{
    recovered: boolean
    summaryNote: string
    latestFailure: RuntimeFailureSnapshot | null
    exitCode: number | null
  }> {
    const latestFailure = input.latestFailure
    if (!latestFailure || input.finalStatus !== 'ask_user') {
      return {
        recovered: false,
        summaryNote: '',
        latestFailure,
        exitCode: null
      }
    }

    if (
      normalizeText(latestFailure.tool) !== 'skill-script-run'
      || normalizeText(latestFailure.skillId || '') !== 'coding-large-repo'
      || normalizeText(latestFailure.skillScript || '') !== 'agent-run-to-completion'
      || latestFailure.exitCode !== 143
    ) {
      return {
        recovered: false,
        summaryNote: '',
        latestFailure,
        exitCode: null
      }
    }

    const waitBudgetMs = Number.parseInt(process.env.YOLO_CODING_RECONCILE_WAIT_MS || '', 10)
    const maxWaitMs = Number.isFinite(waitBudgetMs) && waitBudgetMs >= 0
      ? waitBudgetMs
      : CODING_AGENT_TIMEOUT_RECONCILE_MAX_WAIT_MS
    const pollEveryMs = CODING_AGENT_TIMEOUT_RECONCILE_POLL_MS
    const deadline = Date.now() + maxWaitMs
    const sessionId = latestFailure.sessionId?.trim() || ''
    const deliverableRaw = latestFailure.deliverable?.trim() || ''
    const deliverableAbs = deliverableRaw
      ? (path.isAbsolute(deliverableRaw) ? deliverableRaw : path.join(this.yoloRoot, deliverableRaw))
      : ''
    const turnStartedMs = input.turnStartedAt.getTime()

    while (true) {
      let sessionExitCode: number | null = null
      if (sessionId) {
        const exitCodePath = path.join(
          this.yoloRoot,
          '.yolo-researcher',
          'tmp',
          'coding-large-repo',
          'agent-sessions',
          sessionId,
          'exit_code'
        )
        if (await fileExists(exitCodePath)) {
          const raw = (await readTextOrEmpty(exitCodePath)).trim()
          const parsed = Number.parseInt(raw, 10)
          if (Number.isFinite(parsed)) sessionExitCode = parsed
        }
      }

      let deliverableTouched = false
      if (deliverableAbs && await fileExists(deliverableAbs)) {
        try {
          const stat = await fs.stat(deliverableAbs)
          deliverableTouched = stat.mtimeMs >= turnStartedMs
        } catch {
          deliverableTouched = false
        }
      }

      if (sessionExitCode === 0 && deliverableTouched) {
        return {
          recovered: true,
          summaryNote: 'Recovered from wrapper timeout: coding-large-repo session completed and deliverable was touched.',
          latestFailure: null,
          exitCode: 0
        }
      }

      if (Date.now() >= deadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, pollEveryMs))
    }

    return {
      recovered: false,
      summaryNote: '',
      latestFailure,
      exitCode: null
    }
  }

  private stripContradictoryAskClaims(input: {
    text: string
    hasOutput: boolean
    hasLogPath: boolean
  }): string {
    const text = input.text
    const trimmed = text.trim()
    if (!trimmed) return ''
    if (input.hasOutput && NO_OUTPUT_ASSERTION_RE.test(trimmed)) return ''
    if (input.hasLogPath && NO_LOG_ASSERTION_RE.test(trimmed)) return ''
    return trimmed
  }

  private buildRuntimeAskUserPayload(input: {
    modelSummary: string
    modelQuestion: string
    latestFailure: RuntimeFailureSnapshot | null
  }): {
    markdown: string
    summary: string
    question: string
  } {
    const modelSummary = input.modelSummary.trim()
    const modelQuestion = input.modelQuestion.trim()
    const latestFailure = input.latestFailure

    if (!latestFailure) {
      const question = modelQuestion || modelSummary || 'User input required to proceed.'
      return {
        markdown: `# Blocking Question\n\n${question}\n`,
        summary: modelSummary || 'User input required to proceed.',
        question
      }
    }

    const cleanSummary = this.stripContradictoryAskClaims({
      text: modelSummary,
      hasOutput: latestFailure.hasOutput,
      hasLogPath: Boolean(latestFailure.logPath)
    })
    const cleanQuestion = this.stripContradictoryAskClaims({
      text: modelQuestion,
      hasOutput: latestFailure.hasOutput,
      hasLogPath: Boolean(latestFailure.logPath)
    })
    const contradictionFiltered = (
      (modelSummary && !cleanSummary)
      || (modelQuestion && !cleanQuestion)
    )

    let defaultQuestion = 'Please provide the minimal environment detail needed to unblock execution.'
    if (latestFailure.failureKind === 'command_failure') {
      defaultQuestion = 'This is a command/test failure (not a bash tool invocation failure). Choose one next step: fix dependency/environment, narrow/skip failing scope, or provide an alternative verification command.'
    } else if (latestFailure.failureKind === 'tool_invocation_failure') {
      defaultQuestion = 'This appears to be a tool/runtime invocation failure. Confirm runtime permissions/policies (or provide an alternative execution route) so execution can continue.'
    }

    const exitText = typeof latestFailure.exitCode === 'number'
      ? ` (exit ${latestFailure.exitCode})`
      : ''
    const baseSummary = `Paused: ${latestFailure.failureKind} on "${latestFailure.cmd}"${exitText}. Error: ${latestFailure.errorExcerpt}`
    const summary = clipText(
      cleanSummary && cleanSummary.toLowerCase() !== baseSummary.toLowerCase()
        ? `${baseSummary} ${cleanSummary}`
        : baseSummary,
      420
    )
    const question = cleanQuestion
      ? `${defaultQuestion}\n\nAgent note: ${cleanQuestion}`
      : defaultQuestion

    const lines = [
      '# Blocking Question',
      '',
      '## Runtime Failure Summary (auto-generated)',
      `- classification: ${latestFailure.failureKind}`,
      `- tool: ${latestFailure.tool}`,
      `- last_failed_cmd: ${latestFailure.cmd}`,
      `- skill_id: ${latestFailure.skillId || '(none)'}`,
      `- script: ${latestFailure.skillScript || '(none)'}`,
      `- session_id: ${latestFailure.sessionId || '(none)'}`,
      `- exit_code: ${typeof latestFailure.exitCode === 'number' ? latestFailure.exitCode : '(none)'}`,
      `- error_excerpt: ${latestFailure.errorExcerpt}`,
      `- output_captured: ${latestFailure.hasOutput ? 'yes' : 'no'}`,
      `- log_path: ${latestFailure.logPath || '(none)'}`,
      '',
      '## Requested Input',
      defaultQuestion,
      ...(cleanQuestion ? ['', '## Agent Supplement (optional)', cleanQuestion] : []),
      ''
    ]

    if (contradictionFiltered) {
      lines.push('## Runtime Note')
      lines.push('- Agent-provided contradictory no-output/no-log claim was dropped because runtime evidence includes stdout/stderr or log paths.')
      lines.push('')
    }

    return {
      markdown: `${lines.join('\n')}\n`,
      summary,
      question
    }
  }

  private normalizeActionFingerprintSegment(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/["'`]/g, '')
      .trim()
      .slice(0, 240)
  }

  private normalizeUrlForFingerprint(rawUrl: string): string {
    const input = rawUrl.trim()
    if (!input) return ''
    try {
      const url = new URL(input)
      const params = [...url.searchParams.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 8)
      const compactQuery = params.map(([k, v]) => `${k}=${v}`).join('&')
      const joined = `${url.hostname}${url.pathname}${compactQuery ? `?${compactQuery}` : ''}`
      return this.normalizeActionFingerprintSegment(joined)
    } catch {
      return this.normalizeActionFingerprintSegment(input)
    }
  }

  private buildActionFingerprint(input: {
    toolEvents: ToolEventRecord[]
    primaryAction: string
    cmd: string
  }): string {
    let actionType = 'agent'
    let target = input.primaryAction || input.cmd || 'agent.run'

    for (let idx = input.toolEvents.length - 1; idx >= 0; idx -= 1) {
      const event = input.toolEvents[idx]
      if (event.phase !== 'call') continue
      const tool = (event.tool || '').trim()
      if (!tool) continue
      actionType = normalizeText(tool) || 'agent'

      const row = toPlainObject(event.input)
      const command = safeString(row?.command).trim()
      const pathValue = safeString(row?.path).trim()
      const url = safeString(row?.url).trim()
      if (actionType === 'fetch' && url) {
        target = this.normalizeUrlForFingerprint(url)
      } else if (command) {
        target = this.normalizeActionFingerprintSegment(command)
      } else if (pathValue) {
        target = this.normalizeActionFingerprintSegment(pathValue)
      } else if (url) {
        target = this.normalizeUrlForFingerprint(url)
      } else if (input.primaryAction) {
        const [head, tail] = input.primaryAction.split(':', 2)
        if (tail) {
          target = this.normalizeActionFingerprintSegment(tail)
        } else if (head) {
          target = this.normalizeActionFingerprintSegment(head)
        }
      }
      break
    }

    if (!target.trim()) {
      target = this.normalizeActionFingerprintSegment(input.cmd || input.primaryAction || 'agent.run')
    }

    const normalizedTarget = this.normalizeActionFingerprintSegment(target || 'agent.run')
    return `${actionType}:${normalizedTarget}`.slice(0, 320)
  }

  private isSystemArtifactFile(fileName: string): boolean {
    if (SYSTEM_ARTIFACT_NAMES.has(fileName)) return true
    return /^user-input-\d{2}-.+\.md$/i.test(fileName)
  }

  private async collectBusinessArtifactEvidencePaths(artifactsDir: string): Promise<string[]> {
    if (!(await fileExists(artifactsDir))) return []

    const paths: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativeFromArtifacts = toPosixPath(path.relative(artifactsDir, fullPath))
        if (
          relativeFromArtifacts === 'workspace'
          || relativeFromArtifacts.startsWith('workspace/')
          || relativeFromArtifacts.includes('/.git/')
          || relativeFromArtifacts.startsWith('.git/')
        ) {
          continue
        }
        if (entry.isDirectory()) {
          await walk(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        if (this.isSystemArtifactFile(entry.name)) continue
        paths.push(this.toEvidencePath(fullPath))
      }
    }

    await walk(artifactsDir)

    return paths
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_BUSINESS_ARTIFACT_EVIDENCE_PATHS)
  }

  private async collectArtifactEntryNames(artifactsDir: string): Promise<string[]> {
    if (!(await fileExists(artifactsDir))) return []
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true })
    return entries
      .filter((entry) => !this.isSystemArtifactFile(entry.name))
      .map((entry) => entry.name)
  }

  private extractDeliverablePatternsFromEntries(entryNames: string[]): Set<string> {
    const found = new Set<string>()
    for (const name of entryNames) {
      const lower = name.toLowerCase()
      for (const pattern of DELIVERABLE_PATTERNS) {
        if (lower.includes(pattern)) found.add(pattern)
      }
    }
    return found
  }

  private async countRecentActionFingerprintMatches(fingerprint: string, window: number = REDUNDANCY_WINDOW_TURNS): Promise<number> {
    const normalizedFingerprint = normalizeText(fingerprint)
    if (!normalizedFingerprint) return 0

    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers.slice(-Math.max(0, window))
    let count = 0

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const value = normalizeText(parsed.action_fingerprint)
        if (value && value === normalizedFingerprint) count += 1
      } catch {
        // Ignore malformed result rows.
      }
    }

    return count
  }

  private normalizeProjectPathPointer(rawPath: string): string {
    const input = rawPath.trim()
    if (!input) return ''

    const parsedArtifactUri = parseArtifactUri(input)
    if (parsedArtifactUri) {
      if (parsedArtifactUri.scope === 'project') return ''
      const suffix = parsedArtifactUri.suffix
      const invalidSuffix = (
        !suffix
        || suffix === '..'
        || suffix.startsWith('../')
        || suffix.includes('/../')
        || suffix.endsWith('/..')
      )

      if (!this.activeTurnArtifactsDirRel) return ''
      if (invalidSuffix || suffix === '.') {
        return this.activeTurnArtifactsDirRel
      }
      return `${this.activeTurnArtifactsDirRel}/${suffix}`
    }

    let normalized = toPosixPath(input.replace(/^\.\//, ''))

    if (path.isAbsolute(input)) {
      const relToYolo = toPosixPath(path.relative(this.yoloRoot, input))
      if (relToYolo && !relToYolo.startsWith('../') && relToYolo !== '..') {
        normalized = relToYolo
      } else {
        const relToProject = toPosixPath(path.relative(this.config.projectPath, input))
        if (relToProject && !relToProject.startsWith('../') && relToProject !== '..') {
          normalized = relToProject
        }
      }
    }

    return normalized
  }

  private normalizeDeliverableTarget(rawValue: string): { value: string; rewritten: boolean } {
    const pointer = this.normalizeProjectPathPointer(rawValue)
    const normalized = toPosixPath(pointer.trim().replace(/^\.\//, '')).toLowerCase()
    if (!normalized) return { value: '', rewritten: false }

    const scoped = TURN_SCOPED_DELIVERABLE_RE.exec(normalized)
    if (scoped?.[2]) {
      return {
        value: scoped[2],
        rewritten: true
      }
    }

    return { value: normalized, rewritten: false }
  }

  private normalizeDoneDefinitionRows(input: {
    lines: string[]
    planId: string
    notes: string[]
  }): string[] {
    const normalizedRows: string[] = []
    const normalizedPlanId = normalizePlanId(input.planId) || input.planId || 'P?'
    let evidenceMinSeen = false

    for (const rawLine of input.lines) {
      const line = rawLine.trim()
      if (!line) continue

      if (/^evidence_min\s*:/i.test(line)) {
        const rawValue = line.split(':').slice(1).join(':').trim()
        const parsed = Number.parseInt(rawValue, 10)
        if (!Number.isFinite(parsed) || parsed < 1) {
          input.notes.push(`Plan ${normalizedPlanId} done_definition dropped invalid evidence_min row: ${line}`)
          continue
        }
        normalizedRows.push(`evidence_min: ${parsed}`)
        evidenceMinSeen = true
        continue
      }

      if (!/^deliverables?\s*:/i.test(line)) {
        input.notes.push(`Plan ${normalizedPlanId} done_definition dropped non-mechanical row: ${line}`)
        continue
      }

      const rawValue = line.split(':').slice(1).join(':').trim()
      const normalized = this.normalizeDeliverableTarget(rawValue)
      if (!normalized.value) {
        normalizedRows.push(line)
        continue
      }

      if (normalized.rewritten) {
        input.notes.push(
          `Plan ${normalizedPlanId} done_definition deliverable normalized to turn-local path: ${normalized.value}`
        )
      }
      normalizedRows.push(`deliverable: ${normalized.value}`)
    }

    if (!evidenceMinSeen && normalizedRows.some((row) => /^deliverable\s*:/i.test(row))) {
      normalizedRows.push('evidence_min: 1')
    }

    return normalizedRows
  }

  private inferDeliverableCandidatesForMicroCheckpoint(input: {
    workspaceWriteTouches: string[]
    businessArtifactEvidencePaths: string[]
    planEvidencePaths: string[]
  }): string[] {
    return dedupeStrings([
      ...input.workspaceWriteTouches.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean),
      ...input.businessArtifactEvidencePaths.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean),
      ...input.planEvidencePaths.map((entry) => this.toDeliverableCandidate(entry)).filter(Boolean)
    ])
  }

  private toDeliverableCandidate(rawPath: string): string {
    const normalized = this.normalizeProjectPathPointer(rawPath).toLowerCase()
    if (!normalized) return ''
    const scoped = TURN_SCOPED_DELIVERABLE_RE.exec(normalized)
    const deliverable = scoped?.[2] ? scoped[2] : normalized
    if (!deliverable.startsWith('artifacts/')) return ''

    const base = path.posix.basename(deliverable)
    if (SYSTEM_ARTIFACT_NAMES.has(base)) return ''
    if (/^planning_checkpoint_.*\.md$/i.test(base)) return ''
    if (deliverable.startsWith('artifacts/evidence/')) return ''

    return deliverable
  }

  private alignDoneDefinitionDeliverable(doneDefinition: string[], deliverable: string): string[] {
    const normalizedTarget = this.normalizeDeliverableTarget(deliverable).value
    if (!normalizedTarget) return doneDefinition

    const parsed = this.parseDoneDefinitionRules(doneDefinition)
    const deliverables = dedupeStrings([
      normalizedTarget,
      ...parsed.deliverables.filter((item) => item !== normalizedTarget)
    ])
    const evidenceMin = Number.isFinite(parsed.evidenceMin) && parsed.evidenceMin >= 1
      ? parsed.evidenceMin
      : 1

    return [
      ...deliverables.map((item) => `deliverable: ${item}`),
      `evidence_min: ${evidenceMin}`
    ]
  }

  private collectWorkspaceWriteTouches(toolEvents: ToolEventRecord[]): string[] {
    const touched: string[] = []
    for (const event of toolEvents) {
      if (event.phase !== 'call') continue
      const tool = normalizeText(event.tool || '')
      if (tool !== 'write' && tool !== 'edit') continue
      const input = toPlainObject(event.input)
      const rawPath = safeString(input?.path).trim()
      if (!rawPath) continue
      const normalized = this.normalizeProjectPathPointer(rawPath)
      if (!normalized) continue
      touched.push(toPosixPath(normalized))
    }
    return dedupeStrings(touched)
  }

  private normalizeCommandForMatch(rawCommand: string): string {
    return normalizeText(rawCommand)
      .replace(/^bash:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private isVerifyCommandMatch(observedCommand: string, verifyCommand: string): boolean {
    const observed = this.normalizeCommandForMatch(observedCommand)
    const verify = this.normalizeCommandForMatch(verifyCommand)
    if (!observed || !verify) return false
    if (observed === verify) return true
    if (observed.includes(verify)) return true
    if (verify.length >= 16 && verify.includes(observed)) return true
    return false
  }

  private evaluateVerifyCommandFromToolEvents(toolEvents: ToolEventRecord[], verifyCmd: string): {
    executed: boolean
    succeeded: boolean
  } {
    if (!verifyCmd.trim()) {
      return {
        executed: false,
        succeeded: false
      }
    }

    let lastBashCallCommand = ''
    let executed = false
    let succeeded = false

    for (const event of toolEvents) {
      const tool = normalizeText(event.tool || '')
      if (tool !== 'bash') continue

      if (event.phase === 'call') {
        const input = toPlainObject(event.input)
        const command = safeString(input?.command).trim()
        if (command) {
          lastBashCallCommand = command
        }
        continue
      }
      if (event.phase !== 'result') continue

      const resultInput = toPlainObject(event.input)
      const command = safeString(resultInput?.command).trim() || lastBashCallCommand || 'bash'
      if (!this.isVerifyCommandMatch(command, verifyCmd)) continue
      executed = true

      const result = toPlainObject(event.result)
      const data = toPlainObject(result?.data)
      const successFlag = typeof event.success === 'boolean'
        ? event.success
        : (typeof result?.success === 'boolean' ? result.success : undefined)
      const exitCode = typeof data?.exitCode === 'number'
        ? data.exitCode
        : (successFlag === true ? 0 : 1)

      if (successFlag === true && exitCode === 0) {
        succeeded = true
      }
    }

    return {
      executed,
      succeeded
    }
  }

  private evaluateRealityCheckFromToolEvents(toolEvents: ToolEventRecord[], commands: string[]): {
    executedCommands: string[]
    succeededCommands: string[]
  } {
    if (commands.length === 0) {
      return {
        executedCommands: [],
        succeededCommands: []
      }
    }

    const executed = new Set<string>()
    const succeeded = new Set<string>()
    let lastBashCallCommand = ''

    for (const event of toolEvents) {
      const tool = normalizeText(event.tool || '')
      if (tool !== 'bash') continue

      if (event.phase === 'call') {
        const input = toPlainObject(event.input)
        const command = safeString(input?.command).trim()
        if (command) lastBashCallCommand = command
        continue
      }
      if (event.phase !== 'result') continue

      const resultInput = toPlainObject(event.input)
      const observedCommand = safeString(resultInput?.command).trim() || lastBashCallCommand || 'bash'
      const matchedCommands = commands.filter((command) => this.isVerifyCommandMatch(observedCommand, command))
      if (matchedCommands.length === 0) continue

      const result = toPlainObject(event.result)
      const data = toPlainObject(result?.data)
      const successFlag = typeof event.success === 'boolean'
        ? event.success
        : (typeof result?.success === 'boolean' ? result.success : undefined)
      const exitCode = typeof data?.exitCode === 'number'
        ? data.exitCode
        : (successFlag === true ? 0 : 1)
      const turnSucceeded = successFlag === true && exitCode === 0

      for (const matched of matchedCommands) {
        executed.add(matched)
        if (turnSucceeded) {
          succeeded.add(matched)
        }
      }
    }

    return {
      executedCommands: Array.from(executed.values()),
      succeededCommands: Array.from(succeeded.values())
    }
  }

  private async loadPreviousNorthStarGateSatisfied(maxTurnNumber: number): Promise<boolean | null> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .reverse()

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northStar = toPlainObject(parsed.northstar)
        if (typeof northStar?.gate_satisfied === 'boolean') {
          return northStar.gate_satisfied
        }
      } catch {
        continue
      }
    }
    return null
  }

  private buildEmptyNorthStarPathSnapshot(pathValue: string): NorthStarPathSnapshot {
    return {
      path: pathValue,
      exists: false,
      hash: '__missing__',
      semanticHash: '__missing__',
      stableSemanticHash: '__missing__',
      significantBytes: 0,
      contentKind: 'missing',
      textExcerpt: '',
      mtimeMs: 0,
      lineCount: 0,
      nonEmptyLineCount: 0,
      csvRowCount: 0,
      csvColumnCount: 0,
      claimsStatusCounts: {},
      claimsStatusColumnPresent: false
    }
  }

  private parseCsvRow(line: string): string[] {
    const cells: string[] = []
    let current = ''
    let quoted = false

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = !quoted
        }
        continue
      }

      if (char === ',' && !quoted) {
        cells.push(current.trim())
        current = ''
        continue
      }

      current += char
    }
    cells.push(current.trim())
    return cells
  }

  private summarizeNorthStarTextStructure(input: {
    content: string
    normalizedPath: string
  }): {
    lineCount: number
    nonEmptyLineCount: number
    csvRowCount: number
    csvColumnCount: number
    claimsStatusCounts: Record<string, number>
    claimsStatusColumnPresent: boolean
  } {
    const normalizedContent = input.content.replace(/\r\n/g, '\n')
    const lines = normalizedContent.split('\n')
    const lineCount = lines.length
    const nonEmptyLineCount = lines.filter((line) => line.trim().length > 0).length

    const isCsv = input.normalizedPath.toLowerCase().endsWith('.csv')
    if (!isCsv) {
      return {
        lineCount,
        nonEmptyLineCount,
        csvRowCount: 0,
        csvColumnCount: 0,
        claimsStatusCounts: {},
        claimsStatusColumnPresent: false
      }
    }

    const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean)
    if (nonEmptyLines.length === 0) {
      return {
        lineCount,
        nonEmptyLineCount,
        csvRowCount: 0,
        csvColumnCount: 0,
        claimsStatusCounts: {},
        claimsStatusColumnPresent: false
      }
    }

    const header = this.parseCsvRow(nonEmptyLines[0] || '')
    const csvColumnCount = header.length
    const dataRows = nonEmptyLines.slice(1)
    const csvRowCount = dataRows.length
    const normalizedHeader = header.map((cell) => normalizeText(cell).replace(/[^a-z0-9]+/g, '_'))

    let statusIndex = normalizedHeader.findIndex((cell) => cell === 'status')
    if (statusIndex < 0) {
      statusIndex = normalizedHeader.findIndex((cell) => cell.endsWith('_status'))
    }

    const claimsStatusCounts: Record<string, number> = {}
    if (statusIndex >= 0) {
      for (const row of dataRows) {
        const cells = this.parseCsvRow(row)
        const statusRaw = normalizeText(cells[statusIndex] || '').replace(/\s+/g, '_')
        if (!statusRaw) continue
        claimsStatusCounts[statusRaw] = (claimsStatusCounts[statusRaw] ?? 0) + 1
      }
    }

    return {
      lineCount,
      nonEmptyLineCount,
      csvRowCount,
      csvColumnCount,
      claimsStatusCounts,
      claimsStatusColumnPresent: statusIndex >= 0
    }
  }

  private diffNumericCounts(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)])
    const delta: Record<string, number> = {}
    for (const key of keys) {
      const beforeValue = Number.isFinite(before[key]) ? before[key] : 0
      const afterValue = Number.isFinite(after[key]) ? after[key] : 0
      const diff = afterValue - beforeValue
      if (diff !== 0) {
        delta[key] = diff
      }
    }
    return delta
  }

  private scoreMetricLeaf(metricKey: string): string {
    const metricPart = metricKey.includes(':')
      ? metricKey.split(':').slice(1).join(':')
      : metricKey
    const withoutIndexes = metricPart.replace(/\[\d+\]/g, '')
    const leaf = withoutIndexes.split('.').map((segment) => segment.trim()).filter(Boolean).pop() || withoutIndexes
    return normalizeText(leaf).replace(/\s+/g, '_')
  }

  private collectVerifiedGrowthFromScoreboard(input: {
    previous: Record<string, number>
    current: Record<string, number>
  }): { keys: string[]; totalDelta: number } {
    const keys: string[] = []
    let totalDelta = 0
    for (const [metricKey, value] of Object.entries(input.current)) {
      if (!Number.isFinite(value)) continue
      if (this.scoreMetricLeaf(metricKey) !== 'claims_verified') continue
      const before = Number.isFinite(input.previous[metricKey]) ? input.previous[metricKey] : 0
      const delta = value - before
      if (delta > 0) {
        keys.push(metricKey)
        totalDelta += delta
      }
    }
    return {
      keys: dedupeStrings(keys),
      totalDelta
    }
  }

  private buildNorthStarContentDeltaProof(input: {
    before?: NorthStarPathSnapshot
    after: NorthStarPathSnapshot
  }): NorthStarContentDeltaProof | null {
    const before = input.before ?? this.buildEmptyNorthStarPathSnapshot(input.after.path)
    const after = input.after
    const hashChanged = before.exists !== after.exists || before.hash !== after.hash
    if (!hashChanged) return null

    const claimsStatusDelta = this.diffNumericCounts(before.claimsStatusCounts, after.claimsStatusCounts)
    const structuredDiff = {
      significantBytesDelta: after.significantBytes - before.significantBytes,
      lineCountDelta: after.lineCount - before.lineCount,
      nonEmptyLineDelta: after.nonEmptyLineCount - before.nonEmptyLineCount,
      csvRowDelta: after.csvRowCount - before.csvRowCount,
      csvColumnDelta: after.csvColumnCount - before.csvColumnCount,
      claimsStatusDelta,
      claimsStatusColumnPresent: before.claimsStatusColumnPresent || after.claimsStatusColumnPresent,
      changedFields: [] as string[]
    }

    if (before.hash !== after.hash) structuredDiff.changedFields.push('hash')
    if (before.semanticHash !== after.semanticHash) structuredDiff.changedFields.push('semantic_hash')
    if (before.stableSemanticHash !== after.stableSemanticHash) structuredDiff.changedFields.push('stable_semantic_hash')
    if (structuredDiff.significantBytesDelta !== 0) structuredDiff.changedFields.push('significant_bytes')
    if (structuredDiff.lineCountDelta !== 0) structuredDiff.changedFields.push('line_count')
    if (structuredDiff.nonEmptyLineDelta !== 0) structuredDiff.changedFields.push('non_empty_line_count')
    if (structuredDiff.csvRowDelta !== 0) structuredDiff.changedFields.push('csv_row_count')
    if (structuredDiff.csvColumnDelta !== 0) structuredDiff.changedFields.push('csv_column_count')
    if (Object.keys(claimsStatusDelta).length > 0) structuredDiff.changedFields.push('claims_status_counts')
    if (structuredDiff.changedFields.length === 0) {
      structuredDiff.changedFields.push('hash')
    }

    return {
      path: after.path,
      beforeHash: before.hash,
      afterHash: after.hash,
      beforeSemanticHash: before.semanticHash,
      afterSemanticHash: after.semanticHash,
      beforeStableSemanticHash: before.stableSemanticHash,
      afterStableSemanticHash: after.stableSemanticHash,
      beforeContentKind: before.contentKind,
      afterContentKind: after.contentKind,
      structuredDiff
    }
  }

  private evaluateVerifiedGrowthContentProof(input: {
    requiredDelta: number
    proofs: NorthStarContentDeltaProof[]
  }): { satisfied: boolean; proofPaths: string[]; matchedDelta: number } {
    if (input.requiredDelta <= 0) {
      return { satisfied: true, proofPaths: [], matchedDelta: 0 }
    }

    const usableProofs = input.proofs.filter((proof) => {
      if (!proof.beforeHash || !proof.afterHash) return false
      if (proof.beforeHash === proof.afterHash) return false
      return (proof.structuredDiff.changedFields ?? []).length > 0
    })
    if (usableProofs.length === 0) {
      return { satisfied: false, proofPaths: [], matchedDelta: 0 }
    }

    const verifiedDeltaProofs = usableProofs.filter(
      (proof) => (proof.structuredDiff.claimsStatusDelta.verified ?? 0) > 0
    )
    const matchedDelta = verifiedDeltaProofs.reduce(
      (sum, proof) => sum + Math.max(0, proof.structuredDiff.claimsStatusDelta.verified ?? 0),
      0
    )
    if (matchedDelta >= input.requiredDelta) {
      return {
        satisfied: true,
        proofPaths: dedupeStrings(verifiedDeltaProofs.map((proof) => proof.path)),
        matchedDelta
      }
    }

    const claimsPathProofs = usableProofs.filter((proof) => /(^|\/)claims[^/]*\.csv$/i.test(proof.path))
    const hasParsedStatusColumn = claimsPathProofs.some((proof) => proof.structuredDiff.claimsStatusColumnPresent)
    if (!hasParsedStatusColumn && claimsPathProofs.length > 0) {
      return {
        satisfied: true,
        proofPaths: dedupeStrings(claimsPathProofs.map((proof) => proof.path)),
        matchedDelta
      }
    }

    return {
      satisfied: false,
      proofPaths: dedupeStrings(claimsPathProofs.map((proof) => proof.path)),
      matchedDelta
    }
  }

  private computeTextSemanticDigest(content: string): { digest: string; significantBytes: number } {
    const normalized = content
      .replace(/[ \t]+$/gm, '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, '')
    const digest = createHash('sha256').update(normalized).digest('hex')
    return {
      digest,
      significantBytes: Buffer.byteLength(normalized, 'utf-8')
    }
  }

  private stripVolatileJsonFields(value: unknown, depth: number = 0): unknown {
    if (depth > 12) return null
    if (value === null || value === undefined) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) {
      return value.map((item) => this.stripVolatileJsonFields(item, depth + 1))
    }
    if (typeof value !== 'object') return String(value)

    const row = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(row)) {
      const normalizedKey = normalizeText(key).replace(/[^a-z0-9]+/g, '_')
      if (NORTHSTAR_VOLATILE_JSON_KEY_RE.test(normalizedKey)) continue
      next[key] = this.stripVolatileJsonFields(entry, depth + 1)
    }
    return next
  }

  private computeStableSemanticDigest(input: {
    normalizedPath: string
    textContent: string
    fallbackDigest: string
  }): string {
    const pathLower = input.normalizedPath.toLowerCase()
    if (!pathLower.endsWith('.json')) {
      return input.fallbackDigest
    }

    try {
      const parsed = JSON.parse(input.textContent)
      const scrubbed = this.stripVolatileJsonFields(parsed)
      const canonical = canonicalizeJson(scrubbed)
      const canonicalJson = JSON.stringify(canonical)
      return createHash('sha256').update(canonicalJson).digest('hex')
    } catch {
      return input.fallbackDigest
    }
  }

  private evaluateExternalCheckContentCredit(input: {
    artifactPaths: string[]
    baselineByPath: Map<string, NorthStarPathSnapshot>
    afterByPath: Map<string, NorthStarPathSnapshot>
    checkSucceeded: boolean
  }): {
    creditGranted: boolean
    candidateArtifactPaths: string[]
    meaningfulArtifactPaths: string[]
    volatileOnlyArtifactPaths: string[]
    unchangedArtifactPaths: string[]
  } {
    if (!input.checkSucceeded) {
      return {
        creditGranted: false,
        candidateArtifactPaths: [],
        meaningfulArtifactPaths: [],
        volatileOnlyArtifactPaths: [],
        unchangedArtifactPaths: []
      }
    }

    const candidateArtifactPaths = dedupeStrings(
      input.artifactPaths.filter((artifactPath) => NORTHSTAR_EXTERNAL_RESULT_ARTIFACT_RE.test(artifactPath))
    )

    if (candidateArtifactPaths.length === 0) {
      return {
        creditGranted: true,
        candidateArtifactPaths: [],
        meaningfulArtifactPaths: [],
        volatileOnlyArtifactPaths: [],
        unchangedArtifactPaths: []
      }
    }

    const meaningfulArtifactPaths: string[] = []
    const volatileOnlyArtifactPaths: string[] = []
    const unchangedArtifactPaths: string[] = []

    for (const artifactPath of candidateArtifactPaths) {
      const before = input.baselineByPath.get(artifactPath) ?? this.buildEmptyNorthStarPathSnapshot(artifactPath)
      const after = input.afterByPath.get(artifactPath) ?? this.buildEmptyNorthStarPathSnapshot(artifactPath)
      if (!before.exists && after.exists) {
        meaningfulArtifactPaths.push(artifactPath)
        continue
      }
      if (!after.exists || before.hash === after.hash) {
        unchangedArtifactPaths.push(artifactPath)
        continue
      }
      if (before.stableSemanticHash !== after.stableSemanticHash) {
        meaningfulArtifactPaths.push(artifactPath)
        continue
      }
      volatileOnlyArtifactPaths.push(artifactPath)
    }

    return {
      creditGranted: meaningfulArtifactPaths.length > 0,
      candidateArtifactPaths,
      meaningfulArtifactPaths: dedupeStrings(meaningfulArtifactPaths),
      volatileOnlyArtifactPaths: dedupeStrings(volatileOnlyArtifactPaths),
      unchangedArtifactPaths: dedupeStrings(unchangedArtifactPaths)
    }
  }

  private decodeUtf8OrNull(buffer: Buffer): string | null {
    const decoded = buffer.toString('utf-8')
    if (decoded.includes('\uFFFD')) return null
    return decoded
  }

  private async computeDirectoryDigest(absDir: string): Promise<string> {
    const rows: string[] = []
    let scanned = 0

    const walk = async (dir: string, relativeDir: string): Promise<void> => {
      if (scanned >= NORTHSTAR_DIRECTORY_DIGEST_LIMIT) return

      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of sorted) {
        if (scanned >= NORTHSTAR_DIRECTORY_DIGEST_LIMIT) break
        const nextRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          rows.push(`D:${nextRelative}`)
          scanned += 1
          await walk(fullPath, nextRelative)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const stat = await fs.stat(fullPath)
          rows.push(`F:${nextRelative}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
          scanned += 1
        } catch {
          // Ignore transient stat failures.
        }
      }
    }

    await walk(absDir, '')
    rows.push(`COUNT:${scanned}`)
    return createHash('sha256').update(rows.join('\n')).digest('hex')
  }

  private async captureNorthStarPathSnapshot(relativePath: string): Promise<NorthStarPathSnapshot> {
    const normalizedPath = this.normalizeNorthStarPath(relativePath)
    if (!normalizedPath) {
      return this.buildEmptyNorthStarPathSnapshot(relativePath)
    }

    let absPath = ''
    try {
      absPath = this.ensureSafeTargetPath(normalizedPath)
    } catch {
      return this.buildEmptyNorthStarPathSnapshot(normalizedPath)
    }

    try {
      const stat = await fs.stat(absPath)
      if (stat.isFile()) {
        const content = await fs.readFile(absPath)
        const rawHash = createHash('sha256').update(content).digest('hex')
        const decoded = this.decodeUtf8OrNull(content)
        const textSemantics = decoded !== null
          ? this.computeTextSemanticDigest(decoded)
          : null
        const structure = decoded !== null
          ? this.summarizeNorthStarTextStructure({
            content: decoded,
            normalizedPath
          })
          : {
            lineCount: 0,
            nonEmptyLineCount: 0,
            csvRowCount: 0,
            csvColumnCount: 0,
            claimsStatusCounts: {},
            claimsStatusColumnPresent: false
          }
        return {
          path: normalizedPath,
          exists: true,
          hash: rawHash,
          semanticHash: textSemantics?.digest || rawHash,
          stableSemanticHash: textSemantics
            ? this.computeStableSemanticDigest({
              normalizedPath,
              textContent: decoded!,
              fallbackDigest: textSemantics.digest
            })
            : rawHash,
          significantBytes: textSemantics?.significantBytes ?? content.byteLength,
          contentKind: textSemantics ? 'text' : 'binary',
          textExcerpt: textSemantics ? decoded!.slice(0, 1_600) : '',
          mtimeMs: stat.mtimeMs,
          lineCount: structure.lineCount,
          nonEmptyLineCount: structure.nonEmptyLineCount,
          csvRowCount: structure.csvRowCount,
          csvColumnCount: structure.csvColumnCount,
          claimsStatusCounts: structure.claimsStatusCounts,
          claimsStatusColumnPresent: structure.claimsStatusColumnPresent
        }
      }
      if (stat.isDirectory()) {
        const digest = await this.computeDirectoryDigest(absPath)
        return {
          path: normalizedPath,
          exists: true,
          hash: digest,
          semanticHash: digest,
          stableSemanticHash: digest,
          significantBytes: 0,
          contentKind: 'directory',
          textExcerpt: '',
          mtimeMs: stat.mtimeMs,
          lineCount: 0,
          nonEmptyLineCount: 0,
          csvRowCount: 0,
          csvColumnCount: 0,
          claimsStatusCounts: {},
          claimsStatusColumnPresent: false
        }
      }

      const synthetic = `${stat.mode}:${stat.size}:${Math.floor(stat.mtimeMs)}`
      return {
        path: normalizedPath,
        exists: true,
        hash: synthetic,
        semanticHash: synthetic,
        stableSemanticHash: synthetic,
        significantBytes: 0,
        contentKind: 'other',
        textExcerpt: '',
        mtimeMs: stat.mtimeMs,
        lineCount: 0,
        nonEmptyLineCount: 0,
        csvRowCount: 0,
        csvColumnCount: 0,
        claimsStatusCounts: {},
        claimsStatusColumnPresent: false
      }
    } catch {
      return this.buildEmptyNorthStarPathSnapshot(normalizedPath)
    }
  }

  private async captureNorthStarBaseline(northStar: NorthStarContract | undefined): Promise<NorthStarPathSnapshot[]> {
    if (!northStar || northStar.artifactPaths.length === 0) return []
    const snapshots: NorthStarPathSnapshot[] = []
    for (const artifactPath of northStar.artifactPaths) {
      snapshots.push(await this.captureNorthStarPathSnapshot(artifactPath))
    }
    return snapshots
  }

  private buildDefaultNorthStarEvaluation(input: {
    orchestrationMode: ResolvedOrchestrationMode
    northStar?: NorthStarContract
    noDeltaStreak: number
    realityCheckNoExecStreak?: number
    previousGateSatisfied?: boolean | null
    pivotAllowed: boolean
  }): NorthStarEvaluation {
    const contractPath = input.northStar?.filePath || NORTHSTAR_FILE_NAME
    const artifactMode = isArtifactGravityMode(input.orchestrationMode)
    return {
      enabled: artifactMode,
      objectiveId: input.northStar?.objectiveId || `obj-${hashStable(normalizeText(input.northStar?.currentObjective || input.northStar?.goal || 'northstar'))}`,
      objectiveVersion: Number.isFinite(Number(input.northStar?.objectiveVersion))
        ? Math.max(1, Number(input.northStar?.objectiveVersion))
        : 1,
      contractPath,
      artifactGate: input.northStar?.artifactGate ?? 'any',
      artifactPaths: [...(input.northStar?.artifactPaths ?? [])],
      internalCheckGate: input.northStar?.internalCheckGate ?? input.northStar?.realityCheckGate ?? 'any',
      internalCheckCommands: [...(input.northStar?.internalCheckCommands ?? input.northStar?.realityCheckCommands ?? [])],
      internalCheckExecutedCommands: [],
      internalCheckSucceededCommands: [],
      internalCheckExecutedCount: 0,
      internalCheckSucceededCount: 0,
      internalCheckGateSatisfied: false,
      externalCheckGate: input.northStar?.externalCheckGate ?? 'any',
      externalCheckCommands: [...(input.northStar?.externalCheckCommands ?? [])],
      externalCheckExecutedCommands: [],
      externalCheckSucceededCommands: [],
      externalCheckExecutedCount: 0,
      externalCheckSucceededCount: 0,
      externalCheckGateSatisfied: false,
      externalCheckCreditGranted: false,
      externalCheckCandidateArtifactPaths: [],
      externalCheckMeaningfulArtifactPaths: [],
      externalCheckVolatileOnlyArtifactPaths: [],
      externalCheckUnchangedArtifactPaths: [],
      externalCheckRequireEvery: Number(input.northStar?.externalCheckRequireEvery || NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_DEFAULT),
      externalCheckDueThisTurn: false,
      externalCheckQuotaSatisfied: true,
      externalCheckNoSuccessStreak: 0,
      scoreboardMetricPaths: [...(input.northStar?.scoreboardMetricPaths ?? [])],
      scoreboardMetricPathsValid: Boolean(input.northStar?.scoreboardMetricPathsValid ?? false),
      scoreboardValues: {},
      scoreboardPreviousValues: {},
      scoreboardImproved: false,
      scoreboardRegressed: false,
      scoreboardChangedKeys: [],
      scoreboardImprovedKeys: [],
      scoreboardRegressedKeys: [],
      scoreboardReady: false,
      realityCheckGate: input.northStar?.realityCheckGate ?? 'any',
      realityCheckCommands: [...(input.northStar?.realityCheckCommands ?? [])],
      realityCheckExecutedCommands: [],
      realityCheckSucceededCommands: [],
      realityCheckExecutedCount: 0,
      realityCheckSucceededCount: 0,
      realityCheckGateSatisfied: false,
      previousGateSatisfied: typeof input.previousGateSatisfied === 'boolean'
        ? input.previousGateSatisfied
        : null,
      realityCheckNoExecStreak: Number(input.realityCheckNoExecStreak || 0),
      antiChurnTriggered: false,
      verifyCmd: input.northStar?.verifyCmd?.trim() || '',
      artifactChanged: false,
      changedArtifacts: [],
      baselineSnapshots: [],
      afterSnapshots: [],
      contentDeltaProofs: [],
      verifiedGrowthKeys: [],
      verifiedGrowthTotalDelta: 0,
      verifiedGrowthContentProofRequired: false,
      verifiedGrowthContentProofSatisfied: true,
      verifiedGrowthContentProofPaths: [],
      verifiedGrowthMatchedDelta: 0,
      verifiedGrowthMissingProofReason: '',
      verifyExecuted: false,
      verifySucceeded: false,
      gateSatisfied: !artifactMode,
      policyViolations: [],
      reason: artifactMode
        ? 'northstar_missing_contract'
        : '',
      noDeltaStreak: input.noDeltaStreak,
      pivotAllowed: input.pivotAllowed,
      pivotRollbackApplied: false,
      pivotRollbackViolation: ''
    }
  }

  private async captureNorthStarContractSnapshot(): Promise<{ exists: boolean, content: string }> {
    const filePath = this.getNorthStarFilePath()
    if (!(await fileExists(filePath))) {
      return {
        exists: false,
        content: ''
      }
    }
    return {
      exists: true,
      content: await readTextOrEmpty(filePath)
    }
  }

  private pickNorthStarHardViolation(policyViolations: string[]): string {
    for (const violation of policyViolations) {
      const normalized = normalizeText(violation)
      if (YoloSession.NORTHSTAR_PIVOT_HARD_VIOLATIONS.has(normalized)) {
        return normalized
      }
    }
    return ''
  }

  private async enforceNorthStarPivotHardGate(input: {
    orchestrationMode: ResolvedOrchestrationMode
    policyViolations: string[]
    beforeSnapshot: { exists: boolean, content: string } | null
  }): Promise<{ applied: boolean, violation: string, restoreError: string }> {
    if (!isArtifactGravityMode(input.orchestrationMode)) {
      return { applied: false, violation: '', restoreError: '' }
    }
    if (!input.beforeSnapshot) {
      return { applied: false, violation: '', restoreError: '' }
    }
    const hardViolation = this.pickNorthStarHardViolation(input.policyViolations)
    if (!hardViolation) {
      return { applied: false, violation: '', restoreError: '' }
    }

    const filePath = this.getNorthStarFilePath()
    try {
      if (input.beforeSnapshot.exists) {
        await writeText(filePath, input.beforeSnapshot.content)
      } else if (await fileExists(filePath)) {
        await fs.rm(filePath, { force: true })
      }
      return {
        applied: true,
        violation: hardViolation,
        restoreError: ''
      }
    } catch (error) {
      return {
        applied: false,
        violation: hardViolation,
        restoreError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private isCodeLikeNorthStarContract(northStar: NorthStarContract): boolean {
    const hasCodeLikePath = northStar.artifactPaths.some((artifactPath) => (
      NORTHSTAR_CODELIKE_PATH_RE.test(artifactPath)
      || artifactPath.startsWith('repos/')
      || artifactPath.startsWith('external/')
      || artifactPath.startsWith('src/')
      || artifactPath.startsWith('packages/')
      || artifactPath.startsWith('apps/')
    ))
    if (hasCodeLikePath) return true

    const artifactType = normalizeText(northStar.artifactType)
    if (artifactType.includes('paper') || artifactType.includes('analysis') || artifactType.includes('writing')) {
      return false
    }
    return false
  }

  private async evaluateNorthStarPivotPolicy(input: {
    northStar: NorthStarContract
    fallbackGoal: string
    pivotAllowed: boolean
  }): Promise<string[]> {
    const currentPath = this.getNorthStarFilePath()
    const after = await this.loadNorthStarContract({
      filePath: currentPath,
      fallbackGoal: input.fallbackGoal
    })
    if (!after.contract) {
      return ['northstar_contract_invalid']
    }

    const beforePaths = dedupeStrings(input.northStar.artifactPaths).sort((a, b) => a.localeCompare(b))
    const afterPaths = dedupeStrings(after.contract.artifactPaths).sort((a, b) => a.localeCompare(b))
    const pathChanged = JSON.stringify(beforePaths) !== JSON.stringify(afterPaths)
    const verifyChanged = this.normalizeCommandForMatch(input.northStar.verifyCmd || '')
      !== this.normalizeCommandForMatch(after.contract.verifyCmd || '')
    const beforeInternalChecks = dedupeStrings(input.northStar.internalCheckCommands).sort((a, b) => a.localeCompare(b))
    const afterInternalChecks = dedupeStrings(after.contract.internalCheckCommands).sort((a, b) => a.localeCompare(b))
    const internalCheckChanged = JSON.stringify(beforeInternalChecks) !== JSON.stringify(afterInternalChecks)
    const beforeExternalChecks = dedupeStrings(input.northStar.externalCheckCommands).sort((a, b) => a.localeCompare(b))
    const afterExternalChecks = dedupeStrings(after.contract.externalCheckCommands).sort((a, b) => a.localeCompare(b))
    const externalCheckChanged = JSON.stringify(beforeExternalChecks) !== JSON.stringify(afterExternalChecks)
    const beforeScoreboardPaths = dedupeStrings(input.northStar.scoreboardMetricPaths).sort((a, b) => a.localeCompare(b))
    const afterScoreboardPaths = dedupeStrings(after.contract.scoreboardMetricPaths).sort((a, b) => a.localeCompare(b))
    const scoreboardChanged = JSON.stringify(beforeScoreboardPaths) !== JSON.stringify(afterScoreboardPaths)
    const gateChanged = (
      input.northStar.internalCheckGate !== after.contract.internalCheckGate
      || input.northStar.externalCheckGate !== after.contract.externalCheckGate
    )
    const externalPolicyChanged = input.northStar.externalCheckRequireEvery !== after.contract.externalCheckRequireEvery
    if (!pathChanged && !verifyChanged && !internalCheckChanged && !externalCheckChanged && !scoreboardChanged && !gateChanged && !externalPolicyChanged) return []

    if (!input.pivotAllowed) {
      return ['northstar_pivot_locked']
    }

    const raw = await readTextOrEmpty(currentPath)
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const rationaleLine = lines.find((line) => /pivot\s+rationale\s*:|(?:^[-*]\s*)?rationale\s*:/i.test(line)) || ''
    const evidenceLine = lines.find((line) => /pivot\s+evidence\s*:|(?:^[-*]\s*)?evidence\s*:/i.test(line)) || ''
    const hasRationale = Boolean(
      rationaleLine
      && !/\(fill/i.test(rationaleLine)
      && rationaleLine.replace(/^[-*]\s*/, '').split(':').slice(1).join(':').trim().length > 8
    )
    const hasEvidenceRef = Boolean(
      evidenceLine && /runs\/turn-\d{4}\/[^\s)]+/i.test(evidenceLine)
    ) || /runs\/turn-\d{4}\/[^\s)]+/i.test(raw)

    const violations: string[] = []
    if (!hasRationale) violations.push('northstar_missing_pivot_rationale')
    if (!hasEvidenceRef) violations.push('northstar_missing_pivot_evidence')
    return violations
  }

  private async evaluateNorthStarTurn(input: {
    orchestrationMode: ResolvedOrchestrationMode
    northStar?: NorthStarContract
    baseline: NorthStarPathSnapshot[]
    toolEvents: ToolEventRecord[]
    noDeltaStreak: number
    noRealityCheckExecutionStreak: number
    noExternalCheckSuccessStreak: number
    previousGateSatisfied: boolean | null
    previousScoreboardValues: Record<string, number>
    pivotAllowed: boolean
  }): Promise<NorthStarEvaluation> {
    const artifactGravityMode = isArtifactGravityMode(input.orchestrationMode)
    const paperMode = isArtifactGravityPaperMode(input.orchestrationMode)
    const evaluation = this.buildDefaultNorthStarEvaluation({
      orchestrationMode: input.orchestrationMode,
      northStar: input.northStar,
      noDeltaStreak: input.noDeltaStreak,
      realityCheckNoExecStreak: input.noRealityCheckExecutionStreak,
      previousGateSatisfied: input.previousGateSatisfied,
      pivotAllowed: input.pivotAllowed
    })
    if (!artifactGravityMode) {
      return evaluation
    }
    if (!input.northStar) {
      evaluation.reason = 'northstar_missing_contract'
      return evaluation
    }

    const afterSnapshots: NorthStarPathSnapshot[] = []
    for (const artifactPath of input.northStar.artifactPaths) {
      afterSnapshots.push(await this.captureNorthStarPathSnapshot(artifactPath))
    }
    const afterByPath = new Map<string, NorthStarPathSnapshot>(
      afterSnapshots.map((row) => [row.path, row])
    )

    const baselineByPath = new Map<string, NorthStarPathSnapshot>(
      input.baseline.map((row) => [row.path, row])
    )
    const changedArtifacts: string[] = []
    for (const after of afterSnapshots) {
      const before = baselineByPath.get(after.path)
      if (!before) {
        if (after.exists) changedArtifacts.push(after.path)
        continue
      }
      const rawChanged = before.exists !== after.exists || before.hash !== after.hash
      if (!rawChanged) continue
      const semanticChanged = before.semanticHash !== after.semanticHash
      const significantDelta = Math.abs(after.significantBytes - before.significantBytes)
      if (paperMode) {
        // v3-paper: any normalized-text change is substantive; whitespace-only churn is ignored.
        if (before.contentKind === 'text' && after.contentKind === 'text' && !semanticChanged) continue
        if (before.exists !== after.exists || semanticChanged || before.contentKind !== after.contentKind) {
          changedArtifacts.push(after.path)
        }
        continue
      }

      const trivialTextOnly = (
        before.contentKind === 'text'
        && after.contentKind === 'text'
        && !semanticChanged
        && significantDelta < NORTHSTAR_TRIVIAL_TEXT_DELTA_THRESHOLD
      )
      if (trivialTextOnly) continue
      if (before.contentKind === 'text' && after.contentKind === 'text' && !semanticChanged && significantDelta === 0) {
        continue
      }
      if (
        before.exists !== after.exists
        || semanticChanged
        || before.contentKind !== after.contentKind
        || significantDelta >= NORTHSTAR_TRIVIAL_TEXT_DELTA_THRESHOLD
      ) {
        changedArtifacts.push(after.path)
      }
    }

    const artifactChanged = input.northStar.artifactGate === 'all'
      ? (input.northStar.artifactPaths.length > 0
          && input.northStar.artifactPaths.every((target) => changedArtifacts.includes(target)))
      : changedArtifacts.length > 0
    const contentDeltaProofs = changedArtifacts
      .map((artifactPath) => this.buildNorthStarContentDeltaProof({
        before: baselineByPath.get(artifactPath),
        after: afterByPath.get(artifactPath) ?? this.buildEmptyNorthStarPathSnapshot(artifactPath)
      }))
      .filter((proof): proof is NorthStarContentDeltaProof => proof !== null)

    const verifyCmd = input.northStar.verifyCmd?.trim() || ''
    const verify = this.evaluateVerifyCommandFromToolEvents(input.toolEvents, verifyCmd)
    const policyViolations = await this.evaluateNorthStarPivotPolicy({
      northStar: input.northStar,
      fallbackGoal: input.northStar.goal || '',
      pivotAllowed: input.pivotAllowed
    })

    if (paperMode) {
      if (!input.northStar.paperArtifactPathsEligible) {
        policyViolations.push('northstar_paper_artifact_paths_invalid')
      }
      if (!input.northStar.internalCheckAllowlistValid) {
        policyViolations.push('northstar_internalcheck_allowlist_invalid')
      }
      if ((input.northStar.internalCheckCommands ?? []).length === 0) {
        policyViolations.push('northstar_missing_internal_check')
      }
      if (!input.northStar.externalCheckAllowlistValid) {
        policyViolations.push('northstar_externalcheck_allowlist_invalid')
      }
      if ((input.northStar.externalCheckCommands ?? []).length === 0) {
        policyViolations.push('northstar_missing_external_check')
      }
      if (!input.northStar.scoreboardMetricPathsValid) {
        policyViolations.push('northstar_scoreboard_paths_invalid')
      }
      if ((input.northStar.scoreboardMetricPaths ?? []).length === 0) {
        policyViolations.push('northstar_missing_scoreboard')
      }
    }

    if (this.isCodeLikeNorthStarContract(input.northStar) && !verifyCmd) {
      policyViolations.push('northstar_verify_required_for_code_artifact')
    }

    const internalCheckCommands = dedupeStrings(input.northStar.internalCheckCommands ?? input.northStar.realityCheckCommands ?? [])
    const internalCheckEval = this.evaluateRealityCheckFromToolEvents(input.toolEvents, internalCheckCommands)
    const internalCheckExecutedCount = internalCheckEval.executedCommands.length
    const internalCheckSucceededCount = internalCheckEval.succeededCommands.length
    const internalCheckGate = input.northStar.internalCheckGate ?? input.northStar.realityCheckGate ?? 'any'
    const internalCheckGateSatisfied = internalCheckGate === 'all'
      ? (internalCheckCommands.length > 0 && internalCheckSucceededCount === internalCheckCommands.length)
      : internalCheckSucceededCount > 0

    const externalCheckCommands = dedupeStrings(input.northStar.externalCheckCommands ?? [])
    const externalCheckEval = this.evaluateRealityCheckFromToolEvents(input.toolEvents, externalCheckCommands)
    const externalCheckExecutedCount = externalCheckEval.executedCommands.length
    const externalCheckSucceededCount = externalCheckEval.succeededCommands.length
    const externalCheckGate = input.northStar.externalCheckGate ?? 'any'
    const externalCheckGateSatisfied = externalCheckGate === 'all'
      ? (externalCheckCommands.length > 0 && externalCheckSucceededCount === externalCheckCommands.length)
      : externalCheckSucceededCount > 0
    const externalCheckContentCredit = paperMode
      ? this.evaluateExternalCheckContentCredit({
        artifactPaths: input.northStar.artifactPaths,
        baselineByPath,
        afterByPath,
        checkSucceeded: externalCheckGateSatisfied
      })
      : {
        creditGranted: externalCheckGateSatisfied,
        candidateArtifactPaths: [] as string[],
        meaningfulArtifactPaths: [] as string[],
        volatileOnlyArtifactPaths: [] as string[],
        unchangedArtifactPaths: [] as string[]
      }
    const externalCheckCreditGranted = paperMode
      ? (externalCheckGateSatisfied && externalCheckContentCredit.creditGranted)
      : externalCheckGateSatisfied

    const realityCheckCommands = dedupeStrings([...internalCheckCommands, ...externalCheckCommands])
    const realityCheckExecutedCommands = dedupeStrings([
      ...internalCheckEval.executedCommands,
      ...externalCheckEval.executedCommands
    ])
    const realityCheckSucceededCommands = dedupeStrings([
      ...internalCheckEval.succeededCommands,
      ...externalCheckEval.succeededCommands
    ])
    const realityCheckExecutedCount = realityCheckExecutedCommands.length
    const realityCheckSucceededCount = realityCheckSucceededCommands.length
    const realityCheckGateSatisfied = internalCheckGateSatisfied
    const previousGateSatisfied = typeof input.previousGateSatisfied === 'boolean'
      ? input.previousGateSatisfied
      : false
    const gateTransition = internalCheckGateSatisfied && !previousGateSatisfied

    const antiChurnTriggered = (
      paperMode
      && input.noRealityCheckExecutionStreak >= NORTHSTAR_REALITYCHECK_NO_EXEC_PIVOT_THRESHOLD
      && internalCheckExecutedCount === 0
    )

    const externalCheckRequireEvery = Math.min(
      NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MAX,
      Math.max(
        NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_MIN,
        Number(input.northStar.externalCheckRequireEvery || NORTHSTAR_EXTERNAL_CHECK_REQUIRE_EVERY_DEFAULT)
      )
    )
    const externalCheckDueThisTurn = (
      paperMode
      && externalCheckRequireEvery > 0
      && input.noExternalCheckSuccessStreak >= (externalCheckRequireEvery - 1)
    )
    const externalCheckQuotaSatisfied = !externalCheckDueThisTurn || externalCheckCreditGranted

    const scoreboardMetricPaths = dedupeStrings(input.northStar.scoreboardMetricPaths ?? [])
    const scoreboardValues = paperMode
      ? await this.loadNorthStarScoreboardValues(scoreboardMetricPaths)
      : {}
    const scoreboardPreviousValues = paperMode
      ? { ...(input.previousScoreboardValues ?? {}) }
      : {}
    const scoreboardComparison = this.compareScoreboard(scoreboardPreviousValues, scoreboardValues)
    const verifiedGrowth = paperMode
      ? this.collectVerifiedGrowthFromScoreboard({
        previous: scoreboardPreviousValues,
        current: scoreboardValues
      })
      : { keys: [], totalDelta: 0 }
    const verifiedGrowthContentProofRequired = paperMode && verifiedGrowth.totalDelta > 0
    const verifiedGrowthProofEval = verifiedGrowthContentProofRequired
      ? this.evaluateVerifiedGrowthContentProof({
        requiredDelta: verifiedGrowth.totalDelta,
        proofs: contentDeltaProofs
      })
      : { satisfied: true, proofPaths: [] as string[], matchedDelta: 0 }
    const verifiedGrowthMissingProofReason = (
      verifiedGrowthContentProofRequired && !verifiedGrowthProofEval.satisfied
    )
      ? NORTHSTAR_VERIFIED_GROWTH_MISSING_PROOF_REASON
      : ''

    let gateSatisfied = false
    let reason = ''
    if (policyViolations.length > 0) {
      reason = policyViolations[0] || ''
    } else if (paperMode) {
      if (antiChurnTriggered) {
        reason = 'northstar_realitycheck_not_executed_streak'
      } else if (internalCheckExecutedCount === 0) {
        reason = 'northstar_realitycheck_not_executed'
      } else if (!internalCheckGateSatisfied) {
        reason = 'northstar_realitycheck_failed'
      } else if (!externalCheckQuotaSatisfied) {
        reason = externalCheckGateSatisfied
          ? NORTHSTAR_EXTERNAL_CHECK_TRIVIAL_DELTA_REASON
          : 'northstar_external_check_required'
      } else if (!scoreboardComparison.ready) {
        reason = 'northstar_scoreboard_missing'
      } else if (!scoreboardComparison.improved) {
        reason = input.noDeltaStreak >= NORTHSTAR_NO_IMPROVEMENT_HARD_BLOCK_STREAK
          ? NORTHSTAR_REPEATED_NO_DELTA_BLOCK_REASON
          : (
            gateTransition
              ? 'northstar_check_only_repeated_pass'
              : 'northstar_scoreboard_not_improved'
          )
      } else if (verifiedGrowthContentProofRequired && !verifiedGrowthProofEval.satisfied) {
        reason = NORTHSTAR_VERIFIED_GROWTH_MISSING_PROOF_REASON
      } else {
        gateSatisfied = true
      }
    } else {
      gateSatisfied = (artifactChanged || verify.succeeded) && policyViolations.length === 0
      if (!artifactChanged && !verifyCmd) {
        reason = 'northstar_no_artifact_change'
      } else if (!gateSatisfied) {
        reason = 'northstar_no_verifiable_delta'
      }
    }

    return {
      ...evaluation,
      objectiveId: input.northStar.objectiveId,
      objectiveVersion: input.northStar.objectiveVersion,
      artifactChanged,
      changedArtifacts,
      baselineSnapshots: input.baseline,
      afterSnapshots,
      contentDeltaProofs,
      verifiedGrowthKeys: verifiedGrowth.keys,
      verifiedGrowthTotalDelta: verifiedGrowth.totalDelta,
      verifiedGrowthContentProofRequired,
      verifiedGrowthContentProofSatisfied: verifiedGrowthProofEval.satisfied,
      verifiedGrowthContentProofPaths: verifiedGrowthProofEval.proofPaths,
      verifiedGrowthMatchedDelta: verifiedGrowthProofEval.matchedDelta,
      verifiedGrowthMissingProofReason,
      internalCheckGate,
      internalCheckCommands,
      internalCheckExecutedCommands: internalCheckEval.executedCommands,
      internalCheckSucceededCommands: internalCheckEval.succeededCommands,
      internalCheckExecutedCount,
      internalCheckSucceededCount,
      internalCheckGateSatisfied,
      externalCheckGate,
      externalCheckCommands,
      externalCheckExecutedCommands: externalCheckEval.executedCommands,
      externalCheckSucceededCommands: externalCheckEval.succeededCommands,
      externalCheckExecutedCount,
      externalCheckSucceededCount,
      externalCheckGateSatisfied,
      externalCheckCreditGranted,
      externalCheckCandidateArtifactPaths: externalCheckContentCredit.candidateArtifactPaths,
      externalCheckMeaningfulArtifactPaths: externalCheckContentCredit.meaningfulArtifactPaths,
      externalCheckVolatileOnlyArtifactPaths: externalCheckContentCredit.volatileOnlyArtifactPaths,
      externalCheckUnchangedArtifactPaths: externalCheckContentCredit.unchangedArtifactPaths,
      externalCheckRequireEvery,
      externalCheckDueThisTurn,
      externalCheckQuotaSatisfied,
      externalCheckNoSuccessStreak: input.noExternalCheckSuccessStreak,
      scoreboardMetricPaths,
      scoreboardMetricPathsValid: input.northStar.scoreboardMetricPathsValid,
      scoreboardValues,
      scoreboardPreviousValues,
      scoreboardImproved: scoreboardComparison.improved,
      scoreboardRegressed: scoreboardComparison.regressed,
      scoreboardChangedKeys: scoreboardComparison.changedKeys,
      scoreboardImprovedKeys: scoreboardComparison.improvedKeys,
      scoreboardRegressedKeys: scoreboardComparison.regressedKeys,
      scoreboardReady: scoreboardComparison.ready,
      realityCheckGate: input.northStar.realityCheckGate ?? internalCheckGate,
      realityCheckCommands,
      realityCheckExecutedCommands,
      realityCheckSucceededCommands,
      realityCheckExecutedCount,
      realityCheckSucceededCount,
      realityCheckGateSatisfied,
      previousGateSatisfied: input.previousGateSatisfied,
      realityCheckNoExecStreak: input.noRealityCheckExecutionStreak,
      antiChurnTriggered,
      verifyCmd,
      verifyExecuted: verify.executed,
      verifySucceeded: verify.succeeded,
      gateSatisfied,
      policyViolations: dedupeStrings([
        ...policyViolations,
        ...(verifiedGrowthMissingProofReason ? [verifiedGrowthMissingProofReason] : [])
      ]),
      reason
    }
  }

  private async detectOpenAIPythonScriptIssue(input: {
    workspaceWriteTouches: string[]
    toolEvents: ToolEventRecord[]
  }): Promise<{ path: string; reason: string } | null> {
    const eventContentByPath = new Map<string, string>()
    for (const event of input.toolEvents) {
      if (event.phase !== 'call') continue
      const tool = normalizeText(event.tool || '')
      if (tool !== 'write' && tool !== 'edit') continue
      const eventInput = toPlainObject(event.input)
      const rawPath = safeString(eventInput?.path).trim()
      if (!rawPath) continue
      const normalizedPath = this.normalizeProjectPathPointer(rawPath)
      if (!normalizedPath) continue
      const content = safeString(eventInput?.content)
      if (!content.trim()) continue
      eventContentByPath.set(normalizedPath, content)
    }

    for (const rawPath of input.workspaceWriteTouches) {
      const normalized = this.normalizeProjectPathPointer(rawPath)
      if (!/^runs\/turn-\d{4}\/artifacts\/.+\.py$/i.test(normalized)) continue

      let content = eventContentByPath.get(normalized) || ''
      if (!content.trim()) {
        const absolutePath = path.join(this.yoloRoot, normalized)
        if (!(await fileExists(absolutePath))) continue
        content = await readTextOrEmpty(absolutePath)
      }
      if (!content.trim()) continue

      const usesOpenAi = /(?:^|\n)\s*import\s+openai\b|from\s+openai\s+import\s+OpenAI/i.test(content)
      if (!usesOpenAi) continue

      if (/openai\.ChatCompletion\.create\s*\(/i.test(content)) {
        return { path: normalized, reason: 'legacy_chatcompletion_api' }
      }

      const hasV1Client = /from\s+openai\s+import\s+OpenAI/i.test(content)
        && /OpenAI\s*\(/.test(content)
      if (!hasV1Client) {
        return { path: normalized, reason: 'missing_openai_v1_client' }
      }

      const hasPreflightLog = /openai[-_ ]preflight|api_key_present|openai\.__version__/i.test(content)
      if (!hasPreflightLog) {
        return { path: normalized, reason: 'missing_openai_preflight_log' }
      }
    }

    return null
  }

  private detectCodingLargeRepoUsage(toolEvents: ToolEventRecord[]): {
    used: boolean
    usedCodeEditWorkflow: boolean
    script: string
  } {
    let used = false
    let usedCodeEditWorkflow = false
    let script = ''

    for (const event of toolEvents) {
      if (event.phase !== 'call') continue
      const tool = normalizeText(event.tool || '')
      if (tool !== 'skill-script-run') continue
      const input = toPlainObject(event.input)
      const skillId = normalizeText(safeString(input?.skillId))
      if (skillId !== 'coding-large-repo') continue

      used = true
      const scriptName = normalizeText(safeString(input?.script))
      if (scriptName) script = scriptName
      if (CODING_LARGE_REPO_CODE_EDIT_SCRIPTS.has(scriptName)) {
        usedCodeEditWorkflow = true
      }
    }

    return { used, usedCodeEditWorkflow, script }
  }

  private extractScriptArgs(rawArgs: unknown): string[] {
    if (!Array.isArray(rawArgs)) return []
    return rawArgs
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  }

  private extractScriptArgValue(args: string[], flag: string): string {
    if (!flag) return ''
    for (let idx = 0; idx < args.length; idx += 1) {
      if (args[idx] !== flag) continue
      return (args[idx + 1] || '').trim()
    }
    return ''
  }

  private parseToolEventTimestampMs(timestamp: string): number | null {
    const raw = timestamp.trim()
    if (!raw) return null
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  private observeCodingAgentSessions(toolEvents: ToolEventRecord[]): CodingAgentSessionObservation {
    type SessionState = {
      firstSeenMs: number | null
      lastSeenMs: number | null
      started: boolean
      polled: boolean
      logged: boolean
      pollCount: number
      statuses: Set<string>
    }

    const sessions = new Map<string, SessionState>()
    const ensureSession = (sessionId: string): SessionState => {
      const existing = sessions.get(sessionId)
      if (existing) return existing
      const initial: SessionState = {
        firstSeenMs: null,
        lastSeenMs: null,
        started: false,
        polled: false,
        logged: false,
        pollCount: 0,
        statuses: new Set<string>()
      }
      sessions.set(sessionId, initial)
      return initial
    }
    const touchSessionTime = (session: SessionState, timestampMs: number | null) => {
      if (typeof timestampMs !== 'number') return
      if (session.firstSeenMs === null || timestampMs < session.firstSeenMs) {
        session.firstSeenMs = timestampMs
      }
      if (session.lastSeenMs === null || timestampMs > session.lastSeenMs) {
        session.lastSeenMs = timestampMs
      }
    }

    for (const event of toolEvents) {
      const tool = normalizeText(event.tool || '')
      if (tool !== 'skill-script-run') continue
      const eventInput = toPlainObject(event.input)
      const skillId = normalizeText(safeString(eventInput?.skillId))
      if (skillId !== 'coding-large-repo') continue

      const scriptFromInput = normalizeText(safeString(eventInput?.script))
      const args = this.extractScriptArgs(eventInput?.args)
      const sessionIdFromArgs = this.extractScriptArgValue(args, '--session-id')
      const timestampMs = this.parseToolEventTimestampMs(event.timestamp)

      if (event.phase === 'call') {
        if (!sessionIdFromArgs) continue
        const session = ensureSession(sessionIdFromArgs)
        touchSessionTime(session, timestampMs)
        if (scriptFromInput === 'agent-run-to-completion') {
          session.started = true
        }
        if (scriptFromInput === 'agent-poll') {
          session.polled = true
        }
        if (scriptFromInput === 'agent-log') {
          session.logged = true
        }
        continue
      }

      if (event.phase !== 'result') continue
      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const structuredObj = toPlainObject(dataObj?.structuredResult)

      const scriptFromStructured = normalizeText(safeString(structuredObj?.script))
      const script = scriptFromStructured || scriptFromInput
      const status = normalizeText(safeString(structuredObj?.status))
      const sessionId = safeString(structuredObj?.session_id).trim() || sessionIdFromArgs
      if (!sessionId) continue

      const session = ensureSession(sessionId)
      touchSessionTime(session, timestampMs)
      if (script === 'agent-run-to-completion') {
        session.started = true
      }
      if (script === 'agent-poll') {
        session.polled = true
        session.pollCount += 1
      }
      if (script === 'agent-log') {
        session.logged = true
      }
      if (status) {
        session.statuses.add(status)
      }
    }

    const sessionIds = Array.from(sessions.keys())
    const startedSessionIds: string[] = []
    const polledSessionIds: string[] = []
    const loggedSessionIds: string[] = []
    const runningSessionIds: string[] = []
    const completedSessionIds: string[] = []
    const failedSessionIds: string[] = []
    let pollCount = 0
    let observationWindowMs = 0

    for (const [sessionId, session] of sessions.entries()) {
      if (session.started) startedSessionIds.push(sessionId)
      if (session.polled) polledSessionIds.push(sessionId)
      if (session.logged) loggedSessionIds.push(sessionId)
      pollCount += session.pollCount

      if (session.statuses.has('running')) runningSessionIds.push(sessionId)
      if (session.statuses.has('completed')) completedSessionIds.push(sessionId)
      if (session.statuses.has('failed') || session.statuses.has('error')) failedSessionIds.push(sessionId)

      if (session.firstSeenMs !== null && session.lastSeenMs !== null) {
        observationWindowMs = Math.max(
          observationWindowMs,
          Math.max(0, session.lastSeenMs - session.firstSeenMs)
        )
      }
    }

    const hasTerminal = completedSessionIds.length > 0 || failedSessionIds.length > 0
    const hasRunningOnly = runningSessionIds.length > 0 && !hasTerminal
    const warmupLikely = hasRunningOnly
      && (pollCount < CODING_AGENT_STALL_MIN_POLLS || observationWindowMs < CODING_AGENT_STALL_MIN_WINDOW_MS)

    return {
      observed: sessionIds.length > 0,
      sessionIds,
      startedSessionIds,
      polledSessionIds,
      loggedSessionIds,
      runningSessionIds,
      completedSessionIds,
      failedSessionIds,
      hasTerminal,
      hasRunningOnly,
      warmupLikely,
      pollCount,
      observationWindowMs
    }
  }

  private detectRepoCodeTouch(input: {
    workspaceWriteTouches: string[]
    workspaceGitRepos: string[]
  }): { touched: boolean; repo: string; path: string } {
    const touches = input.workspaceWriteTouches
      .map((item) => toPosixPath(item.trim().replace(/^\.\/+/, '')))
      .filter((item) => item.length > 0)
      .filter((item) => !item.startsWith('runs/'))

    const allRepos = dedupeStrings(
      input.workspaceGitRepos
        .map((item) => toPosixPath(item.trim().replace(/^\.\/+/, '')))
        .filter(Boolean)
    )
    const nestedRepos = allRepos.filter((item) => item !== '.')
    const repos = nestedRepos.length > 0 ? nestedRepos : allRepos

    for (const target of touches) {
      for (const repo of repos) {
        if (repo === '.') {
          return { touched: true, repo, path: target }
        }
        if (target === repo || target.startsWith(`${repo}/`)) {
          return { touched: true, repo, path: target }
        }
      }
    }

    return { touched: false, repo: '', path: '' }
  }

  private normalizeRepoId(raw: string): string {
    const token = normalizeText(raw).replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    return token || ''
  }

  private buildWorkspaceRepoRegistry(workspaceGitRepos: string[]): Array<{ repoId: string; repoPath: string }> {
    const repos = dedupeStrings(
      workspaceGitRepos
        .map((entry) => toPosixPath(entry.trim() || '.'))
        .filter(Boolean)
    )
    const sorted = repos.sort((a, b) => a.localeCompare(b))
    const usedIds = new Set<string>()
    const registry: Array<{ repoId: string; repoPath: string }> = []

    for (const repoPath of sorted) {
      const base = repoPath === '.'
        ? 'root'
        : (path.posix.basename(repoPath) || repoPath)
      let repoId = this.normalizeRepoId(base)
      if (!repoId) repoId = 'repo'
      if (usedIds.has(repoId)) {
        repoId = `${repoId}-${hashStable(repoPath)}`
      }
      usedIds.add(repoId)
      registry.push({ repoId, repoPath })
    }

    return registry
  }

  private resolveRepoFromCwd(cwd: string, workspaceGitRepos: string[]): string {
    const normalizedCwd = toPosixPath(cwd.trim().replace(/^\.\/+/, ''))
    if (!normalizedCwd) return ''

    const repos = dedupeStrings(
      workspaceGitRepos
        .map((entry) => toPosixPath(entry.trim() || '.'))
        .filter(Boolean)
    )
      .sort((a, b) => b.length - a.length)
    for (const repoPath of repos) {
      if (repoPath === '.') return '.'
      if (normalizedCwd === repoPath || normalizedCwd.startsWith(`${repoPath}/`)) {
        return repoPath
      }
    }
    return ''
  }

  private extractRepoTargetHintsFromToolEvents(toolEvents: ToolEventRecord[]): {
    repoId: string
    explicitCwd: string
  } {
    let repoId = ''
    let explicitCwd = ''
    for (const event of toolEvents) {
      if (event.phase !== 'call') continue
      const input = toPlainObject(event.input)
      if (!input) continue

      const directRepoId = safeString(input.repoId).trim() || safeString(input.repo_id).trim()
      if (directRepoId) {
        repoId = directRepoId
      }

      const eventCwd = safeString(input.cwd).trim()
      if (eventCwd) {
        explicitCwd = eventCwd
      }

      const args = this.extractScriptArgs(input.args)
      const argRepoId = this.extractScriptArgValue(args, '--repo-id')
      if (argRepoId) {
        repoId = argRepoId
      }
      const argCwd = this.extractScriptArgValue(args, '--cwd')
      if (argCwd) {
        explicitCwd = argCwd
      }
    }
    return { repoId, explicitCwd }
  }

  private resolveRepoTargetForTurn(input: {
    outcomeRepoId: string
    toolEvents: ToolEventRecord[]
    workspaceGitRepos: string[]
  }): ResolvedRepoTarget {
    const registry = this.buildWorkspaceRepoRegistry(input.workspaceGitRepos)
    const byId = new Map<string, { repoId: string; repoPath: string }>()
    const byPath = new Map<string, { repoId: string; repoPath: string }>()
    for (const item of registry) {
      byId.set(this.normalizeRepoId(item.repoId), item)
      byPath.set(item.repoPath, item)
    }

    const eventHints = this.extractRepoTargetHintsFromToolEvents(input.toolEvents)
    const outcomeRepoIdNormalized = this.normalizeRepoId(input.outcomeRepoId)
    const hintedRepoId = outcomeRepoIdNormalized || this.normalizeRepoId(eventHints.repoId)
    if (hintedRepoId) {
      const hit = byId.get(hintedRepoId)
      if (hit) {
        return {
          repoId: hit.repoId,
          repoPath: hit.repoPath,
          source: 'repo_id'
        }
      }
    }

    const eventCwd = eventHints.explicitCwd
    if (eventCwd) {
      const repoPath = this.resolveRepoFromCwd(eventCwd, input.workspaceGitRepos)
      if (repoPath) {
        const hit = byPath.get(repoPath)
        if (hit) {
          return {
            repoId: hit.repoId,
            repoPath: hit.repoPath,
            source: 'cwd'
          }
        }
      }
    }

    return { repoId: '', repoPath: '', source: 'none' }
  }

  private async scanPathAnchorViolations(input: {
    turnNumber: number
    turnStartedAt: Date
  }): Promise<{ violations: string[]; scannedPaths: number }> {
    const turnPrefix = `runs/${formatTurnId(input.turnNumber)}/`
    const turnStartedMs = input.turnStartedAt.getTime()
    const violations: string[] = []
    let scannedPaths = 0

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > PATH_ANCHOR_SCAN_MAX_DEPTH) return
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = toPosixPath(path.relative(this.yoloRoot, fullPath))
        scannedPaths += 1
        if (!relPath || relPath.startsWith('../')) continue
        if (entry.isDirectory() && REPO_SCAN_SKIP_DIRS.has(entry.name)) continue

        if (relPath.includes(`/${turnPrefix}`) && !relPath.startsWith(turnPrefix)) {
          if (entry.isFile()) {
            try {
              const stat = await fs.stat(fullPath)
              if (stat.mtimeMs >= (turnStartedMs - 1_000)) {
                violations.push(relPath)
              }
            } catch {
              // Ignore transient entries.
            }
          }
        }

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1)
        }
      }
    }

    await walk(this.yoloRoot, 0)
    return {
      violations: dedupeStrings(violations),
      scannedPaths
    }
  }

  private async recoverPathAnchorViolations(input: {
    turnNumber: number
    violations: string[]
  }): Promise<PathRewriteEvent[]> {
    const turnPrefix = `runs/${formatTurnId(input.turnNumber)}/`
    const rewriteEvents: PathRewriteEvent[] = []
    const usedTargets = new Set<string>()

    for (const fromRelPath of input.violations) {
      const idx = fromRelPath.lastIndexOf(`/${turnPrefix}`)
      if (idx < 0) continue
      const tail = fromRelPath.slice(idx + 1 + turnPrefix.length)
      const normalizedTail = toPosixPath(tail.trim().replace(/^\/+/, ''))
      if (!normalizedTail || !normalizedTail.startsWith('artifacts/')) continue

      const targetRelPath = `${turnPrefix}${normalizedTail}`
      if (usedTargets.has(targetRelPath)) continue
      usedTargets.add(targetRelPath)

      const fromAbs = path.join(this.yoloRoot, fromRelPath)
      const toAbs = path.join(this.yoloRoot, targetRelPath)
      try {
        await ensureDir(path.dirname(toAbs))
        await fs.copyFile(fromAbs, toAbs)
        rewriteEvents.push({
          from: fromRelPath,
          to: targetRelPath,
          reason: 'path_anchor_recover_copy'
        })
      } catch {
        // Best-effort recovery; failures remain visible via violation samples.
      }
    }

    return rewriteEvents
  }

  private async runPathAnchorAudit(input: {
    turnNumber: number
    turnStartedAt: Date
  }): Promise<PathAnchorAuditResult> {
    if (!this.pathAnchorAuditEnabled) {
      return {
        detected: false,
        count: 0,
        samples: [],
        rewriteEvents: [],
        scannedPaths: 0,
        nestedRunsCount: 0,
        rewrittenCount: 0,
        mode: this.pathAnchorMode
      }
    }

    const scanned = await this.scanPathAnchorViolations({
      turnNumber: input.turnNumber,
      turnStartedAt: input.turnStartedAt
    })
    const rewriteEvents = this.pathAnchorMode === 'recover'
      ? await this.recoverPathAnchorViolations({
        turnNumber: input.turnNumber,
        violations: scanned.violations
      })
      : []

    return {
      detected: scanned.violations.length > 0,
      count: scanned.violations.length,
      samples: scanned.violations.slice(0, 10),
      rewriteEvents,
      scannedPaths: scanned.scannedPaths,
      nestedRunsCount: scanned.violations.length,
      rewrittenCount: rewriteEvents.length,
      mode: this.pathAnchorMode
    }
  }

  private async writeWorkspaceChangeArtifacts(input: {
    artifactsDir: string
    workspaceWriteTouches: string[]
    workspaceGitRepos: string[]
    turnNumber: number
  }): Promise<{
    changedFilesPath: string
    patchPath: string | null
    changedFiles: string[]
  }> {
    const changedFiles = dedupeStrings(
      input.workspaceWriteTouches
        .map((entry) => toPosixPath(entry.trim()))
        .filter(Boolean)
    )
    const gitPatch = await this.collectGitPatchForTouchedFiles({
      touchedFiles: changedFiles,
      workspaceGitRepos: input.workspaceGitRepos
    })
    const changedFilesPath = path.join(input.artifactsDir, 'changed_files.json')
    await writeText(changedFilesPath, `${JSON.stringify({
      turnNumber: input.turnNumber,
      changed_files: changedFiles,
      git_repos_considered: gitPatch.reposConsidered
    }, null, 2)}\n`)

    let patchPath: string | null = null
    if (changedFiles.length > 0) {
      patchPath = path.join(input.artifactsDir, 'patch.diff')
      const lines = [
        '# runtime workspace change snapshot',
        `# turn: ${formatTurnId(input.turnNumber)}`,
        '# note: git patch is derived from touched files observed in this turn.',
        ''
      ]
      if (gitPatch.patchText.trim()) {
        lines.push(gitPatch.patchText.trimEnd())
      } else {
        lines.push('# no git patch hunks were available for touched files.')
        for (const file of changedFiles) {
          lines.push(`# touched: ${file}`)
        }
      }
      await writeText(patchPath, `${lines.join('\n')}\n`)
    }

    return { changedFilesPath, patchPath, changedFiles }
  }

  private resolveGitRepoForWorkspacePath(input: {
    workspacePath: string
    workspaceGitRepos: string[]
  }): { repoRel: string; repoFilePath: string } | null {
    const normalizedPath = toPosixPath(input.workspacePath.trim())
    if (!normalizedPath) return null

    const repos = dedupeStrings(
      input.workspaceGitRepos
        .map((entry) => toPosixPath(entry.trim() || '.'))
        .filter(Boolean)
    )
      .sort((a, b) => b.length - a.length)

    for (const repoRel of repos) {
      if (repoRel === '.') {
        return { repoRel, repoFilePath: normalizedPath }
      }
      if (normalizedPath === repoRel) {
        return { repoRel, repoFilePath: '.' }
      }
      if (normalizedPath.startsWith(`${repoRel}/`)) {
        return { repoRel, repoFilePath: normalizedPath.slice(repoRel.length + 1) }
      }
    }

    return null
  }

  private async runGitCommand(repoAbs: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
    try {
      const result = await execFile('git', ['-C', repoAbs, ...args], {
        cwd: this.config.projectPath,
        maxBuffer: 10 * 1024 * 1024
      })
      return {
        ok: true,
        stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '')
      }
    } catch (error) {
      const row = error as { stdout?: string | Buffer }
      const stdout = typeof row?.stdout === 'string' ? row.stdout : String(row?.stdout ?? '')
      return { ok: false, stdout }
    }
  }

  private async collectGitPatchForTouchedFiles(input: {
    touchedFiles: string[]
    workspaceGitRepos: string[]
  }): Promise<{ patchText: string; reposConsidered: string[] }> {
    if (input.touchedFiles.length === 0) {
      return { patchText: '', reposConsidered: [] }
    }

    const repoToFiles = new Map<string, Set<string>>()
    for (const file of input.touchedFiles) {
      const resolved = this.resolveGitRepoForWorkspacePath({
        workspacePath: file,
        workspaceGitRepos: input.workspaceGitRepos
      })
      if (!resolved) continue
      if (!repoToFiles.has(resolved.repoRel)) {
        repoToFiles.set(resolved.repoRel, new Set<string>())
      }
      repoToFiles.get(resolved.repoRel)!.add(toPosixPath(resolved.repoFilePath))
    }

    const patchParts: string[] = []
    const reposConsidered = [...repoToFiles.keys()].sort((a, b) => a.localeCompare(b))
    for (const repoRel of reposConsidered) {
      const files = [...(repoToFiles.get(repoRel) ?? new Set<string>())]
        .filter((entry) => entry && entry !== '.')
        .sort((a, b) => a.localeCompare(b))
      if (files.length === 0) continue

      const repoAbs = repoRel === '.'
        ? this.config.projectPath
        : path.resolve(this.config.projectPath, repoRel)
      const check = await this.runGitCommand(repoAbs, ['rev-parse', '--is-inside-work-tree'])
      if (!check.ok || !/true/i.test(check.stdout.trim())) continue

      const trackedDiff = await this.runGitCommand(repoAbs, ['diff', '--no-ext-diff', '--binary', '--', ...files])
      if (trackedDiff.ok && trackedDiff.stdout.trim()) {
        patchParts.push(`# repo: ${repoRel}`)
        patchParts.push(trackedDiff.stdout.trimEnd())
      }

      const untracked = await this.runGitCommand(repoAbs, ['ls-files', '--others', '--exclude-standard', '--', ...files])
      if (untracked.ok) {
        const rows = untracked.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        if (rows.length > 0) {
          patchParts.push(`# repo: ${repoRel} (untracked touched files)`)
          for (const row of rows) {
            patchParts.push(`# untracked: ${toPosixPath(row)}`)
          }
        }
      }
    }

    return {
      patchText: patchParts.join('\n\n'),
      reposConsidered
    }
  }

  private buildEvidenceRefMap(evidencePaths: string[]): Record<string, string> {
    const mapping: Record<string, string> = {}
    for (let index = 0; index < evidencePaths.length; index += 1) {
      mapping[`E${index + 1}`] = evidencePaths[index]!
    }
    return mapping
  }

  private async assertYoloEvidencePathExists(evidencePath: string, label: string): Promise<void> {
    const normalized = this.normalizeProjectPathPointer(evidencePath)
    if (!EVIDENCE_PATH_RE.test(normalized)) {
      throw new Error(`${label} evidence path must use runs/turn-xxxx/... format`)
    }

    const absolutePath = path.join(this.yoloRoot, normalized)
    if (!(await fileExists(absolutePath))) {
      throw new Error(`${label} evidence path does not exist under workspace session root: ${normalized}`)
    }
  }

  private async splitExistingEvidencePaths(
    paths: string[],
    allowMissingPaths: Set<string> = new Set<string>()
  ): Promise<{ existing: string[]; missing: string[] }> {
    const existing: string[] = []
    const missing: string[] = []

    for (const rawPath of paths) {
      const normalized = this.normalizeProjectPathPointer(rawPath)
      if (!normalized || !EVIDENCE_PATH_RE.test(normalized)) continue
      if (allowMissingPaths.has(normalized)) {
        existing.push(normalized)
        continue
      }
      const absolutePath = path.join(this.yoloRoot, normalized)
      if (await fileExists(absolutePath)) {
        existing.push(normalized)
      } else {
        missing.push(normalized)
      }
    }

    return {
      existing: dedupeStrings(existing),
      missing: dedupeStrings(missing)
    }
  }

  private resolveEvidenceReference(rawPath: string, evidenceRefMap: Record<string, string>): string {
    const token = rawPath.trim().toUpperCase()
    if (/^E\d+$/.test(token) && evidenceRefMap[token]) {
      return evidenceRefMap[token]!
    }
    return rawPath
  }

  private attachRuntimeEvidenceToProjectUpdate(input: {
    update: ProjectUpdate
    evidenceRefMap: Record<string, string>
    fallbackEvidencePath: string
  }): { update: ProjectUpdate; notes: string[] } {
    const notes: string[] = []
    const next: ProjectUpdate = { ...input.update }

    const normalizeEvidenceRows = (rows: unknown[] | undefined, label: string): EvidenceLine[] | undefined => {
      if (!Array.isArray(rows)) return undefined
      const out: EvidenceLine[] = []
      for (const row of rows) {
        if (typeof row === 'string') {
          const text = row.trim()
          if (!text) continue
          out.push({ text, evidencePath: input.fallbackEvidencePath })
          notes.push(`${label}: attached fallback evidence bundle for 1 text-only row.`)
          continue
        }
        const record = toPlainObject(row)
        const text = safeString(record?.text).trim()
        if (!text) continue
        const rawPath = safeString(record?.evidencePath).trim()
        const resolved = rawPath
          ? this.resolveEvidenceReference(rawPath, input.evidenceRefMap)
          : input.fallbackEvidencePath
        if (!rawPath) {
          notes.push(`${label}: attached fallback evidence bundle for 1 row without evidencePath.`)
        }
        out.push({
          text,
          evidencePath: resolved || input.fallbackEvidencePath
        })
      }
      return out
    }

    const facts = normalizeEvidenceRows(next.facts as unknown[] | undefined, 'Facts')
    if (facts) next.facts = facts
    const constraints = normalizeEvidenceRows(next.constraints as unknown[] | undefined, 'Constraints')
    if (constraints) next.constraints = constraints
    const done = normalizeEvidenceRows(next.done as unknown[] | undefined, 'Done')
    if (done) next.done = done

    if (Array.isArray(next.claims)) {
      const claims = []
      for (const row of next.claims as unknown[]) {
        const record = toPlainObject(row)
        const claimText = safeString(record?.claim).trim()
        if (!claimText) continue
        const statusRaw = normalizeText(safeString(record?.status).trim())
        const status = statusRaw === 'covered' || statusRaw === 'partial' || statusRaw === 'uncovered'
          ? statusRaw
          : 'uncovered'
        const rawEvidence = Array.isArray(record?.evidencePaths)
          ? record?.evidencePaths
          : (typeof record?.evidencePath === 'string' ? [record.evidencePath] : [])
        const evidencePaths = dedupeStrings(
          rawEvidence
            .filter((value): value is string => typeof value === 'string')
            .map((value) => this.resolveEvidenceReference(value, input.evidenceRefMap).trim())
            .filter(Boolean)
        )
        const linkedEvidence = evidencePaths.length > 0
          ? evidencePaths
          : [input.fallbackEvidencePath]
        if (evidencePaths.length === 0) {
          notes.push(`Claim "${claimText}": attached fallback evidence bundle.`)
        }
        claims.push({
          claim: claimText,
          status,
          evidencePaths: linkedEvidence
        })
      }
      next.claims = claims
    }

    return { update: next, notes: dedupeStrings(notes) }
  }

  private async normalizeAndValidateEvidenceLines(lines: EvidenceLine[], label: string): Promise<EvidenceLine[]> {
    const normalized: EvidenceLine[] = []
    for (const line of lines) {
      const text = line.text.trim()
      const evidencePath = this.normalizeProjectPathPointer(line.evidencePath)
      if (!text) {
        throw new Error(`${label} entry text is required`)
      }
      if (!evidencePath) {
        throw new Error(`${label} evidencePath is required`)
      }
      await this.assertYoloEvidencePathExists(evidencePath, label)
      normalized.push({ text, evidencePath })
    }
    return normalized
  }

  private async normalizeAndValidateProjectUpdate(update: ProjectUpdate): Promise<{ update: ProjectUpdate; notes: string[] }> {
    const normalized: ProjectUpdate = { ...update }
    const notes: string[] = []

    if (update.facts) {
      normalized.facts = await this.normalizeAndValidateEvidenceLines(update.facts, 'Facts')
    }
    if (update.constraints) {
      normalized.constraints = await this.normalizeAndValidateEvidenceLines(update.constraints, 'Constraints')
    }
    if (update.done) {
      normalized.done = await this.normalizeAndValidateEvidenceLines(update.done, 'Done')
    }

    if (update.claims) {
      normalized.claims = []
      for (const claim of update.claims) {
        const evidencePaths: string[] = []
        for (const rawPath of claim.evidencePaths) {
          const evidencePath = this.normalizeProjectPathPointer(rawPath)
          await this.assertYoloEvidencePathExists(evidencePath, `Claim "${claim.claim}"`)
          evidencePaths.push(evidencePath)
        }
        normalized.claims.push({
          claim: claim.claim,
          status: claim.status,
          evidencePaths
        })
      }
    }

    if (update.keyArtifacts) {
      const keyArtifacts: string[] = []
      for (const rawPath of update.keyArtifacts) {
        const pointer = this.normalizeProjectPathPointer(rawPath)
        if (!pointer) continue
        if (!EVIDENCE_PATH_RE.test(pointer)) {
          notes.push(`Dropped keyArtifact outside runs scope: ${pointer}`)
          continue
        }
        const absolutePath = path.join(this.yoloRoot, pointer)
        if (!(await fileExists(absolutePath))) {
          throw new Error(`keyArtifacts path does not exist under workspace session root: ${pointer}`)
        }
        keyArtifacts.push(pointer)
      }
      normalized.keyArtifacts = dedupeStrings(keyArtifacts)
    }

    if (update.planBoard) {
      normalized.planBoard = []
      for (const item of update.planBoard) {
        const evidencePaths: string[] = []
        for (const rawPath of item.evidencePaths ?? []) {
          const pointer = this.normalizeProjectPathPointer(rawPath)
          if (!pointer) continue
          await this.assertYoloEvidencePathExists(pointer, `Plan Board ${item.id}`)
          evidencePaths.push(pointer)
        }
        const doneDefinition = this.normalizeDoneDefinitionRows({
          lines: item.doneDefinition ?? [],
          planId: item.id,
          notes
        })
        normalized.planBoard.push({
          ...item,
          id: normalizePlanId(item.id) || item.id,
          doneDefinition: dedupeStrings(doneDefinition),
          evidencePaths: dedupeStrings(evidencePaths),
          nextMinStep: item.nextMinStep?.trim() || undefined,
          dropReason: item.dropReason?.trim() || undefined,
          replacedBy: normalizePlanId(item.replacedBy ?? '') || null
        })
      }
    }

    return {
      update: normalized,
      notes: dedupeStrings(notes)
    }
  }

  private classifyEnvironmentConstraint(text: string): EnvConstraintCategory | null {
    const normalized = normalizeText(text)
    if (!ENV_ASSERTION_NEGATION_RE.test(normalized)) return null
    if (ENV_ASSERTION_API_KEY_RE.test(normalized)) return 'api_key'
    if (ENV_ASSERTION_REPO_RE.test(normalized)) return 'repo_checkout'
    if (ENV_ASSERTION_RESOURCE_RE.test(normalized)) return 'resource'
    return null
  }

  private hasEnvironmentConstraintProof(input: {
    category: EnvConstraintCategory
    evidenceText: string
    toolSignalText: string
  }): boolean {
    const merged = `${input.evidenceText}\n${input.toolSignalText}`
    if (input.category === 'api_key') return ENV_PROOF_API_KEY_RE.test(merged)
    if (input.category === 'repo_checkout') return ENV_PROOF_REPO_RE.test(merged)
    return ENV_PROOF_RESOURCE_RE.test(merged)
  }

  private collectFailedToolSignalText(toolEvents: ToolEventRecord[]): string {
    const chunks: string[] = []
    for (const event of toolEvents) {
      if (event.phase !== 'result') continue

      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const eventSuccess = typeof event.success === 'boolean'
        ? event.success
        : (typeof resultObj?.success === 'boolean' ? resultObj.success : false)
      if (eventSuccess) continue

      const fragment = [
        safeString(event.tool).trim(),
        safeString(event.error).trim(),
        safeString(dataObj?.stderr).trim(),
        safeString(dataObj?.stdout).trim()
      ]
        .filter(Boolean)
        .join('\n')
        .trim()
      if (fragment) chunks.push(fragment)
    }

    return normalizeText(chunks.join('\n')).slice(0, 20_000)
  }

  private collectSemanticHardViolations(input: {
    blockedReason: string | null
    toolEvents: ToolEventRecord[]
  }): string[] {
    const violations: string[] = []
    const blocked = normalizeText(input.blockedReason || '')
    if (blocked && blocked !== 'missing_plan_deliverable_touch') {
      violations.push(`blocked_reason:${blocked}`)
    }

    const failedToolSignal = this.collectFailedToolSignalText(input.toolEvents)
    if (SEMANTIC_HARD_POLICY_RE.test(failedToolSignal)) {
      violations.push('policy_denied')
    }
    if (SEMANTIC_HARD_PATH_RE.test(failedToolSignal)) {
      violations.push('path_escape')
    }

    return dedupeStrings(violations)
  }

  private async readEvidencePreviewText(evidencePath: string): Promise<string> {
    const pointer = this.normalizeProjectPathPointer(evidencePath)
    if (!pointer || !EVIDENCE_PATH_RE.test(pointer)) return ''
    const absolutePath = path.join(this.yoloRoot, pointer)
    if (!(await fileExists(absolutePath))) return ''
    return normalizeText((await readTextOrEmpty(absolutePath)).slice(0, 20_000))
  }

  private async demoteSpeculativeEnvironmentConstraints(input: {
    update: ProjectUpdate
    toolEvents: ToolEventRecord[]
  }): Promise<{ update: ProjectUpdate; notes: string[] }> {
    const constraints = input.update.constraints
    if (!constraints || constraints.length === 0) {
      return { update: input.update, notes: [] }
    }

    const toolSignalText = this.collectFailedToolSignalText(input.toolEvents)
    const nextConstraints: EvidenceLine[] = []
    const demotedHypotheses: string[] = []

    for (const row of constraints) {
      const text = row.text.trim()
      if (!text) continue
      const category = this.classifyEnvironmentConstraint(text)
      if (!category) {
        nextConstraints.push(row)
        continue
      }

      const evidenceText = await this.readEvidencePreviewText(row.evidencePath)
      const hasProof = this.hasEnvironmentConstraintProof({
        category,
        evidenceText,
        toolSignalText
      })
      if (hasProof) {
        nextConstraints.push(row)
        continue
      }

      demotedHypotheses.push(text)
    }

    if (demotedHypotheses.length === 0) {
      return { update: input.update, notes: [] }
    }

    const nextUpdate: ProjectUpdate = {
      ...input.update,
      constraints: nextConstraints
    }
    nextUpdate.hypotheses = dedupeStrings([
      ...(input.update.hypotheses ?? []),
      ...demotedHypotheses
    ])

    return {
      update: nextUpdate,
      notes: dedupeStrings([
        `Demoted ${demotedHypotheses.length} speculative environment constraint(s) to hypotheses (missing tool-backed proof).`
      ])
    }
  }

  private filterProjectUpdateForGovernanceWindow(input: {
    update: ProjectUpdate
    plannerCheckpointDue: boolean
  }): { update: ProjectUpdate | null; notes: string[] } {
    const notes: string[] = []
    const next: ProjectUpdate = { ...input.update }

    if (!input.plannerCheckpointDue) {
      if (next.planBoard) {
        delete next.planBoard
        notes.push('Plan Board update ignored: structural edits are allowed only during planner checkpoint turns.')
      }
      if (next.currentPlan) {
        delete next.currentPlan
        notes.push('Current Plan rewrite ignored: structural edits are allowed only during planner checkpoint turns.')
      }
    }

    return {
      update: Object.keys(next).length > 0 ? next : null,
      notes
    }
  }

  private async resolveWorkspaceFileForEvidence(rawPath: string): Promise<string | null> {
    const trimmed = rawPath.trim()
    if (!trimmed) return null

    const candidates = path.isAbsolute(trimmed)
      ? [trimmed]
      : [path.resolve(this.config.projectPath, trimmed), path.resolve(this.yoloRoot, trimmed)]
    const seen = new Set<string>()

    for (const candidate of candidates) {
      const normalizedCandidate = path.normalize(candidate)
      if (seen.has(normalizedCandidate)) continue
      seen.add(normalizedCandidate)

      try {
        const safePath = this.ensureSafeTargetPath(normalizedCandidate)
        const stat = await fs.stat(safePath)
        if (stat.isFile()) return safePath
      } catch {
        // Ignore invalid or missing candidates.
      }
    }

    return null
  }

  private async snapshotEvidenceIntoTurn(input: {
    sourceAbsPath: string
    artifactsDir: string
    usedFileNames: Set<string>
  }): Promise<string> {
    const evidenceDir = path.join(input.artifactsDir, 'evidence')
    await ensureDir(evidenceDir)

    const parsed = path.parse(input.sourceAbsPath)
    const safeStem = slugifyForFile(parsed.name || 'evidence')
    const ext = parsed.ext || '.txt'

    let fileName = `${safeStem}${ext}`
    let index = 2
    while (input.usedFileNames.has(fileName) || await fileExists(path.join(evidenceDir, fileName))) {
      fileName = `${safeStem}-${index}${ext}`
      index += 1
    }
    input.usedFileNames.add(fileName)

    const targetPath = path.join(evidenceDir, fileName)
    await fs.copyFile(input.sourceAbsPath, targetPath)
    return this.toEvidencePath(targetPath)
  }

  private async repairProjectUpdateEvidencePaths(input: {
    update: ProjectUpdate
    artifactsDir: string
    validationMessage: string
  }): Promise<{ update: ProjectUpdate; notes: string[] } | null> {
    if (!/evidence path|keyArtifacts path/i.test(input.validationMessage)) {
      return null
    }

    const notes: string[] = []
    const repaired: ProjectUpdate = { ...input.update }
    const usedFileNames = new Set<string>()
    let changed = false

    const normalizeOrSnapshot = async (rawPath: string, label: string): Promise<string | null> => {
      const normalized = this.normalizeProjectPathPointer(rawPath)
      if (normalized && EVIDENCE_PATH_RE.test(normalized)) {
        const absolutePath = path.join(this.yoloRoot, normalized)
        if (await fileExists(absolutePath)) {
          return normalized
        }
      }

      const sourceAbsPath = await this.resolveWorkspaceFileForEvidence(rawPath)
      if (!sourceAbsPath) return null

      const snapshotPath = await this.snapshotEvidenceIntoTurn({
        sourceAbsPath,
        artifactsDir: input.artifactsDir,
        usedFileNames
      })
      changed = true
      notes.push(`PROJECT.md repair: snapshot ${label} evidence -> ${snapshotPath}`)
      return snapshotPath
    }

    if (repaired.facts) {
      const nextFacts: EvidenceLine[] = []
      for (const line of repaired.facts) {
        const repairedPath = await normalizeOrSnapshot(line.evidencePath, 'Facts')
        if (!repairedPath) {
          return null
        }
        if (repairedPath !== line.evidencePath.trim()) changed = true
        nextFacts.push({ ...line, evidencePath: repairedPath })
      }
      repaired.facts = nextFacts
    }

    if (repaired.constraints) {
      const nextConstraints: EvidenceLine[] = []
      for (const line of repaired.constraints) {
        const repairedPath = await normalizeOrSnapshot(line.evidencePath, 'Constraints')
        if (!repairedPath) {
          return null
        }
        if (repairedPath !== line.evidencePath.trim()) changed = true
        nextConstraints.push({ ...line, evidencePath: repairedPath })
      }
      repaired.constraints = nextConstraints
    }

    if (repaired.done) {
      const nextDone: EvidenceLine[] = []
      for (const line of repaired.done) {
        const repairedPath = await normalizeOrSnapshot(line.evidencePath, 'Done')
        if (!repairedPath) {
          return null
        }
        if (repairedPath !== line.evidencePath.trim()) changed = true
        nextDone.push({ ...line, evidencePath: repairedPath })
      }
      repaired.done = nextDone
    }

    if (repaired.claims) {
      const nextClaims = []
      for (const claim of repaired.claims) {
        const nextEvidencePaths: string[] = []
        for (const entry of claim.evidencePaths) {
          const repairedPath = await normalizeOrSnapshot(entry, `Claim "${claim.claim}"`)
          if (!repairedPath) {
            return null
          }
          if (repairedPath !== entry.trim()) changed = true
          nextEvidencePaths.push(repairedPath)
        }

        const dedupedEvidencePaths = dedupeStrings(nextEvidencePaths)
        const nextStatus = dedupedEvidencePaths.length === 0 && claim.status !== 'uncovered'
          ? 'uncovered'
          : claim.status
        if (nextStatus !== claim.status) {
          changed = true
          notes.push(`PROJECT.md repair: downgraded claim "${claim.claim}" status to uncovered (no evidence paths)`)
        }
        nextClaims.push({
          ...claim,
          evidencePaths: dedupedEvidencePaths,
          status: nextStatus
        })
      }
      repaired.claims = nextClaims
    }

    if (repaired.planBoard) {
      const nextPlanBoard = []
      for (const item of repaired.planBoard) {
        const nextEvidencePaths: string[] = []
        for (const entry of item.evidencePaths ?? []) {
          const normalized = this.normalizeProjectPathPointer(entry)
          if (!normalized || !EVIDENCE_PATH_RE.test(normalized)) {
            changed = true
            notes.push(`PROJECT.md repair: dropped non-runs Plan ${item.id} evidence path.`)
            continue
          }
          const exists = await fileExists(path.join(this.yoloRoot, normalized))
          if (!exists) {
            changed = true
            notes.push(`PROJECT.md repair: dropped missing Plan ${item.id} evidence path: ${normalized}`)
            continue
          }
          if (normalized !== entry.trim()) changed = true
          nextEvidencePaths.push(normalized)
        }
        nextPlanBoard.push({
          ...item,
          evidencePaths: dedupeStrings(nextEvidencePaths)
        })
      }
      repaired.planBoard = nextPlanBoard
    }

    if (repaired.keyArtifacts) {
      const nextArtifacts: string[] = []
      for (const entry of repaired.keyArtifacts) {
        const normalized = this.normalizeProjectPathPointer(entry)
        if (!normalized || !EVIDENCE_PATH_RE.test(normalized)) {
          changed = true
          notes.push(`PROJECT.md repair: dropped keyArtifact outside runs scope.`)
          continue
        }
        const exists = await fileExists(path.join(this.yoloRoot, normalized))
        if (!exists) {
          changed = true
          notes.push(`PROJECT.md repair: dropped missing keyArtifact: ${normalized}`)
          continue
        }
        if (normalized !== entry.trim()) changed = true
        nextArtifacts.push(normalized)
      }
      repaired.keyArtifacts = dedupeStrings(nextArtifacts)
    }

    if (!changed) return null
    return {
      update: repaired,
      notes: dedupeStrings(notes)
    }
  }

  private async writeToolEventsJsonl(eventsPath: string, toolEvents: ToolEventRecord[]): Promise<void> {
    if (toolEvents.length === 0) {
      await writeText(eventsPath, '')
      return
    }
    await writeText(eventsPath, toolEvents.map((event) => buildJsonLine(event)).join(''))
  }

  private async runNativeTurn(input: {
    context: TurnContext
    turnNumber: number
    turnDir: string
    artifactsDir: string
    pendingUserInputs: PendingUserInput[]
    preflightNotes: string[]
  }): Promise<TurnExecutionResult> {
    const runtime = input.context.project.defaultRuntime || this.config.defaultRuntime || DEFAULT_RUNTIME
    const orchestrationMode: ResolvedOrchestrationMode = input.context.orchestrationMode ?? 'artifact_gravity_v3_paper'
    const northStar = input.context.northStar
    const artifactGravityMode = isArtifactGravityMode(orchestrationMode)
    const paperMode = isArtifactGravityPaperMode(orchestrationMode)
    const northStarNoDeltaStreak = artifactGravityMode
      ? await this.countConsecutiveNoDeltaTurns(12, input.turnNumber - 1)
      : 0
    const northStarNoRealityCheckExecutionStreak = paperMode
      ? await this.countConsecutiveTurnsWithoutRealityCheckExecution(12, input.turnNumber - 1)
      : 0
    const northStarNoExternalCheckSuccessStreak = paperMode
      ? await this.countConsecutiveTurnsWithoutExternalCheckSuccess(20, input.turnNumber - 1)
      : 0
    const previousNorthStarScoreboardValues = paperMode
      ? await this.loadPreviousNorthStarScoreboard(input.turnNumber - 1)
      : {}
    const northStarPivotAllowed = artifactGravityMode
      ? Boolean(
          input.context.northStarPivotAllowed === true
          || northStarNoDeltaStreak >= NORTHSTAR_NO_DELTA_PIVOT_THRESHOLD
          || (paperMode && northStarNoRealityCheckExecutionStreak >= NORTHSTAR_REALITYCHECK_NO_EXEC_PIVOT_THRESHOLD)
        )
      : false
    const northStarContractSnapshot = artifactGravityMode
      ? await this.captureNorthStarContractSnapshot()
      : null
    const previousNorthStarGateSatisfied = artifactGravityMode
      ? await this.loadPreviousNorthStarGateSatisfied(input.turnNumber - 1)
      : null
    const northStarBaseline = await this.captureNorthStarBaseline(northStar)
    this.activeTurnArtifactsDirRel = `runs/${formatTurnId(input.turnNumber)}/artifacts`
    const turnPaths = this.buildNativeTurnFilePaths({
      turnDir: input.turnDir,
      artifactsDir: input.artifactsDir
    })
    const {
      cmdPath,
      stdoutPath,
      stderrPath,
      exitCodePath,
      resultPath,
      toolEventsPath,
      rawOutputPath
    } = turnPaths
    const northStarSemanticGateConfig = this.resolveNorthStarSemanticGateConfig({
      orchestrationMode,
      northStar
    })
    const northStarSemanticGateAudit: NorthStarSemanticGateAuditRecord = {
      enabled: northStarSemanticGateConfig.enabled,
      mode: northStarSemanticGateConfig.mode,
      eligible: false,
      invoked: false,
      prompt_version: NORTHSTAR_SEMANTIC_GATE_PROMPT_VERSION,
      model_id: northStarSemanticGateConfig.model,
      temperature: NORTHSTAR_SEMANTIC_GATE_TEMPERATURE,
      input_hash: '',
      output: null,
      accepted: false
    }

    const turnStartedAt = this.now()
    const { outcome, consumedPendingUserInputs } = await this.executeNativeTurnOutcome({
      context: input.context,
      pendingUserInputs: input.pendingUserInputs
    })

    const toolEvents = Array.isArray(outcome.toolEvents) ? outcome.toolEvents : []
    await this.writeToolEventsJsonl(toolEventsPath, toolEvents)
    const literatureCache = await this.persistLiteratureCacheFromToolEvents({
      turnNumber: input.turnNumber,
      artifactsDir: input.artifactsDir,
      toolEvents
    })

    if (typeof outcome.rawOutput === 'string' && outcome.rawOutput.trim()) {
      await writeText(rawOutputPath, `${outcome.rawOutput}\n`)
    }

    let finalStatus: TurnStatus = this.normalizeNativeStatus(outcome.status)
    const intent = outcome.intent?.trim() || 'Native turn execution'
    let summary = outcome.summary?.trim() || 'Turn completed without summary.'
    const primaryAction = outcome.primaryAction?.trim() || this.inferPrimaryActionFromToolEvents(toolEvents)
    const plannerCheckpointDue = Boolean(input.context.plannerCheckpoint?.due)
    const hintedDeltaText = safeString(outcome.delta).trim()
    const dropReason = safeString(outcome.dropReason).trim()
    const replacedBy = outcome.replacedBy === null
      ? null
      : (normalizePlanId(outcome.replacedBy ?? '') || undefined)
    const hintedActivePlanId = normalizePlanId(outcome.activePlanId ?? '')
    const hintedRepoId = safeString(outcome.repoId).trim()

    const normalizedOutcomeEvidencePathsRaw = dedupeStrings(
      (outcome.evidencePaths ?? [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => this.normalizeProjectPathPointer(entry))
        .filter((entry) => EVIDENCE_PATH_RE.test(entry))
    )
    let latestFailure = this.extractLatestFailureSnapshot(toolEvents)
    const bashSnapshot = this.extractLastBashSnapshot(toolEvents, runtime)

    const cmd = bashSnapshot?.cmd || primaryAction || 'agent.run'
    const stdout = bashSnapshot?.stdout || ''
    const stderr = bashSnapshot?.stderr || ''
    const cwd = bashSnapshot?.cwd || this.config.projectPath
    let exitCode = typeof bashSnapshot?.exitCode === 'number'
      ? bashSnapshot.exitCode
      : (finalStatus === 'success' || finalStatus === 'stopped' || finalStatus === 'ask_user' || finalStatus === 'no_delta' ? 0 : 1)

    if (exitCode !== 0 && finalStatus === 'success') {
      finalStatus = 'failure'
    }

    const timeoutReconcile = await this.reconcileCodingLargeRepoTimeoutFailure({
      finalStatus,
      latestFailure,
      turnStartedAt
    })
    if (timeoutReconcile.recovered) {
      finalStatus = 'success'
      latestFailure = timeoutReconcile.latestFailure
      exitCode = typeof timeoutReconcile.exitCode === 'number' ? timeoutReconcile.exitCode : 0
      summary = `${timeoutReconcile.summaryNote} ${summary}`.trim()
    }

    await this.writeProvisionalTurnArtifacts({
      paths: turnPaths,
      status: finalStatus,
      cmd,
      stdout,
      stderr,
      exitCode
    })

    const workspaceWriteTouches = this.collectWorkspaceWriteTouches(toolEvents)
    const codingLargeRepoUsage = this.detectCodingLargeRepoUsage(toolEvents)
    const codingAgentSessionObservation = this.observeCodingAgentSessions(toolEvents)
    const repoCodeTouch = this.detectRepoCodeTouch({
      workspaceWriteTouches,
      workspaceGitRepos: input.context.workspaceGitRepos ?? []
    })
    const resolvedRepoTarget = this.resolveRepoTargetForTurn({
      outcomeRepoId: hintedRepoId,
      toolEvents,
      workspaceGitRepos: input.context.workspaceGitRepos ?? []
    })
    const workspaceChangeArtifacts = await this.writeWorkspaceChangeArtifacts({
      artifactsDir: input.artifactsDir,
      workspaceWriteTouches,
      workspaceGitRepos: input.context.workspaceGitRepos ?? [],
      turnNumber: input.turnNumber
    })
    const pathAnchorAudit = await this.runPathAnchorAudit({
      turnNumber: input.turnNumber,
      turnStartedAt
    })
    if (pathAnchorAudit.detected && pathAnchorAudit.mode === 'fail') {
      finalStatus = 'blocked'
      summary = `PATH_ANCHOR_VIOLATION: detected ${pathAnchorAudit.count} non-canonical turn artifact write(s). ${summary}`
    }

    const implicitTurnEvidencePaths = new Set<string>([
      this.toEvidencePath(cmdPath),
      this.toEvidencePath(stdoutPath),
      this.toEvidencePath(stderrPath),
      this.toEvidencePath(exitCodePath),
      this.toEvidencePath(resultPath),
      this.toEvidencePath(toolEventsPath),
      this.toEvidencePath(workspaceChangeArtifacts.changedFilesPath)
    ])
    if (workspaceChangeArtifacts.patchPath) {
      implicitTurnEvidencePaths.add(this.toEvidencePath(workspaceChangeArtifacts.patchPath))
    }
    const {
      existing: normalizedOutcomeEvidencePaths,
      missing: missingOutcomeEvidencePaths
    } = await this.splitExistingEvidencePaths(normalizedOutcomeEvidencePathsRaw, implicitTurnEvidencePaths)

    const turnEndedAt = this.now()
    const durationSecRaw = (turnEndedAt.getTime() - turnStartedAt.getTime()) / 1000
    const durationSec = Number.isFinite(durationSecRaw)
      ? Math.max(0, Number(durationSecRaw.toFixed(3)))
      : 0

    const errorLine = exitCode === 0 ? '' : (firstNonEmptyLine(stderr, stdout) || `exit code ${exitCode}`)
    const deterministicFingerprint = (
      finalStatus === 'failure' && cmd && exitCode !== 0 && isDeterministicFailure(errorLine)
        ? buildFailureFingerprint(cmd, errorLine, runtime)
        : null
    )

    let failureEntry: FailureEntry | null = null
    if (deterministicFingerprint) {
      failureEntry = await this.failureStore.recordDeterministicFailure({
        cmd,
        runtime,
        fingerprint: deterministicFingerprint,
        errorLine,
        evidencePath: this.toEvidencePath(stderrPath),
        alternatives: []
      })
      if (failureEntry?.status === 'BLOCKED') {
        finalStatus = 'blocked'
        // Promote to PROJECT.md constraint
        try {
          await this.projectStore.applyUpdate({
            constraints: [{
              text: `[ENV-BLOCKED] ${failureEntry.cmd}: ${failureEntry.errorLine} (${failureEntry.runtime})`,
              evidencePath: failureEntry.evidencePath
            }]
          })
        } catch { /* best-effort */ }
      }
    }

    let clearedBlocked = false
    if (!deterministicFingerprint && exitCode === 0 && bashSnapshot) {
      clearedBlocked = await this.failureStore.clearBlockedAfterVerifiedSuccess({
        cmd: bashSnapshot.cmd,
        runtime,
        resolved: 'Successful native verification after remediation.',
        evidencePath: this.toEvidencePath(resultPath)
      })
    }

    const actionFingerprint = this.buildActionFingerprint({
      toolEvents,
      primaryAction,
      cmd
    })
    const actionType = normalizeText(actionFingerprint.split(':')[0] || 'agent') || 'agent'
    const priorFingerprintCount = await this.countRecentActionFingerprintMatches(actionFingerprint)
    const doneFingerprintHit = input.context.project.done.some((item) => normalizeText(item.text) === normalizeText(actionFingerprint))

    const evidencePaths = [
      this.toEvidencePath(cmdPath),
      this.toEvidencePath(resultPath),
      this.toEvidencePath(stdoutPath),
      this.toEvidencePath(stderrPath),
      this.toEvidencePath(exitCodePath),
      this.toEvidencePath(toolEventsPath),
      this.toEvidencePath(workspaceChangeArtifacts.changedFilesPath),
      ...pathAnchorAudit.rewriteEvents.map((event) => event.to)
    ]
    if (workspaceChangeArtifacts.patchPath) {
      evidencePaths.push(this.toEvidencePath(workspaceChangeArtifacts.patchPath))
    }

    if (typeof outcome.rawOutput === 'string' && outcome.rawOutput.trim()) {
      evidencePaths.push(this.toEvidencePath(rawOutputPath))
    }
    if (literatureCache.evidencePath) {
      evidencePaths.push(literatureCache.evidencePath)
    }

    if (finalStatus === 'ask_user') {
      const askPath = path.join(input.artifactsDir, 'ask-user.md')
      const runtimeAskPayload = this.buildRuntimeAskUserPayload({
        modelSummary: summary,
        modelQuestion: outcome.askQuestion?.trim() || '',
        latestFailure
      })
      await writeText(askPath, runtimeAskPayload.markdown)
      evidencePaths.push(this.toEvidencePath(askPath))
      summary = runtimeAskPayload.summary || summary || 'User input required to proceed.'
    }

    if (consumedPendingUserInputs) {
      evidencePaths.push(...input.pendingUserInputs.map((item) => item.evidencePath))
    }

    const businessArtifactEvidencePaths = await this.collectBusinessArtifactEvidencePaths(input.artifactsDir)
    const governanceOnlyTurn = this.isGovernanceOnlyTurn({
      actionType,
      businessArtifactEvidencePaths,
      workspaceWriteTouches: workspaceChangeArtifacts.changedFiles
    })
    evidencePaths.push(...businessArtifactEvidencePaths)
    evidencePaths.push(...normalizedOutcomeEvidencePaths)

    const uniqueEvidencePaths = dedupeStrings(evidencePaths)
    const evidenceRefMap = this.buildEvidenceRefMap(uniqueEvidencePaths)
    const runtimeControlEvidencePaths = dedupeStrings([
      this.toEvidencePath(workspaceChangeArtifacts.changedFilesPath),
      ...(workspaceChangeArtifacts.patchPath ? [this.toEvidencePath(workspaceChangeArtifacts.patchPath)] : [])
    ])
    const explicitPlanEvidencePaths = dedupeStrings([
      ...normalizedOutcomeEvidencePaths,
      ...businessArtifactEvidencePaths,
      ...runtimeControlEvidencePaths
    ])
    const defaultPlanEvidencePaths = [
      this.toEvidencePath(resultPath),
      this.toEvidencePath(cmdPath),
      this.toEvidencePath(stdoutPath),
      this.toEvidencePath(stderrPath)
    ]
    const planEvidencePaths = dedupeStrings([
      ...explicitPlanEvidencePaths,
      ...defaultPlanEvidencePaths
    ])
    const northStarEvaluation = await this.evaluateNorthStarTurn({
      orchestrationMode,
      northStar,
      baseline: northStarBaseline,
      toolEvents,
      noDeltaStreak: northStarNoDeltaStreak,
      noRealityCheckExecutionStreak: northStarNoRealityCheckExecutionStreak,
      noExternalCheckSuccessStreak: northStarNoExternalCheckSuccessStreak,
      previousGateSatisfied: previousNorthStarGateSatisfied,
      previousScoreboardValues: previousNorthStarScoreboardValues,
      pivotAllowed: northStarPivotAllowed
    })
    const northStarPivotHardGate = await this.enforceNorthStarPivotHardGate({
      orchestrationMode,
      policyViolations: northStarEvaluation.policyViolations,
      beforeSnapshot: northStarContractSnapshot
    })
    if (northStarPivotHardGate.applied) {
      northStarEvaluation.pivotRollbackApplied = true
      northStarEvaluation.pivotRollbackViolation = northStarPivotHardGate.violation
    } else if (northStarPivotHardGate.restoreError) {
      northStarEvaluation.policyViolations = dedupeStrings([
        ...northStarEvaluation.policyViolations,
        'northstar_pivot_rollback_failed'
      ])
      if (!northStarEvaluation.reason) {
        northStarEvaluation.reason = 'northstar_pivot_rollback_failed'
      }
    }

    const deltaReasons: string[] = []
    if (bashSnapshot?.cmd?.trim() && bashSnapshot.exitCode === 0) {
      const hasOutput = (bashSnapshot.stdout?.trim().length || 0) > 0
      if (hasOutput || businessArtifactEvidencePaths.length > 0) {
        deltaReasons.push('reproducible_exec_bundle')
      }
    }
    if (businessArtifactEvidencePaths.length > 0) deltaReasons.push('artifact_file')
    if (workspaceChangeArtifacts.changedFiles.length > 0) deltaReasons.push('workspace_file')
    if (failureEntry) deltaReasons.push('failure_recorded')
    if (clearedBlocked) deltaReasons.push('blocked_cleared')
    if (timeoutReconcile.recovered) deltaReasons.push('coding_agent_timeout_reconciled')
    if (northStarEvaluation.artifactChanged) deltaReasons.push('northstar_artifact_changed')
    if (northStarEvaluation.verifySucceeded) deltaReasons.push('northstar_verify_succeeded')

    // Stagnation enforcement: repeated dominant action type without strong delta
    // (stage advancement or blocker transitions) is treated as no progress.
    if (input.context.stagnation?.stagnant && finalStatus === 'success' && !governanceOnlyTurn) {
      const dominantAction = normalizeText(input.context.stagnation.dominantAction)
      const repeatedDominant = dominantAction && actionType === dominantAction

      if (repeatedDominant) {
        const previousDeliverables = await this.findProducedDeliverables({
          maxTurnsToScan: 50,
          maxTurnNumber: input.turnNumber - 1
        })
        const previousStage = this.inferStage(previousDeliverables)
        const currentTurnEntries = await this.collectArtifactEntryNames(input.artifactsDir)
        const currentTurnDeliverables = this.extractDeliverablePatternsFromEntries(currentTurnEntries)
        const nextDeliverables = new Set<string>([...previousDeliverables, ...currentTurnDeliverables])
        const nextStage = this.inferStage(nextDeliverables)
        const stageAdvanced = this.isStageAdvanced(previousStage, nextStage)
        if (stageAdvanced && !deltaReasons.includes('stage_advanced')) {
          deltaReasons.push('stage_advanced')
        }

        const hasStrongDelta = deltaReasons.includes('blocked_cleared')
          || deltaReasons.includes('failure_recorded')
          || stageAdvanced

        if (!hasStrongDelta) {
          deltaReasons.length = 0
        }
      }
    }

    const planProgress = this.prepareNativeTurnPlanProgress({
      orchestrationMode,
      plannerCheckpointDue,
      outcomeProjectUpdate: outcome.projectUpdate,
      currentBoard: input.context.project.planBoard,
      explicitPlanEvidencePaths,
      workspaceWriteTouches,
      hintedActivePlanId,
      clearedBlocked,
      finalStatus,
      planEvidencePaths,
      hintedDeltaText,
      primaryAction,
      businessArtifactEvidencePaths,
      workspaceChangedFiles: workspaceChangeArtifacts.changedFiles,
      failureRecorded: Boolean(failureEntry)
    })
    const projectedPlanUpdate = planProgress.projectedPlanUpdate
    const planAttribution = planProgress.planAttribution
    let activePlanId = planProgress.activePlanId
    const coTouchedPlanIds = planProgress.coTouchedPlanIds
    const planExists = planProgress.planExists
    let projectedPlanItem = planProgress.projectedPlanItem
    let statusChange = planProgress.statusChange
    let doneDefinitionCheck = planProgress.doneDefinitionCheck
    const microCheckpointApplied = planProgress.microCheckpointApplied
    const microCheckpointDeliverable = planProgress.microCheckpointDeliverable
    const coTouchedDeliverablePlanIds = planProgress.coTouchedDeliverablePlanIds
    let deltaText = planProgress.deltaText

    if (!artifactGravityMode) {
      if (doneDefinitionCheck.deliverableTouched && !deltaReasons.includes('plan_deliverable_touched')) {
        deltaReasons.push('plan_deliverable_touched')
      }
      if (coTouchedDeliverablePlanIds.length > 0 && !deltaReasons.includes('co_plan_deliverable_touched')) {
        deltaReasons.push('co_plan_deliverable_touched')
      }
    }

    const openaiScriptIssue = await this.detectOpenAIPythonScriptIssue({
      workspaceWriteTouches,
      toolEvents
    })
    const statusGuardResult = await this.applyNativeTurnStatusGuards({
      turnNumber: input.turnNumber,
      orchestrationMode,
      northStarContract: northStar,
      northStarEvaluation,
      finalStatus,
      summary,
      activePlanId,
      planExists,
      planAttributionAmbiguous: planAttribution.ambiguous,
      doneDefinitionCheck,
      coTouchedDeliverablePlanIds,
      clearedBlocked,
      repoCodeTouch,
      resolvedRepoTarget,
      requireRepoTarget: this.requireRepoTarget,
      codingLargeRepoUsage,
      openaiScriptIssue,
      codingAgentSessionObservation,
      workspaceWriteTouches,
      deltaReasons,
      actionFingerprint,
      doneFingerprintHit,
      priorFingerprintCount,
      governanceOnlyTurn,
      resultPath,
      toolEvents,
      northStarSemanticGateConfig,
      northStarSemanticGateAudit,
      projectedPlanItem,
      planEvidencePaths,
      businessArtifactEvidencePaths,
      trustedEvidencePaths: input.context.trustedEvidencePaths ?? [],
      changedFiles: workspaceChangeArtifacts.changedFiles,
      patchPath: workspaceChangeArtifacts.patchPath,
      exitCode,
      bashHasAnyOutputOnSuccess: Boolean(
        bashSnapshot?.exitCode === 0
        && (((bashSnapshot.stdout?.trim().length ?? 0) > 0) || ((bashSnapshot.stderr?.trim().length ?? 0) > 0))
      ),
      statusChange,
      failureEntry,
      forcedBlockedReason: pathAnchorAudit.detected && pathAnchorAudit.mode === 'fail'
        ? 'path_anchor_violation'
        : null
    })
    finalStatus = statusGuardResult.finalStatus
    summary = statusGuardResult.summary
    let blockedReason: string | null = statusGuardResult.blockedReason
    doneDefinitionCheck = statusGuardResult.doneDefinitionCheck
    deltaReasons.length = 0
    deltaReasons.push(...statusGuardResult.deltaReasons)
    statusChange = statusGuardResult.statusChange
    failureEntry = statusGuardResult.failureEntry
    const northStarSemanticOpenRequiredActions = statusGuardResult.northStarSemanticOpenRequiredActions

    const projectMutationResult = await this.applyNativeTurnProjectMutations({
      orchestrationMode,
      northStarEvaluation,
      preflightNotes: input.preflightNotes,
      outcomeUpdateSummary: outcome.updateSummary ?? [],
      planAttribution,
      activePlanId,
      coTouchedPlanIds,
      coTouchedDeliverablePlanIds,
      doneDefinitionCheck,
      microCheckpointApplied,
      microCheckpointDeliverable,
      missingOutcomeEvidencePaths,
      northStarSemanticGateAudit,
      codingAgentSessionObservation,
      outcomeProjectUpdate: outcome.projectUpdate,
      plannerCheckpointDue,
      evidenceRefMap,
      resultPath,
      toolEvents,
      artifactsDir: input.artifactsDir,
      projectedPlanItem,
      statusChange,
      deltaText,
      planEvidencePaths,
      currentProject: input.context.project,
      finalStatus,
      summary,
      blockedReason,
      dropReason,
      replacedBy,
      currentBoard: input.context.project.planBoard,
      projectedPlanUpdate,
      workspaceWriteTouches,
      businessArtifactEvidencePaths,
      normalizedOutcomeEvidencePaths,
      runtimeControlEvidencePaths,
      literatureCachePaths: literatureCache.libraryPaths,
      actionFingerprint,
      deltaReasons,
      consumedPendingUserInputs,
      pendingUserInputs: input.pendingUserInputs,
      plannerCheckpoint: input.context.plannerCheckpoint,
      failureEntry,
      clearedBlocked,
      northStarSemanticOpenRequiredActions
    })
    finalStatus = projectMutationResult.finalStatus
    summary = projectMutationResult.summary
    blockedReason = projectMutationResult.blockedReason
    const updateSummaryLines = projectMutationResult.updateSummaryLines
    const persistedProject = projectMutationResult.persistedProject
    const planDeltaApplied = projectMutationResult.planDeltaApplied
    const planDeltaWarning = projectMutationResult.planDeltaWarning
    const coPlanStatusChanges = projectMutationResult.coPlanStatusChanges
    const coPlanWarnings = projectMutationResult.coPlanWarnings
    const clearedRedundancyBlocked = projectMutationResult.clearedRedundancyBlocked
    const doneEntries = projectMutationResult.doneEntries
    const plannerCheckpointRejections = projectMutationResult.plannerCheckpointRejections

    const boundedUpdates = updateSummaryLines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)

    const {
      resultPayload,
      stageStatus
    } = await this.buildNativeTurnResultPayload({
      finalStatus,
      intent,
      summary,
      primaryAction,
      activePlanId,
      statusChange,
      deltaText,
      uniqueEvidencePaths,
      evidenceRefMap,
      planEvidencePaths,
      actionFingerprint,
      actionType,
      exitCode,
      runtime,
      cmd,
      cwd,
      latestFailure,
      durationSec,
      turnEndedAt,
      toolEventsPath,
      toolEventsCount: toolEvents.length,
      deltaReasons,
      governanceOnlyTurn,
      plannerCheckpoint: input.context.plannerCheckpoint,
      persistedProject,
      planAttribution,
      coTouchedPlanIds,
      coTouchedDeliverablePlanIds,
      coPlanStatusChanges,
      microCheckpointApplied,
      microCheckpointDeliverable,
      deterministicFingerprint,
      clearedBlocked,
      blockedReason,
      resolvedRepoTarget,
      pathAnchorAudit,
      plannerCheckpointRejections,
      requireRepoTarget: this.requireRepoTarget,
      artifactUriPreferred: this.artifactUriPreferred,
      northStarSemanticGateAudit,
      codingAgentSessionObservation,
      orchestrationMode,
      northStarEvaluation,
      northStarSemanticOpenRequiredActions
    })

    const actionMarkdown = this.renderNativeActionMarkdown({
      turnNumber: input.turnNumber,
      intent,
      status: finalStatus,
      primaryAction,
      orchestrationMode,
      activePlanId: artifactGravityMode ? undefined : (activePlanId || undefined),
      statusChange: artifactGravityMode ? undefined : (statusChange || undefined),
      delta: deltaText || undefined,
      planEvidencePaths: artifactGravityMode ? [] : planEvidencePaths,
      keyObservation: summary,
      evidencePaths: uniqueEvidencePaths,
      updateSummary: boundedUpdates
    })

    await this.writeFinalTurnArtifacts({
      paths: turnPaths,
      resultPayload,
      actionMarkdown
    })

    return {
      turnNumber: input.turnNumber,
      turnDir: input.turnDir,
      status: finalStatus,
      intent,
      summary,
      evidencePaths: uniqueEvidencePaths,
      primaryAction,
      activePlanId: activePlanId || undefined,
      toolEventsCount: toolEvents.length,
      blockedBy: finalStatus === 'blocked' ? failureEntry ?? undefined : undefined,
      stageStatus
    }
  }

  private buildNativeTurnFilePaths(input: { turnDir: string, artifactsDir: string }): NativeTurnFilePaths {
    return buildNativeTurnFilePathsHelper(input)
  }

  private async executeNativeTurnOutcome(input: {
    context: TurnContext
    pendingUserInputs: PendingUserInput[]
  }): Promise<NativeTurnOutcomeExecution> {
    return executeNativeTurnOutcomeHelper(this, input)
  }

  private async writeProvisionalTurnArtifacts(input: {
    paths: NativeTurnFilePaths
    status: TurnStatus
    cmd: string
    stdout: string
    stderr: string
    exitCode: number
  }): Promise<void> {
    await writeProvisionalTurnArtifactsHelper(this, input)
  }

  private async writeFinalTurnArtifacts(input: {
    paths: NativeTurnFilePaths
    resultPayload: Record<string, unknown>
    actionMarkdown: string
  }): Promise<void> {
    await writeFinalTurnArtifactsHelper(input)
  }

  private async applyOutcomeProjectUpdate(input: {
    projectUpdate?: ProjectUpdate
    plannerCheckpointDue: boolean
    evidenceRefMap: Record<string, string>
    fallbackEvidencePath: string
    toolEvents: ToolEventRecord[]
    artifactsDir: string
    updateSummaryLines: string[]
  }): Promise<boolean> {
    return applyOutcomeProjectUpdateHelper(this, input)
  }

  private async applyNativeTurnPlanDeltas(
    input: NativeTurnPlanDeltaInput,
    context: { summary: string, blockedReason: string | null }
  ): Promise<NativeTurnPlanDeltaResult> {
    return applyNativeTurnPlanDeltasHelper(this, input, context)
  }

  private async applyNativeTurnProjectMutations(input: NativeTurnProjectMutationInput): Promise<NativeTurnProjectMutationResult> {
    return applyNativeTurnProjectMutationsHelper(this, input)
  }

  private async buildNativeTurnResultPayload(input: {
    finalStatus: TurnStatus
    intent: string
    summary: string
    primaryAction: string
    activePlanId: string
    statusChange: string
    deltaText: string
    uniqueEvidencePaths: string[]
    evidenceRefMap: Record<string, string>
    planEvidencePaths: string[]
    actionFingerprint: string
    actionType: string
    exitCode: number
    runtime: string
    cmd: string
    cwd: string
    latestFailure: RuntimeFailureSnapshot | null
    durationSec: number
    turnEndedAt: Date
    toolEventsPath: string
    toolEventsCount: number
    deltaReasons: string[]
    governanceOnlyTurn: boolean
    plannerCheckpoint?: PlannerCheckpointInfo
    persistedProject: TurnContext['project']
    planAttribution: PlanAttributionResult
    coTouchedPlanIds: string[]
    coTouchedDeliverablePlanIds: string[]
    coPlanStatusChanges: string[]
    microCheckpointApplied: boolean
    microCheckpointDeliverable: string
    deterministicFingerprint: string | null
    clearedBlocked: boolean
    blockedReason: string | null
    resolvedRepoTarget: ResolvedRepoTarget
    pathAnchorAudit: PathAnchorAuditResult
    plannerCheckpointRejections: string[]
    requireRepoTarget: boolean
    artifactUriPreferred: boolean
    northStarSemanticGateAudit: NorthStarSemanticGateAuditRecord
    codingAgentSessionObservation: CodingAgentSessionObservation
    orchestrationMode: ResolvedOrchestrationMode
    northStarEvaluation: NorthStarEvaluation
    northStarSemanticOpenRequiredActions: NorthStarSemanticGateRequiredAction[]
  }): Promise<NativeTurnResultPayloadBuildResult> {
    return buildNativeTurnResultPayloadHelper(this, input)
  }

  private prepareNativeTurnPlanProgress(input: NativeTurnPlanProgressInput): NativeTurnPlanProgressResult {
    return prepareNativeTurnPlanProgressHelper(this, input)
  }

  private async applyNativeTurnStatusGuards(input: NativeTurnStatusGuardInput): Promise<NativeTurnStatusGuardResult> {
    return applyNativeTurnStatusGuardsHelper(this, input)
  }

  private async loadRecentTurnStatuses(limit: number): Promise<string[]> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers.slice(-Math.max(0, limit))
    const statuses: string[] = []

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const status = normalizeText(parsed.status)
        if (status) statuses.push(status)
      } catch {
        // Ignore malformed historical records.
      }
    }

    return statuses
  }

  private async loadRecentTurnResultMetadata(limit: number): Promise<RecentTurnResultMeta[]> {
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const selected = turnNumbers
      .slice(-Math.max(0, limit))
      .reverse() // newest first
    const rows: RecentTurnResultMeta[] = []

    for (const turnNumber of selected) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        rows.push({
          turnNumber,
          status: normalizeText(parsed.status),
          blockedReason: normalizeText(parsed.blocked_reason),
          plannerCheckpointReasons: Array.isArray(parsed.planner_checkpoint_reasons)
            ? parsed.planner_checkpoint_reasons
              .filter((value): value is string => typeof value === 'string')
              .map((value) => normalizeText(value))
              .filter(Boolean)
            : [],
          planBoardHash: safeString(parsed.plan_board_hash).trim(),
          governanceOnlyTurn: parsed.governance_only_turn === true
        })
      } catch {
        // Ignore malformed historical records.
      }
    }

    return rows
  }

  private shouldRaiseReasonWithCooldown(input: {
    reason: string
    recentResults: RecentTurnResultMeta[]
    nextTurnNumber: number
    currentPlanBoardHash: string
  }): boolean {
    const latestCheckpoint = input.recentResults.find((row) => row.plannerCheckpointReasons.includes(input.reason))
    if (!latestCheckpoint) return true

    const turnsSince = input.nextTurnNumber - latestCheckpoint.turnNumber
    const withinCooldown = turnsSince <= CHECKPOINT_REASON_COOLDOWN_TURNS
    const planChanged = latestCheckpoint.planBoardHash
      && input.currentPlanBoardHash
      && latestCheckpoint.planBoardHash !== input.currentPlanBoardHash
    return !withinCooldown || planChanged
  }

  private shouldRaiseRedundancyCheckpoint(input: {
    recentResults: RecentTurnResultMeta[]
    nextTurnNumber: number
    currentPlanBoardHash: string
  }): boolean {
    const latestRedundantBlocked = input.recentResults.find((row) => row.blockedReason === 'redundant_no_delta')
    if (!latestRedundantBlocked) return false

    const latestCheckpoint = input.recentResults.find((row) => row.plannerCheckpointReasons.includes('redundancy_blocked'))
    if (!latestCheckpoint || latestCheckpoint.turnNumber < latestRedundantBlocked.turnNumber) {
      return true
    }

    const turnsSince = input.nextTurnNumber - latestCheckpoint.turnNumber
    const withinCooldown = turnsSince <= CHECKPOINT_REASON_COOLDOWN_TURNS
    const planChanged = latestCheckpoint.planBoardHash
      && input.currentPlanBoardHash
      && latestCheckpoint.planBoardHash !== input.currentPlanBoardHash

    // Once plan structure changed after a redundancy checkpoint, clear this reason.
    if (planChanged) return false
    return !withinCooldown
  }

  private detectTop3AllBlocked(project: TurnContext['project']): boolean {
    const open = project.planBoard
      .filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
    return open.length > 0 && open.every((item) => item.status === 'BLOCKED')
  }

  private isGovernanceOnlyPath(rawPath: string): boolean {
    const normalized = toPosixPath(rawPath.trim().toLowerCase())
    if (!normalized) return false
    if (normalized === 'project.md') return true
    return GOVERNANCE_CHECKPOINT_ARTIFACT_RE.test(normalized)
  }

  private isGovernanceOnlyTurn(input: {
    actionType: string
    businessArtifactEvidencePaths: string[]
    workspaceWriteTouches: string[]
  }): boolean {
    if (input.actionType !== 'write' && input.actionType !== 'edit') return false
    const touched = dedupeStrings([
      ...input.businessArtifactEvidencePaths,
      ...input.workspaceWriteTouches
    ])
    if (touched.length === 0) return false
    return touched.every((entry) => this.isGovernanceOnlyPath(entry))
  }

  private resolveProjectedPlanItem(
    activePlanId: string,
    currentBoard: PlanBoardItem[],
    update?: ProjectUpdate
  ): PlanBoardItem | null {
    if (!activePlanId) return null

    const updatedBoard = Array.isArray(update?.planBoard) ? update.planBoard : []
    for (const item of updatedBoard) {
      if (normalizePlanId(item.id) === activePlanId) {
        return {
          ...item,
          doneDefinition: [...(item.doneDefinition ?? [])],
          evidencePaths: [...(item.evidencePaths ?? [])]
        }
      }
    }

    return currentBoard.find((item) => item.id === activePlanId) ?? null
  }

  private derivePlanAttribution(input: {
    currentBoard: PlanBoardItem[]
    projectedUpdate?: ProjectUpdate
    explicitEvidencePaths: string[]
    workspaceWriteTouches: string[]
    hintedActivePlanId: string
    clearedBlocked: boolean
  }): PlanAttributionResult {
    const projectedBoard = Array.isArray(input.projectedUpdate?.planBoard)
      ? input.projectedUpdate.planBoard
      : input.currentBoard
    const candidates = projectedBoard
      .filter((item) => item.status !== 'DONE' && item.status !== 'DROPPED')
      .sort((a, b) => a.priority - b.priority)

    const scored = candidates
      .map((item) => {
        const parsed = this.parseDoneDefinitionRules(item.doneDefinition ?? [])
        if (parsed.invalidRows.length > 0 || parsed.deliverables.length === 0) {
          return { item, score: 0, touched: [] as string[] }
        }
        const touched = this.collectTouchedDeliverables(
          input.explicitEvidencePaths,
          parsed.deliverables,
          input.workspaceWriteTouches
        )
        return { item, score: touched.length, touched }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.item.priority - b.item.priority
      })

    if (scored.length > 0) {
      const touchedPlanIds = dedupeStrings(scored.map((entry) => entry.item.id))
      const bestScore = scored[0]!.score
      const best = scored.filter((entry) => entry.score === bestScore)
      if (best.length === 1) {
        const row = best[0]!
        return {
          activePlanId: row.item.id,
          ambiguous: false,
          reason: 'deliverable_attribution',
          deliverablesTouched: row.touched,
          coTouchedPlanIds: touchedPlanIds.filter((id) => id !== row.item.id)
        }
      }
      const touched = dedupeStrings(best.flatMap((entry) => entry.touched))

      if (input.hintedActivePlanId) {
        const hinted = best.find((entry) => entry.item.id === input.hintedActivePlanId)
        if (hinted) {
          return {
            activePlanId: hinted.item.id,
            ambiguous: false,
            reason: 'deliverable_attribution_hint_tiebreak',
            deliverablesTouched: touched,
            coTouchedPlanIds: touchedPlanIds.filter((id) => id !== hinted.item.id)
          }
        }
      }

      const activeBest = best.find((entry) => entry.item.status === 'ACTIVE')
      if (activeBest) {
        return {
          activePlanId: activeBest.item.id,
          ambiguous: false,
          reason: 'deliverable_attribution_active_tiebreak',
          deliverablesTouched: touched,
          coTouchedPlanIds: touchedPlanIds.filter((id) => id !== activeBest.item.id)
        }
      }

      const stablePick = [...best].sort((a, b) => {
        if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority
        return a.item.id.localeCompare(b.item.id)
      })[0]
      if (stablePick) {
        return {
          activePlanId: stablePick.item.id,
          ambiguous: false,
          reason: 'deliverable_attribution_priority_tiebreak',
          deliverablesTouched: touched,
          coTouchedPlanIds: touchedPlanIds.filter((id) => id !== stablePick.item.id)
        }
      }

      return {
        activePlanId: '',
        ambiguous: true,
        reason: 'multiple_plan_deliverables_touched',
        deliverablesTouched: touched,
        coTouchedPlanIds: []
      }
    }

    const active = candidates.find((item) => item.status === 'ACTIVE')
    if (active) {
      return { activePlanId: active.id, ambiguous: false, reason: 'fallback_active', deliverablesTouched: [], coTouchedPlanIds: [] }
    }

    if (input.hintedActivePlanId) {
      const hinted = candidates.find((item) => item.id === input.hintedActivePlanId)
      if (hinted) {
        return { activePlanId: hinted.id, ambiguous: false, reason: 'fallback_hint', deliverablesTouched: [], coTouchedPlanIds: [] }
      }
    }

    const topTodo = candidates.find((item) => item.status === 'TODO')
    if (topTodo) {
      return { activePlanId: topTodo.id, ambiguous: false, reason: 'fallback_top_todo', deliverablesTouched: [], coTouchedPlanIds: [] }
    }

    if (input.clearedBlocked) {
      const blocked = candidates.find((item) => item.status === 'BLOCKED')
      if (blocked) {
        return { activePlanId: blocked.id, ambiguous: false, reason: 'fallback_blocker_clear', deliverablesTouched: [], coTouchedPlanIds: [] }
      }
    }

    return { activePlanId: '', ambiguous: false, reason: 'no_plan_candidate', deliverablesTouched: [], coTouchedPlanIds: [] }
  }

  private deriveRuntimeStatusChange(input: {
    activePlanId: string
    finalStatus: TurnStatus
    planItem: PlanBoardItem | null
    doneReady: boolean
  }): string {
    if (!input.activePlanId) return ''
    const fromStatus = input.planItem?.status ?? 'TODO'
    if (input.finalStatus === 'blocked') return `${input.activePlanId} ${fromStatus} -> BLOCKED`
    if (input.finalStatus !== 'success') return `${input.activePlanId} ${fromStatus} -> ${fromStatus}`
    if (input.doneReady) return `${input.activePlanId} ${fromStatus} -> DONE`
    if (fromStatus === 'TODO' || fromStatus === 'BLOCKED') return `${input.activePlanId} ${fromStatus} -> ACTIVE`
    if (fromStatus === 'DONE') return `${input.activePlanId} DONE -> DONE`
    return `${input.activePlanId} ACTIVE -> ACTIVE`
  }

  private deriveRuntimeDelta(input: {
    actionLabel: string
    businessArtifacts: string[]
    workspaceWriteTouches: string[]
    deliverablesTouched: string[]
    clearedBlocked: boolean
    failureRecorded: boolean
  }): string {
    if (input.deliverablesTouched.length > 0) {
      return `Touched deliverable(s): ${input.deliverablesTouched.slice(0, 3).join(', ')}`
    }
    if (input.businessArtifacts.length > 0) {
      return `Updated artifacts: ${input.businessArtifacts.slice(0, 3).join(', ')}`
    }
    if (input.workspaceWriteTouches.length > 0) {
      return `Updated workspace files: ${input.workspaceWriteTouches.slice(0, 3).join(', ')}`
    }
    if (input.clearedBlocked) return 'Cleared previously blocked execution path.'
    if (input.failureRecorded) return 'Recorded deterministic failure evidence.'
    return input.actionLabel.trim() ? `Executed: ${input.actionLabel.trim()}` : 'Executed runtime turn.'
  }

  private parseDoneDefinitionRules(lines: string[]): ParsedDoneDefinitionRules {
    const deliverables: string[] = []
    const invalidRows: string[] = []
    let evidenceMin = 1

    for (const row of lines) {
      const line = row.trim()
      if (!line) continue
      const normalizedLine = line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim()
      if (!normalizedLine) continue

      if (/^deliverables?\s*:/i.test(normalizedLine)) {
        const rawValue = normalizedLine.split(':').slice(1).join(':').trim()
        const normalized = this.normalizeDeliverableTarget(rawValue).value
        if (!normalized) {
          invalidRows.push(normalizedLine)
          continue
        }
        deliverables.push(normalized)
        continue
      }

      if (/^evidence_min\s*:/i.test(normalizedLine)) {
        const rawValue = normalizedLine.split(':').slice(1).join(':').trim()
        const parsed = Number.parseInt(rawValue, 10)
        if (!Number.isFinite(parsed) || parsed < 1) {
          invalidRows.push(normalizedLine)
          continue
        }
        evidenceMin = parsed
        continue
      }
    }

    return {
      deliverables: dedupeStrings(deliverables),
      evidenceMin,
      invalidRows
    }
  }

  private collectTouchedDeliverables(
    evidencePaths: string[],
    deliverables: string[],
    workspaceWriteTouches: string[] = []
  ): string[] {
    const expandForMatching = (value: string): string[] => {
      const normalized = toPosixPath(value.trim().toLowerCase())
      if (!normalized) return []
      const expanded = [normalized]
      const scoped = TURN_SCOPED_DELIVERABLE_RE.exec(normalized)
      if (scoped?.[2]) expanded.push(scoped[2])
      return expanded
    }

    const normalizedEvidence = dedupeStrings(evidencePaths.flatMap(expandForMatching))
    const normalizedWrites = dedupeStrings(workspaceWriteTouches.flatMap(expandForMatching))
    const touched: string[] = []
    for (const deliverable of deliverables) {
      if (
        normalizedEvidence.some((entry) => entry.includes(deliverable))
        || normalizedWrites.some((entry) => entry.includes(deliverable))
      ) {
        touched.push(deliverable)
      }
    }
    return dedupeStrings(touched)
  }

  private validatePlanProgressAgainstDoneDefinition(input: {
    status: TurnStatus
    activePlanId: string
    statusChange: string
    explicitEvidencePaths: string[]
    cumulativeEvidencePaths: string[]
    planItem: PlanBoardItem | null
    workspaceWriteTouches: string[]
  }): { ok: boolean; reason: string; deliverableTouched: boolean; doneReady: boolean } {
    if (input.status !== 'success') return { ok: true, reason: '', deliverableTouched: false, doneReady: false }
    if (!input.activePlanId) return { ok: false, reason: 'missing_active_plan_id', deliverableTouched: false, doneReady: false }
    if (input.explicitEvidencePaths.length === 0) {
      return { ok: false, reason: 'missing_explicit_plan_evidence', deliverableTouched: false, doneReady: false }
    }

    const doneDefinition = (input.planItem?.doneDefinition ?? [])
      .map((line) => line.trim())
      .filter(Boolean)
    if (doneDefinition.length === 0) {
      return { ok: false, reason: 'missing_plan_done_definition', deliverableTouched: false, doneReady: false }
    }

    const parsedRules = this.parseDoneDefinitionRules(doneDefinition)
    if (parsedRules.invalidRows.length > 0) {
      return { ok: false, reason: 'done_definition_non_mechanical', deliverableTouched: false, doneReady: false }
    }
    if (parsedRules.deliverables.length === 0) {
      return { ok: false, reason: 'done_definition_missing_deliverable', deliverableTouched: false, doneReady: false }
    }

    const touchedThisTurn = this.collectTouchedDeliverables(
      input.explicitEvidencePaths,
      parsedRules.deliverables,
      input.workspaceWriteTouches
    )
    const deliverableTouched = touchedThisTurn.length > 0
    const coveredAll = this.collectTouchedDeliverables(
      input.cumulativeEvidencePaths,
      parsedRules.deliverables,
      input.workspaceWriteTouches
    )
    const uncovered = parsedRules.deliverables.filter((target) => !coveredAll.includes(target))
    const doneReady = uncovered.length === 0 && input.cumulativeEvidencePaths.length >= parsedRules.evidenceMin

    const doneTransition = /->\s*DONE/i.test(input.statusChange)
    if (!doneTransition) return { ok: true, reason: '', deliverableTouched, doneReady }

    if (uncovered.length > 0) {
      return { ok: false, reason: `done_definition_unmet:${uncovered.slice(0, 3).join(',')}`, deliverableTouched, doneReady }
    }

    if (input.cumulativeEvidencePaths.length < parsedRules.evidenceMin) {
      return { ok: false, reason: `done_definition_evidence_min_unmet:${parsedRules.evidenceMin}`, deliverableTouched, doneReady }
    }

    return { ok: true, reason: '', deliverableTouched, doneReady }
  }

  private resolveNorthStarSemanticGateConfig(input: {
    orchestrationMode: ResolvedOrchestrationMode
    northStar?: NorthStarContract
  }): ResolvedNorthStarSemanticGateConfig {
    const policy = input.northStar?.semanticReviewPolicy
    const override = this.config.northStarSemanticGate ?? {}

    const modeCandidate = safeString(override.mode || policy?.mode || DEFAULT_NORTHSTAR_SEMANTIC_GATE_MODE).trim().toLowerCase()
    const mode: NorthStarSemanticGateMode = (
      modeCandidate === 'off'
      || modeCandidate === 'shadow'
      || modeCandidate === 'enforce_downgrade_only'
      || modeCandidate === 'enforce_balanced'
    )
      ? modeCandidate
      : DEFAULT_NORTHSTAR_SEMANTIC_GATE_MODE

    const confidenceThreshold = (
      typeof override.confidenceThreshold === 'number'
      && Number.isFinite(override.confidenceThreshold)
      && override.confidenceThreshold >= 0
      && override.confidenceThreshold <= 1
    )
      ? override.confidenceThreshold
      : (
        typeof policy?.confidenceThreshold === 'number'
        && Number.isFinite(policy.confidenceThreshold)
        && policy.confidenceThreshold >= 0
        && policy.confidenceThreshold <= 1
          ? policy.confidenceThreshold
          : DEFAULT_NORTHSTAR_SEMANTIC_GATE_CONFIDENCE
      )

    const maxInputChars = (
      typeof override.maxInputChars === 'number'
      && Number.isFinite(override.maxInputChars)
      && override.maxInputChars >= 1_000
    )
      ? Math.floor(override.maxInputChars)
      : DEFAULT_NORTHSTAR_SEMANTIC_GATE_MAX_INPUT_CHARS

    const requiredActionBudgetPerTurn = (
      typeof override.requiredActionBudgetPerTurn === 'number'
      && Number.isFinite(override.requiredActionBudgetPerTurn)
    )
      ? Math.max(0, Math.min(3, Math.floor(override.requiredActionBudgetPerTurn)))
      : Math.max(
        0,
        Math.min(
          3,
          Math.floor(policy?.requiredActionBudgetPerTurn ?? DEFAULT_NORTHSTAR_SEMANTIC_REQUIRED_ACTION_BUDGET)
        )
      )

    const mustActionMaxOpen = (
      typeof override.mustActionMaxOpen === 'number'
      && Number.isFinite(override.mustActionMaxOpen)
    )
      ? Math.max(0, Math.min(3, Math.floor(override.mustActionMaxOpen)))
      : Math.max(
        0,
        Math.min(
          3,
          Math.floor(policy?.mustActionMaxOpen ?? DEFAULT_NORTHSTAR_SEMANTIC_MUST_MAX_OPEN)
        )
      )

    const recentWindowTurns = (
      typeof override.recentWindowTurns === 'number'
      && Number.isFinite(override.recentWindowTurns)
      && override.recentWindowTurns >= 1
    )
      ? Math.max(1, Math.min(12, Math.floor(override.recentWindowTurns)))
      : Math.max(
        1,
        Math.min(
          12,
          Math.floor(policy?.recentWindowTurns ?? DEFAULT_NORTHSTAR_SEMANTIC_RECENT_WINDOW)
        )
      )

    const model = safeString(override.model || '').trim() || 'northstar-semantic-gate-local'
    const enabled = input.orchestrationMode === 'artifact_gravity_v3_paper' && mode !== 'off'

    return {
      enabled,
      mode: enabled ? mode : 'off',
      confidenceThreshold,
      model,
      maxInputChars,
      allowUpgrade: Boolean(override.allowUpgrade ?? policy?.allowUpgrade ?? false),
      requiredActionBudgetPerTurn,
      mustActionMaxOpen,
      recentWindowTurns
    }
  }

  private async parsePatchEvidenceMetadata(patchPath: string | null): Promise<{
    patchPath: string | null
    patchHunksCount: number
    placeholderPatchDetected: boolean
  }> {
    if (!patchPath) {
      return {
        patchPath: null,
        patchHunksCount: 0,
        placeholderPatchDetected: false
      }
    }

    const raw = await readTextOrEmpty(patchPath)
    const patchHunksCount = (raw.match(/^@@ /gm) ?? []).length
    const placeholderPatchDetected = /# no git patch hunks were available for touched files\./i.test(raw)

    return {
      patchPath: this.toEvidencePath(patchPath),
      patchHunksCount,
      placeholderPatchDetected
    }
  }

  private resolveClaimMetricSourcePath(scoreboardAfter: Record<string, number>, preferred: string[]): string {
    const grouped = new Map<string, string[]>()
    for (const key of Object.keys(scoreboardAfter)) {
      const idx = key.indexOf(':')
      if (idx <= 0) continue
      const metricPath = key.slice(0, idx)
      const leaf = this.scoreMetricLeaf(key)
      const current = grouped.get(metricPath) ?? []
      current.push(leaf)
      grouped.set(metricPath, current)
    }
    const preferredSet = new Set(dedupeStrings(preferred))
    const candidates = [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))

    const relevanceScore = (leafs: string[]): number => {
      const set = new Set(leafs)
      let score = 0
      if (set.has('claims_total')) score += 3
      if (set.has('claims_verified') || set.has('claims_verified_with_valid_evidence')) score += 3
      if (set.has('claims_verified_raw') || set.has('claims_marked_verified')) score += 2
      if (set.has('claims_verified_invalid_evidence') || set.has('claims_marked_verified_with_invalid_evidence')) score += 2
      if (set.has('evidence_valid_coverage')) score += 1
      return score
    }

    const ranked = candidates
      .map(([metricPath, leafs]) => ({
        metricPath,
        score: relevanceScore(leafs),
        preferred: preferredSet.has(metricPath)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
        return a.metricPath.localeCompare(b.metricPath)
      })

    return ranked[0]?.metricPath || preferred[0] || ''
  }

  private normalizeNorthStarClaimQuality(input: {
    scoreboardBefore: Record<string, number>
    scoreboardAfter: Record<string, number>
    scoreboardMetricPaths: string[]
  }): NormalizedNorthStarClaimQuality {
    const sourceMetricPath = this.resolveClaimMetricSourcePath(input.scoreboardAfter, input.scoreboardMetricPaths)
    const leafAfter = new Map<string, number>()

    if (sourceMetricPath) {
      for (const [metricKey, metricValue] of Object.entries(input.scoreboardAfter)) {
        if (!Number.isFinite(metricValue)) continue
        if (!metricKey.startsWith(`${sourceMetricPath}:`)) continue
        leafAfter.set(this.scoreMetricLeaf(metricKey), metricValue)
      }
    }

    const readLeaf = (...keys: string[]): number => {
      for (const key of keys) {
        if (leafAfter.has(key)) {
          const value = leafAfter.get(key)
          if (typeof value === 'number' && Number.isFinite(value)) return value
        }
      }
      return 0
    }

    const claimsTotalRaw = readLeaf('claims_total')
    const claimsMarkedVerifiedRaw = readLeaf('claims_marked_verified', 'claims_verified_raw')
    const claimsVerifiedValidRaw = readLeaf('claims_verified_with_valid_evidence', 'claims_verified')
    const claimsMarkedInvalidRaw = readLeaf('claims_marked_verified_with_invalid_evidence', 'claims_verified_invalid_evidence')

    const claims_total = Math.max(0, Math.floor(claimsTotalRaw))
    let claims_marked_verified = Math.max(0, Math.floor(claimsMarkedVerifiedRaw))
    let claims_verified_with_valid_evidence = Math.max(0, Math.floor(claimsVerifiedValidRaw))
    let claims_marked_verified_with_invalid_evidence = Math.max(0, Math.floor(claimsMarkedInvalidRaw))

    if (claims_marked_verified < claims_verified_with_valid_evidence) {
      claims_marked_verified = claims_verified_with_valid_evidence
    }
    if (claims_marked_verified_with_invalid_evidence === 0 && claims_marked_verified >= claims_verified_with_valid_evidence) {
      claims_marked_verified_with_invalid_evidence = claims_marked_verified - claims_verified_with_valid_evidence
    }
    if (claims_marked_verified > claims_total) {
      claims_marked_verified = claims_total
    }
    if (claims_verified_with_valid_evidence > claims_marked_verified) {
      claims_verified_with_valid_evidence = claims_marked_verified
    }
    if (claims_marked_verified_with_invalid_evidence > claims_marked_verified) {
      claims_marked_verified_with_invalid_evidence = claims_marked_verified
    }

    const computedCoverage = claims_total > 0
      ? claims_verified_with_valid_evidence / claims_total
      : 0
    const coverageRaw = readLeaf('evidence_valid_coverage')
    const evidence_valid_coverage = Number.isFinite(coverageRaw) && coverageRaw > 0
      ? Math.max(0, Math.min(1, coverageRaw))
      : Math.max(0, Math.min(1, computedCoverage))

    const epsilon = 1e-4
    const invariant_violation = (
      claims_total < claims_marked_verified
      || claims_marked_verified < claims_verified_with_valid_evidence
      || claims_marked_verified !== (claims_verified_with_valid_evidence + claims_marked_verified_with_invalid_evidence)
      || Math.abs(evidence_valid_coverage - computedCoverage) > Math.max(epsilon, 0.02)
    )

    return {
      claims_total,
      claims_marked_verified,
      claims_verified_with_valid_evidence,
      claims_marked_verified_with_invalid_evidence,
      evidence_valid_coverage: Number(evidence_valid_coverage.toFixed(5)),
      source_metric_path: sourceMetricPath || '',
      invariant_violation
    }
  }

  private toNorthStarSemanticFileDelta(proof: NorthStarContentDeltaProof): NorthStarSemanticGateInput['delta']['change_proof']['file_deltas'][number] {
    const contentChanged = proof.beforeHash !== proof.afterHash
    const addedLines = Math.max(0, proof.structuredDiff.lineCountDelta)
    const removedLines = Math.max(0, -proof.structuredDiff.lineCountDelta)
    const rules: string[] = []
    if (addedLines > 0) rules.push('added_lines>0')
    if (proof.structuredDiff.csvRowDelta !== 0) rules.push('csv_row_delta!=0')
    if (proof.structuredDiff.csvColumnDelta !== 0) rules.push('csv_column_delta!=0')
    if (Object.keys(proof.structuredDiff.claimsStatusDelta || {}).length > 0) rules.push('claims_status_delta!=0')
    if (proof.structuredDiff.nonEmptyLineDelta !== 0) rules.push('non_empty_line_delta!=0')
    const nontrivialChangeDetected = contentChanged && rules.length > 0
    return {
      path: proof.path,
      before_hash: proof.beforeHash,
      after_hash: proof.afterHash,
      content_changed: contentChanged,
      nontrivial_change_detected: nontrivialChangeDetected,
      nontrivial_change_rules: rules,
      added_lines: addedLines,
      removed_lines: removedLines
    }
  }

  private collectNorthStarSemanticReasonCodes(input: {
    turnNumber: number
    claimQuality: NormalizedNorthStarClaimQuality
    fileDeltas: NorthStarSemanticGateInput['delta']['change_proof']['file_deltas']
    recentObjectives: NorthStarRecentObjective[]
    currentObjectiveId: string
    currentObjectiveVersion: number
  }): NorthStarSemanticReasonCode[] {
    const reasonCodes: NorthStarSemanticReasonCode[] = []
    if (input.claimQuality.invariant_violation) {
      reasonCodes.push(NORTHSTAR_SEMANTIC_REASON_INCONSISTENT_METRICS)
    }

    for (const delta of input.fileDeltas) {
      if (!delta.content_changed && delta.nontrivial_change_detected) {
        reasonCodes.push(NORTHSTAR_SEMANTIC_REASON_INVALID_CHANGE_PROOF_FLAGS)
        break
      }
    }

    const latestObjective = input.recentObjectives[0]
    const objectiveChanged = Boolean(
      latestObjective
      && (latestObjective.objective_id !== input.currentObjectiveId
        || latestObjective.objective_version !== input.currentObjectiveVersion)
    )
    if (input.turnNumber > 1 && !latestObjective) {
      reasonCodes.push(NORTHSTAR_SEMANTIC_REASON_OBJECTIVE_CONTEXT_MISSING)
    }

    return dedupeStrings(reasonCodes)
  }

  private async loadRecentNorthStarSemanticTurns(input: {
    maxTurns: number
    beforeTurn: number
  }): Promise<NorthStarSemanticGateInput['recent_turns']> {
    const numbers = (await listTurnNumbers(this.runsDir))
      .filter((turnNumber) => turnNumber < input.beforeTurn)
      .slice(-Math.max(0, input.maxTurns))
      .reverse()
    const rows: NorthStarSemanticGateInput['recent_turns'] = []

    for (const turnNumber of numbers) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northstarSemantic = toPlainObject(parsed.northstar_semantic_gate)
        const effectiveVerdictRaw = safeString(northstarSemantic?.effective_verdict).trim().toLowerCase()
        const semantic_verdict: NorthStarSemanticGateInput['recent_turns'][number]['semantic_verdict'] = (
          effectiveVerdictRaw === 'advance_confirmed'
          || effectiveVerdictRaw === 'advance_weak'
          || effectiveVerdictRaw === 'no_progress'
          || effectiveVerdictRaw === 'regress'
          || effectiveVerdictRaw === 'abstain'
        )
          ? effectiveVerdictRaw
          : 'none'
        rows.push({
          turn: turnNumber,
          status: safeString(parsed.status).trim() || 'unknown',
          semantic_verdict,
          summary: safeString(parsed.summary).trim().slice(0, 400)
        })
      } catch {
        continue
      }
    }

    return rows
  }

  private async loadRecentNorthStarObjectives(input: {
    maxTurns: number
    beforeTurn: number
  }): Promise<NorthStarRecentObjective[]> {
    const numbers = (await listTurnNumbers(this.runsDir))
      .filter((turnNumber) => turnNumber < input.beforeTurn)
      .slice(-Math.max(0, input.maxTurns))
      .reverse()
    const rows: NorthStarRecentObjective[] = []

    for (const turnNumber of numbers) {
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const northstar = toPlainObject(parsed.northstar)
        const objectiveId = safeString(northstar?.objective_id).trim()
        const objectiveVersionRaw = typeof northstar?.objective_version === 'number'
          ? northstar.objective_version
          : 0
        const objectiveVersion = Number.isFinite(objectiveVersionRaw)
          ? Math.max(1, Math.floor(objectiveVersionRaw))
          : 1
        if (!objectiveId) continue
        rows.push({
          turn: turnNumber,
          objective_id: objectiveId,
          objective_version: objectiveVersion,
          change_reason: 'objective_stable'
        })
      } catch {
        continue
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const current = rows[index]
      const previous = rows[index + 1]
      if (!current || !previous) continue
      if (current.objective_id !== previous.objective_id || current.objective_version !== previous.objective_version) {
        current.change_reason = 'scope_narrowing'
      }
    }

    return rows
  }

  private buildNorthStarSemanticContentSnapshots(input: {
    baselineSnapshots: NorthStarPathSnapshot[]
    afterSnapshots: NorthStarPathSnapshot[]
    scoreboardMetricPaths: string[]
  }): NorthStarSemanticGateInput['content_snapshots'] {
    const beforeByPath = new Map(input.baselineSnapshots.map((row) => [row.path, row]))
    const afterByPath = new Map(input.afterSnapshots.map((row) => [row.path, row]))
    const keyPaths = dedupeStrings([
      ...input.afterSnapshots.map((row) => row.path),
      ...input.scoreboardMetricPaths
    ])
    const snapshots: NorthStarSemanticGateInput['content_snapshots'] = []
    for (const keyPath of keyPaths) {
      const before = beforeByPath.get(keyPath) ?? this.buildEmptyNorthStarPathSnapshot(keyPath)
      const after = afterByPath.get(keyPath) ?? this.buildEmptyNorthStarPathSnapshot(keyPath)
      snapshots.push({
        path: keyPath,
        kind: after.contentKind,
        source: 'runtime_snapshot',
        before_hash: before.hash,
        after_hash: after.hash,
        ...(before.textExcerpt ? { before_excerpt: before.textExcerpt.slice(0, 700) } : {}),
        ...(after.textExcerpt ? { after_excerpt: after.textExcerpt.slice(0, 700) } : {}),
        structured_summary: {
          rows_before: before.csvRowCount,
          rows_after: after.csvRowCount,
          verified_before: before.claimsStatusCounts.verified ?? 0,
          verified_after: after.claimsStatusCounts.verified ?? 0,
          verified_invalid_after: after.claimsStatusCounts.verified_invalid_evidence ?? 0
        }
      })
    }
    return snapshots
  }

  private async buildNorthStarSemanticGateInput(input: {
    turnNumber: number
    mode: NorthStarSemanticGateMode
    finalStatus: TurnStatus
    blockedReason: string | null
    northStar: NorthStarContract
    northStarEvaluation: NorthStarEvaluation
    changedFiles: string[]
    patchPath: string | null
    businessArtifactEvidencePaths: string[]
    trustedEvidencePaths: string[]
    maxInputChars: number
    resultPath: string
    hardViolations: string[]
  }): Promise<{
    payload: NorthStarSemanticGateInput
    inputHash: string
    claimQuality: NormalizedNorthStarClaimQuality
    reasonCodes: string[]
  }> {
    const patchMeta = await this.parsePatchEvidenceMetadata(input.patchPath)
    const fileDeltas = input.northStarEvaluation.contentDeltaProofs.map((proof) => this.toNorthStarSemanticFileDelta(proof))
    const claimQuality = this.normalizeNorthStarClaimQuality({
      scoreboardBefore: input.northStarEvaluation.scoreboardPreviousValues,
      scoreboardAfter: input.northStarEvaluation.scoreboardValues,
      scoreboardMetricPaths: input.northStarEvaluation.scoreboardMetricPaths
    })
    const recentTurns = await this.loadRecentNorthStarSemanticTurns({
      maxTurns: input.northStar.semanticReviewPolicy.recentWindowTurns,
      beforeTurn: input.turnNumber
    })
    const recentObjectives = await this.loadRecentNorthStarObjectives({
      maxTurns: input.northStar.semanticReviewPolicy.recentWindowTurns + 2,
      beforeTurn: input.turnNumber
    })
    const reasonCodes = this.collectNorthStarSemanticReasonCodes({
      turnNumber: input.turnNumber,
      claimQuality,
      fileDeltas,
      recentObjectives,
      currentObjectiveId: input.northStar.objectiveId,
      currentObjectiveVersion: input.northStar.objectiveVersion
    })
    const objectiveChanged = recentObjectives[0]
      && (
        recentObjectives[0].objective_id !== input.northStar.objectiveId
        || recentObjectives[0].objective_version !== input.northStar.objectiveVersion
      )
    const pivotApproved = !input.northStarEvaluation.policyViolations.some((code) => (
      normalizeText(code).includes('pivot_locked')
      || normalizeText(code).includes('missing_pivot')
    ))

    const contentSnapshots = this.buildNorthStarSemanticContentSnapshots({
      baselineSnapshots: input.northStarEvaluation.baselineSnapshots,
      afterSnapshots: input.northStarEvaluation.afterSnapshots,
      scoreboardMetricPaths: input.northStarEvaluation.scoreboardMetricPaths
    })
    if (contentSnapshots.length === 0) {
      reasonCodes.push(NORTHSTAR_SEMANTIC_REASON_MISSING_CONTENT_SNAPSHOT)
    }

    const payload: NorthStarSemanticGateInput = {
      schema: 'yolo.northstar_semantic_gate.input.v1',
      turn: {
        id: formatTurnId(input.turnNumber),
        number: input.turnNumber
      },
      mode: input.mode,
      deterministic: {
        status: input.finalStatus,
        blocked_reason: input.blockedReason,
        hard_violations: dedupeStrings(input.hardViolations),
        northstar_gate_satisfied: Boolean(input.northStarEvaluation.gateSatisfied)
      },
      northstar: {
        goal: input.northStar.goal || '',
        current_objective: input.northStar.currentObjective || '',
        objective_id: input.northStar.objectiveId,
        objective_version: input.northStar.objectiveVersion,
        artifacts: dedupeStrings(input.northStar.artifactPaths),
        scoreboard_paths: dedupeStrings(input.northStar.scoreboardMetricPaths)
      },
      delta: {
        artifact_changes: dedupeStrings(input.northStarEvaluation.changedArtifacts),
        scoreboard_before: input.northStarEvaluation.scoreboardPreviousValues,
        scoreboard_after: input.northStarEvaluation.scoreboardValues,
        change_proof: {
          patch_path: patchMeta.patchPath,
          patch_hunks_count: patchMeta.patchHunksCount,
          placeholder_patch_detected: patchMeta.placeholderPatchDetected,
          touched_files: dedupeStrings(input.changedFiles),
          file_deltas: fileDeltas
        }
      },
      content_snapshots: contentSnapshots,
      claim_quality: {
        claims_total: claimQuality.claims_total,
        claims_marked_verified: claimQuality.claims_marked_verified,
        claims_verified_with_valid_evidence: claimQuality.claims_verified_with_valid_evidence,
        claims_marked_verified_with_invalid_evidence: claimQuality.claims_marked_verified_with_invalid_evidence,
        evidence_valid_coverage: claimQuality.evidence_valid_coverage,
        source_metric_path: claimQuality.source_metric_path
      },
      checks: {
        internal_executed: input.northStarEvaluation.internalCheckExecutedCommands,
        internal_succeeded: input.northStarEvaluation.internalCheckSucceededCommands,
        external_executed: input.northStarEvaluation.externalCheckExecutedCommands,
        external_succeeded: input.northStarEvaluation.externalCheckSucceededCommands
      },
      recent_turns: recentTurns,
      recent_objectives: recentObjectives,
      pivot_context: {
        is_explicit_pivot_turn: Boolean(objectiveChanged),
        pivot_reason: objectiveChanged ? 'scope_narrowing' : 'objective_stable',
        pivot_evidence_paths: [this.toEvidencePath(input.resultPath)],
        pivot_approved_by_policy: pivotApproved
      },
      evidence_refs: {
        trusted_paths: dedupeStrings(input.trustedEvidencePaths).slice(0, 100),
        business_artifacts: dedupeStrings(input.businessArtifactEvidencePaths).slice(0, 100)
      }
    }

    const canonical = canonicalizeJson(payload)
    const canonicalJson = clipText(JSON.stringify(canonical), input.maxInputChars)
    const inputHash = createHash('sha256').update(canonicalJson).digest('hex')
    return {
      payload,
      inputHash,
      claimQuality,
      reasonCodes: dedupeStrings(reasonCodes)
    }
  }

  private normalizeNorthStarSemanticGateOutput(raw: unknown): NorthStarSemanticGateOutput {
    const row = toPlainObject(raw) ?? {}
    const confidenceRaw = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? row.confidence
      : 0
    const confidence = Math.max(0, Math.min(1, confidenceRaw))

    const readDimensionScore = (key: string): 0 | 1 | 2 | null => {
      const dimRow = toPlainObject(row.dimension_scores)
      if (!dimRow) return null
      const value = dimRow[key]
      if (value === 0 || value === 1 || value === 2) return value
      return null
    }

    const scores = {
      goal_alignment: readDimensionScore('goal_alignment'),
      evidence_strength: readDimensionScore('evidence_strength'),
      novelty_delta: readDimensionScore('novelty_delta'),
      falsifiability: readDimensionScore('falsifiability'),
      trajectory_health: readDimensionScore('trajectory_health')
    }
    const hasAllScores = Object.values(scores).every((value) => value !== null)
    const dimension_scores = hasAllScores
      ? {
        goal_alignment: scores.goal_alignment as 0 | 1 | 2,
        evidence_strength: scores.evidence_strength as 0 | 1 | 2,
        novelty_delta: scores.novelty_delta as 0 | 1 | 2,
        falsifiability: scores.falsifiability as 0 | 1 | 2,
        trajectory_health: scores.trajectory_health as 0 | 1 | 2
      }
      : undefined

    const reason_codes = Array.isArray(row.reason_codes)
      ? dedupeStrings(row.reason_codes.map((value) => safeString(value).trim()).filter(Boolean))
      : []

    const required_actions = Array.isArray(row.required_actions)
      ? row.required_actions
        .map((item) => {
          const actionRow = toPlainObject(item)
          const tierRaw = safeString(actionRow?.tier).trim().toLowerCase()
          const tier = (tierRaw === 'must_candidate' || tierRaw === 'should' || tierRaw === 'suggest')
            ? tierRaw
            : 'suggest'
          const code = safeString(actionRow?.code).trim()
          const description = safeString(actionRow?.description).trim()
          const dueTurnRaw = typeof actionRow?.due_turn === 'number' && Number.isFinite(actionRow.due_turn)
            ? Math.max(1, Math.floor(actionRow.due_turn))
            : undefined
          if (!code || !description) return null
          return {
            tier,
            code,
            description,
            ...(typeof dueTurnRaw === 'number' ? { due_turn: dueTurnRaw } : {})
          } as NorthStarSemanticGateRequiredAction
        })
        .filter((entry): entry is NorthStarSemanticGateRequiredAction => entry !== null)
      : []

    const claimAuditRow = toPlainObject(row.claim_audit)
    const claim_audit = claimAuditRow
      ? {
        supported_ids: Array.isArray(claimAuditRow.supported_ids)
          ? dedupeStrings(claimAuditRow.supported_ids.map((value) => safeString(value).trim()).filter(Boolean))
          : [],
        unsupported_ids: Array.isArray(claimAuditRow.unsupported_ids)
          ? dedupeStrings(claimAuditRow.unsupported_ids.map((value) => safeString(value).trim()).filter(Boolean))
          : [],
        contradicted_ids: Array.isArray(claimAuditRow.contradicted_ids)
          ? dedupeStrings(claimAuditRow.contradicted_ids.map((value) => safeString(value).trim()).filter(Boolean))
          : []
      }
      : undefined

    const verdictRaw = safeString(row.verdict).trim().toLowerCase()
    const verdict = (
      verdictRaw === 'advance_confirmed'
      || verdictRaw === 'advance_weak'
      || verdictRaw === 'no_progress'
      || verdictRaw === 'regress'
      || verdictRaw === 'abstain'
    )
      ? verdictRaw
      : undefined

    return {
      schema: 'yolo.northstar_semantic_gate.output.v1',
      confidence,
      ...(dimension_scores ? { dimension_scores } : {}),
      ...(reason_codes.length > 0 ? { reason_codes } : {}),
      ...(claim_audit ? { claim_audit } : {}),
      ...(required_actions.length > 0 ? { required_actions } : {}),
      ...(safeString(row.summary).trim() ? { summary: safeString(row.summary).trim().slice(0, 1_000) } : {}),
      ...(verdict ? { verdict } : {})
    }
  }

  private deriveNorthStarSemanticVerdict(input: {
    dimension_scores?: NorthStarSemanticGateOutput['dimension_scores']
  }): {
    verdict: NorthStarSemanticVerdict
    valid: boolean
    normalizedScores: Record<string, number>
  } {
    const row = toPlainObject(input.dimension_scores) ?? {}
    const read = (key: string): number | null => {
      const value = row[key]
      if (value === 0 || value === 1 || value === 2) return value
      return null
    }
    const ga = read('goal_alignment')
    const es = read('evidence_strength')
    const nd = read('novelty_delta')
    const fa = read('falsifiability')
    const th = read('trajectory_health')
    const normalizedScores: Record<string, number> = {
      goal_alignment: ga ?? -1,
      evidence_strength: es ?? -1,
      novelty_delta: nd ?? -1,
      falsifiability: fa ?? -1,
      trajectory_health: th ?? -1
    }
    if ([ga, es, nd, fa, th].some((value) => value === null)) {
      return {
        verdict: 'abstain',
        valid: false,
        normalizedScores
      }
    }

    const values = [ga!, es!, nd!, fa!, th!]
    const sum = values.reduce((acc, value) => acc + value, 0)
    const zeroCount = values.filter((value) => value === 0).length
    const twoCount = values.filter((value) => value === 2).length

    let verdict: NorthStarSemanticVerdict
    if (zeroCount >= 3) verdict = 'regress'
    else if (ga === 0 && (nd === 0 || th === 0)) verdict = 'regress'
    else if (nd === 0 || ga === 0) verdict = 'no_progress'
    else if (sum >= 8 && es! >= 1 && twoCount >= 2) verdict = 'advance_confirmed'
    else if (sum >= 5 && ga! >= 1 && nd! >= 1) verdict = 'advance_weak'
    else verdict = 'no_progress'

    return {
      verdict,
      valid: true,
      normalizedScores
    }
  }

  private collectNorthStarDeterministicTriggerCodes(input: {
    claimQuality: NormalizedNorthStarClaimQuality
    reasonCodes: string[]
    northStarEvaluation: NorthStarEvaluation
  }): string[] {
    const triggers: string[] = []
    if (input.claimQuality.claims_marked_verified_with_invalid_evidence > 0) {
      triggers.push('claims_marked_verified_with_invalid_evidence')
    }
    if (input.claimQuality.invariant_violation) {
      triggers.push('inconsistent_metrics')
    }
    if (input.northStarEvaluation.verifiedGrowthContentProofRequired && !input.northStarEvaluation.verifiedGrowthContentProofSatisfied) {
      triggers.push('verified_growth_missing_content_delta_proof')
    }
    if (!input.northStarEvaluation.scoreboardMetricPathsValid) {
      triggers.push('invalid_scoreboard_path')
    }
    if (input.reasonCodes.includes(NORTHSTAR_SEMANTIC_REASON_INVALID_CHANGE_PROOF_FLAGS)) {
      triggers.push('invalid_change_proof_flags')
    }
    return dedupeStrings(triggers)
  }

  private normalizeNorthStarRequiredActionCode(value: string): string {
    return normalizeText(value)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  private isNorthStarRequiredActionResolved(input: {
    action: NorthStarSemanticGateRequiredAction
    claimQuality: NormalizedNorthStarClaimQuality
  }): boolean {
    const code = this.normalizeNorthStarRequiredActionCode(input.action.code)
    if (!code) return false
    const hasAnyVerifiedClaim = (
      input.claimQuality.claims_verified_with_valid_evidence > 0
      || input.claimQuality.claims_marked_verified > 0
    )
    if (!hasAnyVerifiedClaim) return false
    return (
      code === 'verify_at_least_one_claim'
      || code === 'add_verified_evidence'
    )
  }

  private postProcessNorthStarRequiredActions(input: {
    turnNumber: number
    actions: NorthStarSemanticGateRequiredAction[]
    existingOpenActions: NorthStarSemanticGateRequiredAction[]
    deterministicTriggerCodes: string[]
    claimQuality: NormalizedNorthStarClaimQuality
    config: ResolvedNorthStarSemanticGateConfig
    effectiveVerdict: NorthStarSemanticVerdict
  }): {
    mergedOpenActions: NorthStarSemanticGateRequiredAction[]
    promotions: NorthStarSemanticActionPromotionAudit[]
    blockingAction: NorthStarSemanticGateRequiredAction | null
  } {
    const promotions: NorthStarSemanticActionPromotionAudit[] = []
    const budgeted = input.actions.slice(0, Math.max(0, input.config.requiredActionBudgetPerTurn))
    const processed: NorthStarSemanticGateRequiredAction[] = budgeted.map((row) => {
      const sourceTier = row.tier === 'must' ? 'must_candidate' : row.tier
      const base: NorthStarSemanticGateRequiredAction = {
        ...row,
        source_tier: sourceTier,
        due_turn: typeof row.due_turn === 'number' ? row.due_turn : (input.turnNumber + 1)
      }
      if (sourceTier !== 'must_candidate') {
        promotions.push({
          code: base.code,
          source_tier: sourceTier,
          final_tier: sourceTier === 'suggest' ? 'suggest' : 'should',
          deterministic_trigger_codes: [],
          notes: ['non_candidate_passthrough']
        })
        return {
          ...base,
          tier: sourceTier === 'suggest' ? 'suggest' : 'should'
        }
      }
      if (input.deterministicTriggerCodes.length > 0) {
        promotions.push({
          code: base.code,
          source_tier: 'must_candidate',
          final_tier: 'must',
          deterministic_trigger_codes: [...input.deterministicTriggerCodes],
          notes: ['promoted_by_runtime_trigger']
        })
        return {
          ...base,
          tier: 'must',
          promotion_trigger_codes: [...input.deterministicTriggerCodes]
        }
      }
      promotions.push({
        code: base.code,
        source_tier: 'must_candidate',
        final_tier: 'should',
        deterministic_trigger_codes: [],
        notes: ['demoted_without_runtime_trigger']
      })
      return {
        ...base,
        tier: 'should'
      }
    })

    const mergedByCode = new Map<string, NorthStarSemanticGateRequiredAction>()
    const pushAction = (action: NorthStarSemanticGateRequiredAction): void => {
      const code = action.code.trim()
      if (!code) return
      const normalizedCode = this.normalizeNorthStarRequiredActionCode(code)
      const key = normalizedCode || code
      mergedByCode.set(key, {
        ...action,
        code
      })
    }
    for (const existing of input.existingOpenActions) pushAction(existing)
    for (const next of processed) pushAction(next)

    const staleNonMustDueTurn = input.turnNumber - NORTHSTAR_NON_MUST_ACTION_OVERDUE_GRACE_TURNS
    const unresolvedOpenActions = [...mergedByCode.values()]
      .filter((action) => !this.isNorthStarRequiredActionResolved({
        action,
        claimQuality: input.claimQuality
      }))
      .filter((action) => {
        if (action.tier === 'must') return true
        if (typeof action.due_turn !== 'number') return true
        return action.due_turn >= staleNonMustDueTurn
      })

    let mergedOpenActions = unresolvedOpenActions
      .sort((a, b) => {
        const tierRank = (tier: NorthStarSemanticGateRequiredAction['tier']): number => {
          if (tier === 'must') return 0
          if (tier === 'must_candidate') return 1
          if (tier === 'should') return 2
          return 3
        }
        if (tierRank(a.tier) !== tierRank(b.tier)) return tierRank(a.tier) - tierRank(b.tier)
        const dueA = typeof a.due_turn === 'number' ? a.due_turn : Number.MAX_SAFE_INTEGER
        const dueB = typeof b.due_turn === 'number' ? b.due_turn : Number.MAX_SAFE_INTEGER
        if (dueA !== dueB) return dueA - dueB
        return a.code.localeCompare(b.code)
      })
      .map((action) => ({ ...action }))

    const mustActions = mergedOpenActions.filter((action) => action.tier === 'must')
    if (mustActions.length > input.config.mustActionMaxOpen) {
      const overflow = mustActions.slice(input.config.mustActionMaxOpen)
      for (const row of overflow) {
        const rowKey = this.normalizeNorthStarRequiredActionCode(row.code)
        const match = mergedOpenActions.find((item) => this.normalizeNorthStarRequiredActionCode(item.code) === rowKey)
        if (!match) continue
        match.tier = 'should'
        match.promotion_notes = dedupeStrings([...(match.promotion_notes ?? []), 'demoted_by_must_open_cap'])
      }
    }

    const nonMustActions = mergedOpenActions.filter((action) => action.tier !== 'must')
    if (nonMustActions.length > NORTHSTAR_NON_MUST_ACTION_MAX_OPEN) {
      const keepNonMustCodes = new Set(
        nonMustActions
          .slice(0, NORTHSTAR_NON_MUST_ACTION_MAX_OPEN)
          .map((action) => this.normalizeNorthStarRequiredActionCode(action.code))
      )
      mergedOpenActions = mergedOpenActions.filter((action) => (
        action.tier === 'must'
        || keepNonMustCodes.has(this.normalizeNorthStarRequiredActionCode(action.code))
      ))
    }

    const blockingAction = mergedOpenActions.find((action) => (
      action.tier === 'must'
      && typeof action.due_turn === 'number'
      && action.due_turn < input.turnNumber
    )) ?? null

    return {
      mergedOpenActions,
      promotions,
      blockingAction
    }
  }

  private async loadPreviousNorthStarSemanticOpenActions(beforeTurn: number): Promise<NorthStarSemanticGateRequiredAction[]> {
    if (beforeTurn <= 1) return []
    const resultPath = path.join(this.runsDir, formatTurnId(beforeTurn - 1), 'result.json')
    if (!(await fileExists(resultPath))) return []
    const raw = await readTextOrEmpty(resultPath)
    if (!raw.trim()) return []

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const semanticRow = toPlainObject(parsed.northstar_semantic_gate)
      const open = Array.isArray(semanticRow?.open_required_actions)
        ? semanticRow.open_required_actions
        : []
      return open
        .map((item) => {
          const row = toPlainObject(item)
          const tierRaw = safeString(row?.tier).trim().toLowerCase()
          const tier = (tierRaw === 'must' || tierRaw === 'should' || tierRaw === 'suggest')
            ? tierRaw
            : 'suggest'
          const code = safeString(row?.code).trim()
          const description = safeString(row?.description).trim()
          if (!code || !description) return null
          const dueTurn = typeof row?.due_turn === 'number' && Number.isFinite(row.due_turn)
            ? Math.max(1, Math.floor(row.due_turn))
            : undefined
          return {
            tier,
            code,
            description,
            ...(typeof dueTurn === 'number' ? { due_turn: dueTurn } : {})
          } as NorthStarSemanticGateRequiredAction
        })
        .filter((entry): entry is NorthStarSemanticGateRequiredAction => entry !== null)
    } catch {
      return []
    }
  }

  private async loadNorthStarSemanticFeedbackForContext(beforeTurn: number): Promise<TurnContext['northStarSemantic']> {
    if (beforeTurn <= 0) return undefined
    const resultPath = path.join(this.runsDir, formatTurnId(beforeTurn), 'result.json')
    if (!(await fileExists(resultPath))) return undefined
    const raw = await readTextOrEmpty(resultPath)
    if (!raw.trim()) return undefined
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const semanticRow = toPlainObject(parsed.northstar_semantic_gate)
      if (!semanticRow) return undefined
      const lastVerdictRaw = safeString(semanticRow.effective_verdict).trim().toLowerCase()
      const lastVerdict: TurnContext['northStarSemantic']['lastVerdict'] = (
        lastVerdictRaw === 'advance_confirmed'
        || lastVerdictRaw === 'advance_weak'
        || lastVerdictRaw === 'no_progress'
        || lastVerdictRaw === 'regress'
        || lastVerdictRaw === 'abstain'
      )
        ? lastVerdictRaw
        : 'none'
      const derivedVerdictRaw = safeString(semanticRow.derived_verdict).trim().toLowerCase()
      const derivedVerdict: TurnContext['northStarSemantic']['derivedVerdict'] = (
        derivedVerdictRaw === 'advance_confirmed'
        || derivedVerdictRaw === 'advance_weak'
        || derivedVerdictRaw === 'no_progress'
        || derivedVerdictRaw === 'regress'
        || derivedVerdictRaw === 'abstain'
      )
        ? derivedVerdictRaw
        : 'none'
      const reasonCodes = Array.isArray(semanticRow.reason_codes)
        ? dedupeStrings(semanticRow.reason_codes.map((value) => safeString(value).trim()).filter(Boolean))
        : []
      const claimAuditDebt = Array.isArray(semanticRow.claim_audit_debt)
        ? dedupeStrings(semanticRow.claim_audit_debt.map((value) => safeString(value).trim()).filter(Boolean))
        : []
      const openActions = await this.loadPreviousNorthStarSemanticOpenActions(beforeTurn + 1)
      return {
        lastVerdict,
        reasonCodes,
        claimAuditDebt,
        openRequiredActions: openActions,
        derivedVerdict
      }
    } catch {
      return undefined
    }
  }

  private computePlanBoardFingerprint(project: TurnContext['project']): string {
    const rows = [...project.planBoard]
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.id.localeCompare(b.id)
      })
      .map((item) => {
        const doneRows = (item.doneDefinition ?? [])
          .map((row) => row.trim().toLowerCase())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        return {
          id: item.id,
          status: item.status,
          priority: item.priority,
          title: normalizeText(item.title),
          doneDefinition: doneRows
        }
      })

    return createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
  }

  private computeGoalConstraintsFingerprint(project: TurnContext['project']): string {
    const goal = normalizeText(project.goal)
    const constraints = project.constraints
      .map((entry) => `${normalizeText(entry.text)}|${normalizeText(entry.evidencePath)}`)
      .sort((a, b) => a.localeCompare(b))
    return createHash('sha256')
      .update(`${goal}\n${constraints.join('\n')}`)
      .digest('hex')
  }

  private async didGoalOrConstraintsChange(project: TurnContext['project'], nextTurnNumber: number): Promise<boolean> {
    if (nextTurnNumber <= 1) return false
    const previousResultPath = path.join(this.runsDir, formatTurnId(nextTurnNumber - 1), 'result.json')
    if (!(await fileExists(previousResultPath))) return false

    const raw = await readTextOrEmpty(previousResultPath)
    if (!raw.trim()) return false

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const previous = safeString(parsed.goal_constraints_fingerprint).trim()
      if (!previous) return false
      return previous !== this.computeGoalConstraintsFingerprint(project)
    } catch {
      return false
    }
  }

  private async detectPlannerCheckpoint(
    project: TurnContext['project'],
    _failures: FailureEntry[],
    nextTurnNumber: number,
    orchestrationMode: ResolvedOrchestrationMode
  ): Promise<PlannerCheckpointInfo> {
    if (isArtifactGravityMode(orchestrationMode)) {
      return {
        due: false,
        reasons: []
      }
    }

    const reasons: string[] = []
    const recentResults = await this.loadRecentTurnResultMetadata(24)
    const currentPlanBoardHash = this.computePlanBoardFingerprint(project)

    if (nextTurnNumber > 1 && (nextTurnNumber - 1) % 4 === 0) {
      reasons.push('periodic_4_turn_checkpoint')
    }

    const recentStatuses = await this.loadRecentTurnStatuses(2)
    if (
      recentStatuses.length === 2
      && recentStatuses.every((status) => status === 'no_delta')
      && this.shouldRaiseReasonWithCooldown({
        reason: 'two_consecutive_no_delta',
        recentResults,
        nextTurnNumber,
        currentPlanBoardHash
      })
    ) {
      reasons.push('two_consecutive_no_delta')
    }

    if (this.shouldRaiseRedundancyCheckpoint({
      recentResults,
      nextTurnNumber,
      currentPlanBoardHash
    })) {
      reasons.push('redundancy_blocked')
    }

    if (this.detectTop3AllBlocked(project)) {
      reasons.push('top3_all_blocked')
    }

    if (await this.didGoalOrConstraintsChange(project, nextTurnNumber)) {
      reasons.push('goal_or_constraints_changed')
    }

    return {
      due: reasons.length > 0,
      reasons
    }
  }

  private static readonly STAGNATION_WINDOW = 5
  private static readonly STAGNATION_THRESHOLD = 4

  private async findProducedDeliverables(input?: {
    maxTurnsToScan?: number
    maxTurnNumber?: number
  }): Promise<Set<string>> {
    const maxTurnsToScan = input?.maxTurnsToScan ?? 50
    const maxTurnNumber = typeof input?.maxTurnNumber === 'number'
      ? input.maxTurnNumber
      : Number.MAX_SAFE_INTEGER
    const turnNumbers = await listTurnNumbers(this.runsDir)
    const toScan = turnNumbers
      .filter((turnNumber) => turnNumber <= maxTurnNumber)
      .slice(-maxTurnsToScan)
      .reverse() // newest first
    const found = new Set<string>()

    for (const tn of toScan) {
      if (found.size >= DELIVERABLE_PATTERNS.length) break // all found
      const artifactsDir = path.join(this.runsDir, formatTurnId(tn), 'artifacts')
      if (!(await fileExists(artifactsDir))) continue
      try {
        const entryNames = await this.collectArtifactEntryNames(artifactsDir)
        const matched = this.extractDeliverablePatternsFromEntries(entryNames)
        for (const pattern of matched) found.add(pattern)
      } catch { /* skip */ }
    }
    return found
  }

  private async detectStagnation(): Promise<StagnationInfo> {
    const W = YoloSession.STAGNATION_WINDOW
    const threshold = YoloSession.STAGNATION_THRESHOLD
    const turnNumbers = await listTurnNumbers(this.runsDir)

    const counts = new Map<string, number>()
    let considered = 0
    for (let idx = turnNumbers.length - 1; idx >= 0 && considered < W; idx -= 1) {
      const turnNumber = turnNumbers[idx]
      if (typeof turnNumber !== 'number') continue
      const resultPath = path.join(this.runsDir, formatTurnId(turnNumber), 'result.json')
      if (!(await fileExists(resultPath))) continue
      const raw = await readTextOrEmpty(resultPath)
      if (!raw.trim()) continue

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.governance_only_turn === true) {
          continue
        }
        let actionType = normalizeText(parsed.action_type)
        if (!actionType) {
          const fingerprint = normalizeText(parsed.action_fingerprint)
          actionType = fingerprint.split(':')[0] || ''
        }
        const normalizedAction = actionType || 'agent'
        counts.set(normalizedAction, (counts.get(normalizedAction) ?? 0) + 1)
        considered += 1
      } catch {
        // Ignore malformed historical rows.
      }
    }

    if (considered < W) {
      return { stagnant: false, dominantAction: '', count: 0, window: W }
    }

    let dominantAction = ''
    let dominantCount = 0
    for (const [action, count] of counts) {
      if (count > dominantCount) {
        dominantAction = action
        dominantCount = count
      }
    }

    if (dominantAction && dominantCount >= threshold) {
      return {
        stagnant: true,
        dominantAction,
        count: dominantCount,
        window: W
      }
    }

    return {
      stagnant: false,
      dominantAction: '',
      count: 0,
      window: W
    }
  }

  private inferStage(producedDeliverables: Set<string>): StageStatus {
    for (const req of DELIVERABLE_CHECKLIST) {
      const completed = req.patterns.filter(p => producedDeliverables.has(p))
      const missing = req.patterns.filter(p => !producedDeliverables.has(p))
      // Stage complete if at least one pattern matches
      if (completed.length === 0) {
        return { currentStage: req.stage, label: req.label, missingDeliverables: missing, completedDeliverables: completed }
      }
    }
    return { currentStage: 'S5', label: 'Writing', missingDeliverables: [], completedDeliverables: ['paper_draft'] }
  }

  private isStageAdvanced(previous: StageStatus, next: StageStatus): boolean {
    const previousRank = stageRank(previous.currentStage)
    const nextRank = stageRank(next.currentStage)
    if (nextRank > previousRank) return true
    if (nextRank < previousRank) return false
    return next.completedDeliverables.length > previous.completedDeliverables.length
  }

  private async computeNextTurnNumber(): Promise<number> {
    const numbers = await listTurnNumbers(this.runsDir)
    for (let index = numbers.length - 1; index >= 0; index -= 1) {
      const number = numbers[index]
      if (await this.hasTurnFootprint(number)) {
        return number + 1
      }
    }
    return 1
  }

  private async hasTurnFootprint(turnNumber: number): Promise<boolean> {
    const turnDir = path.join(this.runsDir, formatTurnId(turnNumber))
    const markerFiles = [
      'action.md',
      'result.json',
      'cmd.txt',
      'stdout.txt',
      'stderr.txt',
      'exit_code.txt',
      'patch.diff'
    ]
    for (const fileName of markerFiles) {
      if (await fileExists(path.join(turnDir, fileName))) return true
    }

    return this.hasAnyFileRecursive(path.join(turnDir, 'artifacts'))
  }

  private async hasAnyFileRecursive(dirPath: string): Promise<boolean> {
    if (!(await fileExists(dirPath))) return false
    const stack = [dirPath]

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      let entries: fs.Dirent[]
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile()) return true
        if (entry.isDirectory()) stack.push(path.join(current, entry.name))
      }
    }

    return false
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

  private async ensureUserInputQueueFile(): Promise<void> {
    if (!(await fileExists(this.userInputQueuePath))) {
      await writeText(this.userInputQueuePath, '[]\n')
    }
  }

  private async loadQueuedUserInputs(): Promise<QueuedUserInput[]> {
    await this.ensureUserInputQueueFile()
    const raw = await readTextOrEmpty(this.userInputQueuePath)
    if (!raw.trim()) return []

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const id = typeof row.id === 'string' ? row.id.trim() : ''
          const text = typeof row.text === 'string' ? row.text.trim() : ''
          const submittedAt = typeof row.submittedAt === 'string' ? row.submittedAt.trim() : ''
          if (!id || !text || !submittedAt) return null
          return { id, text, submittedAt } satisfies QueuedUserInput
        })
        .filter((item): item is QueuedUserInput => item !== null)
    } catch {
      return []
    }
  }

  private async saveQueuedUserInputs(entries: QueuedUserInput[]): Promise<void> {
    const normalized = entries
      .map((entry) => ({
        id: entry.id.trim(),
        text: entry.text.trim(),
        submittedAt: entry.submittedAt.trim()
      }))
      .filter((entry) => entry.id && entry.text && entry.submittedAt)

    await writeText(this.userInputQueuePath, `${JSON.stringify(normalized, null, 2)}\n`)
  }

  private async clearQueuedUserInputs(): Promise<void> {
    await this.saveQueuedUserInputs([])
  }

  private async materializePendingUserInputs(artifactsDir: string): Promise<PendingUserInput[]> {
    const queue = await this.loadQueuedUserInputs()
    if (queue.length === 0) return []

    const items: PendingUserInput[] = []
    for (let index = 0; index < queue.length; index += 1) {
      const queued = queue[index]
      const safeId = queued.id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      const fileName = `user-input-${String(index + 1).padStart(2, '0')}-${safeId || 'entry'}.md`
      const filePath = path.join(artifactsDir, fileName)

      await writeText(filePath, [
        '# User Input',
        `- id: ${queued.id}`,
        `- submitted_at: ${queued.submittedAt}`,
        '',
        queued.text,
        ''
      ].join('\n'))

      items.push({
        ...queued,
        evidencePath: this.toEvidencePath(filePath)
      })
    }

    return items
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

  private toProjectRelativePath(absPath: string): string {
    return toPosixPath(path.relative(this.config.projectPath, absPath))
  }

  private async persistLiteratureCacheFromToolEvents(input: {
    turnNumber: number
    artifactsDir: string
    toolEvents: ToolEventRecord[]
  }): Promise<{
      evidencePath: string | null
      cachedCount: number
      libraryPaths: string[]
    }> {
    if (input.toolEvents.length === 0) {
      return { evidencePath: null, cachedCount: 0, libraryPaths: [] }
    }

    const literatureDir = path.join(input.artifactsDir, 'literature')
    await ensureDir(literatureDir)
    const scriptLibraryPathSet = new Set<string>()
    const normalizeArtifactPath = (raw: unknown): string => {
      if (typeof raw !== 'string') return ''
      const trimmed = raw.trim()
      if (!trimmed) return ''

      if (path.isAbsolute(trimmed)) {
        try {
          const normalized = this.toProjectRelativePath(this.ensureSafeTargetPath(trimmed))
          if (!EVIDENCE_PATH_RE.test(normalized)) return ''
          return normalized
        } catch {
          return ''
        }
      }

      const normalized = toPosixPath(trimmed.replace(/^\.\//, ''))
      if (!normalized) return ''
      if (!EVIDENCE_PATH_RE.test(normalized)) return ''
      return normalized
    }

    for (const event of input.toolEvents) {
      if (event.phase !== 'result') continue
      const tool = normalizeText(event.tool || '')
      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const inputObj = toPlainObject(event.input)

      const isLiteratureSkillRun = tool === 'skill-script-run' && safeString(inputObj?.skillId).trim() === 'literature-search'
      const isLiteratureWrapper = tool === 'literature-search' || tool === 'literature-study'
      if (isLiteratureSkillRun || isLiteratureWrapper) {
        const structured = toPlainObject(dataObj?.structuredResult)
        const jsonPath = normalizeArtifactPath(structured?.jsonPath ?? dataObj?.jsonPath)
        const markdownPath = normalizeArtifactPath(structured?.markdownPath ?? dataObj?.markdownPath)
        if (jsonPath) scriptLibraryPathSet.add(jsonPath)
        if (markdownPath) scriptLibraryPathSet.add(markdownPath)
        const studyPlanPath = normalizeArtifactPath(structured?.planPath ?? dataObj?.planPath)
        const studyReviewPath = normalizeArtifactPath(structured?.reviewPath ?? dataObj?.reviewPath)
        const studyPaperListPath = normalizeArtifactPath(structured?.paperListPath ?? dataObj?.paperListPath)
        const studyCoveragePath = normalizeArtifactPath(structured?.coveragePath ?? dataObj?.coveragePath)
        const studySummaryPath = normalizeArtifactPath(structured?.summaryPath ?? dataObj?.summaryPath)
        if (studyPlanPath) scriptLibraryPathSet.add(studyPlanPath)
        if (studyReviewPath) scriptLibraryPathSet.add(studyReviewPath)
        if (studyPaperListPath) scriptLibraryPathSet.add(studyPaperListPath)
        if (studyCoveragePath) scriptLibraryPathSet.add(studyCoveragePath)
        if (studySummaryPath) scriptLibraryPathSet.add(studySummaryPath)
      }
    }
    const records: Array<{
      id: string
      url: string
      title: string
      sourceHost: string
      status: number
      fetchedAt: string
      turnNumber: number
      jsonPath: string
      markdownPath: string
      excerptChars: number
    }> = []

    let lastFetchUrl = ''
    for (const event of input.toolEvents) {
      if (normalizeText(event.tool || '') !== 'fetch') continue

      if (event.phase === 'call') {
        const callInput = toPlainObject(event.input)
        const maybeUrl = safeString(callInput?.url).trim()
        if (maybeUrl) lastFetchUrl = maybeUrl
        continue
      }

      const resultInput = toPlainObject(event.input)
      const url = safeString(resultInput?.url).trim() || lastFetchUrl
      if (!url || !isLikelyLiteratureUrl(url)) continue

      const resultObj = toPlainObject(event.result)
      const dataObj = toPlainObject(resultObj?.data)
      const status = typeof dataObj?.status === 'number' ? dataObj.status : (event.success === true ? 200 : 500)
      const ok = typeof dataObj?.ok === 'boolean' ? dataObj.ok : event.success === true
      if (!ok || status >= 400) continue

      const fetchedAt = event.timestamp || toIso(this.now)
      const body = dataObj?.body
      let rawBody = ''
      if (typeof body === 'string') {
        rawBody = body
      } else if (body !== undefined) {
        try {
          rawBody = JSON.stringify(body, null, 2)
        } catch {
          rawBody = String(body)
        }
      }
      const excerpt = rawBody.slice(0, LITERATURE_BODY_LIMIT).trim()
      if (!excerpt) continue

      let sourceHost = 'unknown'
      try {
        sourceHost = new URL(url).hostname
      } catch {
        sourceHost = 'unknown'
      }

      const title = extractLiteratureTitle(body)
      const fileStem = `${slugifyForFile(sourceHost)}-${hashStable(`${url}\n${excerpt.slice(0, 4096)}`)}`
      const jsonPath = path.join(literatureDir, `${fileStem}.json`)
      const markdownPath = path.join(literatureDir, `${fileStem}.md`)

      await writeText(jsonPath, `${JSON.stringify({
        id: fileStem,
        url,
        sourceHost,
        title: title || null,
        status,
        fetchedAt,
        turnNumber: input.turnNumber,
        body
      }, null, 2)}\n`)

      const markdown = [
        `# Literature Cache: ${title || sourceHost}`,
        '',
        `- id: ${fileStem}`,
        `- source: ${sourceHost}`,
        `- url: ${url}`,
        `- status: ${status}`,
        `- fetched_at: ${fetchedAt}`,
        `- turn: ${formatTurnId(input.turnNumber)}`,
        '',
        '## Content Excerpt',
        '```',
        excerpt,
        '```',
        ''
      ].join('\n')
      await writeText(markdownPath, markdown)

      records.push({
        id: fileStem,
        url,
        title,
        sourceHost,
        status,
        fetchedAt,
        turnNumber: input.turnNumber,
        jsonPath: this.toEvidencePath(jsonPath),
        markdownPath: this.toEvidencePath(markdownPath),
        excerptChars: excerpt.length
      })
    }

    if (records.length === 0 && scriptLibraryPathSet.size === 0) {
      return { evidencePath: null, cachedCount: 0, libraryPaths: [] }
    }

    const manifestPath = path.join(input.artifactsDir, 'literature-cache.json')
    await writeText(manifestPath, `${JSON.stringify({
      turnNumber: input.turnNumber,
      cachedCount: records.length,
      records,
      scriptArtifacts: Array.from(scriptLibraryPathSet.values()).sort((a, b) => a.localeCompare(b))
    }, null, 2)}\n`)

    const scriptLibraryPaths = Array.from(scriptLibraryPathSet.values()).sort((a, b) => a.localeCompare(b))

    return {
      evidencePath: this.toEvidencePath(manifestPath),
      cachedCount: records.length + scriptLibraryPaths.length,
      libraryPaths: dedupeStrings([
        ...records.flatMap((record) => [record.jsonPath, record.markdownPath]),
        ...scriptLibraryPaths
      ])
    }
  }

  private renderNativeActionMarkdown(input: {
    turnNumber: number
    intent: string
    status: TurnStatus
    primaryAction: string
    orchestrationMode: ResolvedOrchestrationMode
    activePlanId?: string
    statusChange?: string
    delta?: string
    planEvidencePaths: string[]
    keyObservation: string
    evidencePaths: string[]
    updateSummary: string[]
  }): string {
    const updateLines = input.updateSummary.length > 0
      ? input.updateSummary.map((line) => `- ${line}`)
      : ['- Next: continue with native tool execution.']
    const progressSection = isArtifactGravityMode(input.orchestrationMode)
      ? [
        '## NorthStar Delta',
        `- delta: ${input.delta || '(none)'}`,
        '- plan_binding: disabled_in_v3'
      ]
      : [
        '## Plan Delta',
        `- active_plan_id: ${input.activePlanId || '(missing)'}`,
        `- status_change: ${input.statusChange || '(none)'}`,
        `- delta: ${input.delta || '(none)'}`,
        `- plan_evidence: ${input.planEvidencePaths.length > 0 ? input.planEvidencePaths.join(', ') : '(none)'}`
      ]

    return [
      `# Turn ${formatTurnId(input.turnNumber)}`,
      '',
      '## Intent',
      `- Why this turn: ${input.intent.trim()}`,
      '- Expected outcome: Produce fresh evidence and update control files with pointers only.',
      '',
      '## Action',
      '- Tool: Agent',
      `- Command or target: ${input.primaryAction || 'agent.run'}`,
      '',
      ...progressSection,
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
}

export function createYoloSession(config: CreateYoloSessionConfig): YoloSession {
  return new YoloSession(config)
}
