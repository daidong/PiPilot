import { useState } from 'react'
import { ArrowUp, ArrowDown, X } from 'lucide-react'
import { friendlyStage, formatEvent } from '@/lib/formatters'
import type {
  YoloSnapshot,
  TurnReport,
  QueuedUserInput,
  ExternalWaitTask,
  WaitTaskValidationResult,
  BudgetUsageInfo,
  BudgetTrendInfo,
  GovernanceSummary,
} from '@/lib/types'

interface SystemTabProps {
  snapshot: YoloSnapshot | null
  turnReports: TurnReport[]
  rawEvents: any[]
  queuedInputs: QueuedUserInput[]
  waitTasks: ExternalWaitTask[]
  waitValidation: WaitTaskValidationResult | null
  pendingWaitTask: ExternalWaitTask | null
  budgetCaps: { maxTurns: number; maxTokens: number; maxCostUsd: number }
  budgetUsage: BudgetUsageInfo
  budgetAlert: { label: string; tone: string }
  budgetTrend: BudgetTrendInfo
  governanceSummary: GovernanceSummary
  maintenanceAlerts: any[]
  queueOpen: boolean
  selectedPhase: 'P0' | 'P1' | 'P2' | 'P3'
  onQueueOpenChange: (open: boolean | ((prev: boolean) => boolean)) => void
  actions: {
    setQueuePriority: (id: string, priority: 'urgent' | 'normal') => Promise<void>
    moveQueueItem: (id: string, toIndex: number) => Promise<void>
    removeQueueItem: (id: string) => Promise<void>
    requestWaitExternal: (params: { title: string; completionRule: string; resumeAction: string; details: string }) => Promise<void>
    requestFullTextWait: (params: { citation: string; requiredFiles: string; reason: string }) => Promise<void>
    resolveWaitTask: (resolutionNote: string) => Promise<void>
    validateWaitTask: () => Promise<void>
    cancelWaitTask: (reason: string) => Promise<void>
    addIngressFiles: (taskId?: string) => Promise<void>
    requestResourceExtension: (params: { rationale: string; deltaTurns: string; deltaTokens: string; deltaCostUsd: string }) => Promise<void>
    resolveResourceExtension: (approved: boolean, note: string) => Promise<void>
  }
}

function AccordionSection({ title, defaultOpen = false, tone, children }: {
  title: string
  defaultOpen?: boolean
  tone?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`rounded-xl border ${tone ?? 't-border'} overflow-hidden`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium t-hoverable"
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="t-text-muted">{open ? '\u2212' : '+'}</span>
      </button>
      {open && <div className="border-t t-border px-3 py-3">{children}</div>}
    </div>
  )
}

// Key governance metrics shown by default
const KEY_GOVERNANCE: { key: keyof GovernanceSummary; label: string }[] = [
  { key: 'overrideDecisionCount', label: 'Override decisions' },
  { key: 'semanticConsensusBlockerCount', label: 'Consensus blockers' },
  { key: 'invalidatedNodeCount', label: 'Invalidated nodes' },
  { key: 'maintenanceErrorCount', label: 'Critical / error alerts' },
  { key: 'readinessGateFailureAlertCount', label: 'Readiness failures' },
  { key: 'semanticReviewerCount', label: 'Quality reviewers' },
]

// Extended governance metrics hidden behind "Show all"
const EXTENDED_GOVERNANCE: { key: keyof GovernanceSummary; label: string }[] = [
  { key: 'claimFreezeDecisionCount', label: 'Claim-freeze decisions' },
  { key: 'maintenanceAlertCount', label: 'Maintenance alerts' },
  { key: 'readinessRequiredFailedCount', label: 'Readiness required-fail' },
  { key: 'crossBranchDefaultedCount', label: 'Cross-branch defaulted' },
  { key: 'crossBranchAutoUpgradedCount', label: 'Cross-branch auto-upgraded' },
  { key: 'invalidCountableLinkCount', label: 'Invalid countable links' },
  { key: 'missingParityContractLinkCount', label: 'Missing parity links' },
  { key: 'causalityMissingClaimCount', label: 'Causality missing claims' },
  { key: 'missingClaimDecisionBindingCount', label: 'Claim-freeze binding gaps' },
  { key: 'directEvidenceMissingClaimCount', label: 'Direct-evidence gaps' },
]

export function SystemTab({
  snapshot,
  turnReports,
  rawEvents,
  queuedInputs,
  waitTasks,
  waitValidation,
  pendingWaitTask,
  budgetCaps,
  budgetUsage,
  budgetAlert,
  budgetTrend,
  governanceSummary,
  maintenanceAlerts,
  queueOpen,
  selectedPhase,
  onQueueOpenChange,
  actions,
}: SystemTabProps) {
  // Local form state for external wait — cleared defaults
  const [waitTitle, setWaitTitle] = useState('')
  const [waitRule, setWaitRule] = useState('')
  const [waitResumeAction, setWaitResumeAction] = useState('')
  const [waitDetails, setWaitDetails] = useState('')
  const [waitResolutionNote, setWaitResolutionNote] = useState('')
  const [waitCancelReason, setWaitCancelReason] = useState('')
  const [fullTextCitation, setFullTextCitation] = useState('')
  const [fullTextRequiredFiles, setFullTextRequiredFiles] = useState('')
  const [fullTextReason, setFullTextReason] = useState('')

  // Local form state for resource extension — cleared defaults
  const [resourceDeltaTurns, setResourceDeltaTurns] = useState('')
  const [resourceDeltaTokens, setResourceDeltaTokens] = useState('')
  const [resourceDeltaCostUsd, setResourceDeltaCostUsd] = useState('')
  const [resourceRationale, setResourceRationale] = useState('')
  const [resourceDecisionNote, setResourceDecisionNote] = useState('')

  // Show all governance toggle
  const [showAllGovernance, setShowAllGovernance] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      {/* Budget Details — expanded by default */}
      <AccordionSection title="Budget Details" defaultOpen>
        <div className="space-y-3 text-xs">
          <div className={`rounded-xl border px-3 py-2 ${budgetAlert.tone}`}>
            <div className="font-medium">Budget {budgetAlert.label}</div>
            <div className="mt-1">
              cost {Math.round(budgetUsage.costRatio * 100)}% · cycles {Math.round(budgetUsage.turnRatio * 100)}%
            </div>
          </div>

          <div className="rounded-xl border t-border p-3">
            <div className="font-medium t-text-secondary">Burn Rate (last {budgetTrend.sampleSize || 0} cycles)</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">avg tokens / cycle</div>
                <div className="mt-1 text-sm font-semibold">{Math.round(budgetTrend.avgTokensPerTurn).toLocaleString()}</div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">avg cost / cycle</div>
                <div className="mt-1 text-sm font-semibold">${budgetTrend.avgCostPerTurn.toFixed(3)}</div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">token runway</div>
                <div className="mt-1 text-sm font-semibold">
                  {budgetTrend.projectedTurnsLeftByTokens === null ? '-' : `${Math.max(0, Math.floor(budgetTrend.projectedTurnsLeftByTokens))} cycles`}
                </div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">cost runway</div>
                <div className="mt-1 text-sm font-semibold">
                  {budgetTrend.projectedTurnsLeftByCost === null ? '-' : `${Math.max(0, Math.floor(budgetTrend.projectedTurnsLeftByCost))} cycles`}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg t-bg-elevated p-2">
              <div className="t-text-muted">Tokens</div>
              <div className="mt-1 font-semibold">{(snapshot?.budgetUsed?.tokens ?? 0).toLocaleString()} / {budgetCaps.maxTokens.toLocaleString()}</div>
            </div>
            <div className="rounded-lg t-bg-elevated p-2">
              <div className="t-text-muted">Cost</div>
              <div className="mt-1 font-semibold">${(snapshot?.budgetUsed?.costUsd ?? 0).toFixed(3)} / ${budgetCaps.maxCostUsd.toFixed(3)}</div>
            </div>
            <div className="rounded-lg t-bg-elevated p-2">
              <div className="t-text-muted">Cycles</div>
              <div className="mt-1 font-semibold">{snapshot?.budgetUsed?.turns ?? 0} / {budgetCaps.maxTurns}</div>
            </div>
          </div>
        </div>
      </AccordionSection>

      {/* Governance Overview — collapsed, 6 key metrics + "Show all" toggle */}
      <AccordionSection
        title="Governance Overview"
        tone={governanceSummary.maintenanceErrorCount > 0 || governanceSummary.invalidatedNodeCount > 0
          ? 't-card-amber'
          : undefined}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {KEY_GOVERNANCE.map(({ key, label }) => (
            <div key={key} className="contents">
              <div className="t-text-secondary">{label}</div>
              <div className="font-medium">{governanceSummary[key]}</div>
            </div>
          ))}
          {showAllGovernance && EXTENDED_GOVERNANCE.map(({ key, label }) => (
            <div key={key} className="contents">
              <div className="t-text-secondary">{label}</div>
              <div className="font-medium">{governanceSummary[key]}</div>
            </div>
          ))}
        </div>
        <button
          onClick={() => setShowAllGovernance((v) => !v)}
          className="mt-2 text-[11px] t-accent-teal hover:underline"
        >
          {showAllGovernance ? 'Show less' : `Show all (${KEY_GOVERNANCE.length + EXTENDED_GOVERNANCE.length} metrics)`}
        </button>
      </AccordionSection>

      {/* Input Queue */}
      <AccordionSection title={`Input Queue (${queuedInputs.length})`}>
        <div className="text-xs">
          <div className="mb-2 text-[11px] t-text-muted">
            Queued messages are merged at the next cycle boundary.
          </div>
          {queuedInputs.length === 0 ? (
            <div className="rounded-lg t-bg-elevated p-2 t-text-muted">No queued input.</div>
          ) : (
            <div className="space-y-2">
              {queuedInputs.map((item, index) => (
                <div key={item.id} className="rounded-lg border t-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div>{item.text}</div>
                      <div className="mt-1 text-[11px] t-text-muted">
                        {new Date(item.createdAt).toLocaleTimeString()} · {item.source}
                        {` · est. cycle ${(snapshot?.currentTurn ?? 0) + 1}`}
                      </div>
                    </div>
                    <button
                      onClick={() => actions.removeQueueItem(item.id)}
                      className="rounded-md border border-rose-500/40 p-1 t-accent-rose hover:bg-rose-500/10"
                      aria-label="Remove queued input"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <button
                      onClick={() => actions.setQueuePriority(item.id, item.priority === 'urgent' ? 'normal' : 'urgent')}
                      className={`rounded-md border px-2 py-1 text-[11px] ${item.priority === 'urgent' ? 'border-amber-500/50 t-accent-amber' : 't-border t-text-secondary'}`}
                    >
                      {item.priority}
                    </button>
                    <button
                      onClick={() => actions.moveQueueItem(item.id, index - 1)}
                      disabled={index === 0}
                      className="rounded-md border t-border p-1 disabled:opacity-40"
                      aria-label="Move up in queue"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={() => actions.moveQueueItem(item.id, index + 1)}
                      disabled={index === queuedInputs.length - 1}
                      className="rounded-md border t-border p-1 disabled:opacity-40"
                      aria-label="Move down in queue"
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </AccordionSection>

      {/* External Wait (P1+) */}
      {selectedPhase !== 'P0' && (
        <AccordionSection title="External Wait" tone="t-card-sky">
          <div className="text-xs">
            {snapshot?.state === 'WAITING_EXTERNAL' ? (
              <div className="space-y-2">
                <div className="rounded-lg border border-sky-500/30 p-2">
                  <div className="font-medium">{pendingWaitTask?.title ?? 'Pending external task'}</div>
                  <div className="mt-1 t-text-secondary">{pendingWaitTask?.completionRule}</div>
                  {pendingWaitTask?.requiredArtifacts && pendingWaitTask.requiredArtifacts.length > 0 && (
                    <div className="mt-1 text-[11px] t-text-muted">
                      required: {pendingWaitTask.requiredArtifacts.map((item) => item.pathHint || item.description).join(', ')}
                    </div>
                  )}
                  {pendingWaitTask?.uploadDir && (
                    <div className="mt-1 text-[11px] t-text-muted">uploadDir: {pendingWaitTask.uploadDir}</div>
                  )}
                </div>
                <button
                  onClick={() => actions.addIngressFiles(pendingWaitTask?.id)}
                  className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                >
                  Add Files To Upload Dir
                </button>
                <button
                  onClick={actions.validateWaitTask}
                  className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                >
                  Validate Uploads
                </button>
                {waitValidation && waitValidation.taskId === pendingWaitTask?.id && (
                  <div className={`rounded-lg border px-2 py-1 text-[11px] ${waitValidation.ok ? 't-card-emerald t-accent-emerald' : 't-card-rose t-accent-rose'}`}>
                    {waitValidation.ok
                      ? `Validation passed${waitValidation.requiredUploads.length > 0 ? ` · required files present (${waitValidation.requiredUploads.join(', ')})` : ''}`
                      : `Validation failed · ${waitValidation.reason ?? 'missing required uploads'}`}
                    {waitValidation.checks.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {waitValidation.checks.map((check) => (
                          <div key={check.name}>
                            {check.passed ? 'Passed' : 'Failed'} · {check.name}
                            {check.detail ? ` · ${check.detail}` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Resolution note</label>
                  <input
                    value={waitResolutionNote}
                    onChange={(e) => setWaitResolutionNote(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Resolution note..."
                  />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Cancel reason</label>
                  <input
                    value={waitCancelReason}
                    onChange={(e) => setWaitCancelReason(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Cancel reason..."
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => actions.resolveWaitTask(waitResolutionNote)}
                    className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                  >
                    Mark External Task Complete
                  </button>
                  <button
                    onClick={() => actions.cancelWaitTask(waitCancelReason)}
                    className="rounded-md border border-amber-500/40 px-3 py-2 font-medium t-accent-amber hover:bg-amber-500/10"
                  >
                    Cancel External Task
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Task title</label>
                  <input value={waitTitle} onChange={(e) => setWaitTitle(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Task title..." />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Completion rule</label>
                  <input value={waitRule} onChange={(e) => setWaitRule(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Completion rule..." />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Resume action</label>
                  <input value={waitResumeAction} onChange={(e) => setWaitResumeAction(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Resume action..." />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Details (optional)</label>
                  <input value={waitDetails} onChange={(e) => setWaitDetails(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Optional details..." />
                </div>
                <button
                  onClick={() => actions.requestWaitExternal({ title: waitTitle, completionRule: waitRule, resumeAction: waitResumeAction, details: waitDetails })}
                  className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                >
                  Pause for External Data
                </button>
                <button
                  onClick={() => actions.addIngressFiles()}
                  className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                >
                  Stage Files For Next Turn
                </button>

                <div className="mt-2 border-t border-sky-500/20 pt-2 text-[11px] t-accent-sky">
                  Missing Full-text Shortcut
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Citation</label>
                  <input value={fullTextCitation} onChange={(e) => setFullTextCitation(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Citation..." />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Required files</label>
                  <input value={fullTextRequiredFiles} onChange={(e) => setFullTextRequiredFiles(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Required files (comma-separated)..." />
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Reason full text is missing</label>
                  <input value={fullTextReason} onChange={(e) => setFullTextReason(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30" placeholder="Reason full text is missing..." />
                </div>
                <button
                  onClick={() => actions.requestFullTextWait({ citation: fullTextCitation, requiredFiles: fullTextRequiredFiles, reason: fullTextReason })}
                  className="rounded-md border border-sky-400/40 px-3 py-2 font-medium t-accent-sky hover:bg-sky-500/10"
                >
                  Request Full-text (Wait for Upload)
                </button>
              </div>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Resource Extension (P1+) */}
      {selectedPhase !== 'P0' && (
        <AccordionSection title="Resource Extension" tone="t-card-amber">
          <div className="text-xs">
            {snapshot?.pendingResourceExtension ? (
              <div className="space-y-2">
                <div className="rounded-lg border border-amber-500/30 p-2">
                  <div className="font-medium">Request {snapshot.pendingResourceExtension.id}</div>
                  <div className="mt-1 t-text-secondary">
                    +turns {snapshot.pendingResourceExtension.delta.maxTurns}
                    {' · '}
                    +tokens {snapshot.pendingResourceExtension.delta.maxTokens}
                    {' · '}
                    +cost ${snapshot.pendingResourceExtension.delta.maxCostUsd.toFixed(3)}
                  </div>
                  <div className="mt-1 text-[11px] t-text-muted">{snapshot.pendingResourceExtension.rationale}</div>
                </div>
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Decision note</label>
                  <input
                    value={resourceDecisionNote}
                    onChange={(e) => setResourceDecisionNote(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Decision note..."
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => actions.resolveResourceExtension(true, resourceDecisionNote)}
                    className="rounded-md border border-emerald-500/40 px-3 py-2 font-medium t-accent-emerald hover:bg-emerald-500/10"
                  >
                    Approve Extension
                  </button>
                  <button
                    onClick={() => actions.resolveResourceExtension(false, resourceDecisionNote)}
                    className="rounded-md border border-rose-500/40 px-3 py-2 font-medium t-accent-rose hover:bg-rose-500/10"
                  >
                    Reject Extension
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] t-text-muted mb-1">Rationale</label>
                  <textarea
                    value={resourceRationale}
                    onChange={(e) => setResourceRationale(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Why extension is needed..."
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[11px] t-text-muted mb-1">+turns</label>
                    <input value={resourceDeltaTurns} onChange={(e) => setResourceDeltaTurns(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30" placeholder="+turns" />
                  </div>
                  <div>
                    <label className="block text-[11px] t-text-muted mb-1">+tokens</label>
                    <input value={resourceDeltaTokens} onChange={(e) => setResourceDeltaTokens(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30" placeholder="+tokens" />
                  </div>
                  <div>
                    <label className="block text-[11px] t-text-muted mb-1">+cost usd</label>
                    <input value={resourceDeltaCostUsd} onChange={(e) => setResourceDeltaCostUsd(e.target.value)} className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30" placeholder="+cost usd" />
                  </div>
                </div>
                <button
                  onClick={() => actions.requestResourceExtension({ rationale: resourceRationale, deltaTurns: resourceDeltaTurns, deltaTokens: resourceDeltaTokens, deltaCostUsd: resourceDeltaCostUsd })}
                  className="rounded-md border border-amber-500/40 px-3 py-2 font-medium t-accent-amber hover:bg-amber-500/10"
                >
                  Request Extension
                </button>
              </div>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Diagnostics */}
      <AccordionSection title="Diagnostics">
        <div className="space-y-3 text-xs">
          <div>
            <div className="font-medium mb-2">Maintenance Alerts</div>
            {maintenanceAlerts.length === 0 ? (
              <div className="t-text-muted">No maintenance alerts.</div>
            ) : (
              <div className="space-y-1">
                {maintenanceAlerts.map((event, index) => (
                  <div key={`maintenance-${index}`} className="rounded-md border t-border px-2 py-1">
                    <div className="t-text-muted">{new Date(String(event?.timestamp || Date.now())).toLocaleTimeString()}</div>
                    <div className="font-medium">{String(event?.kind ?? 'maintenance')}</div>
                    <div className="t-text-secondary">{String(event?.message ?? '')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="font-medium mb-2">Runtime Durability</div>
            <div className="space-y-1 t-text-secondary">
              <div>checkpoints: {snapshot?.runtimeStatus?.checkpointCount ?? 0}</div>
              <div>
                lease owner: {snapshot?.runtimeStatus?.lease?.ownerId ?? '-'}
                {snapshot?.runtimeStatus?.lease?.takeoverReason ? ` (${snapshot.runtimeStatus.lease.takeoverReason})` : ''}
              </div>
              <div>
                heartbeat: {snapshot?.runtimeStatus?.lease?.heartbeatAt ? new Date(snapshot.runtimeStatus.lease.heartbeatAt).toLocaleString() : '-'}
              </div>
              <div>
                latest checkpoint: {snapshot?.runtimeStatus?.latestCheckpoint?.fileName ?? '-'}
                {typeof snapshot?.runtimeStatus?.latestCheckpoint?.turnNumber === 'number'
                  ? ` · cycle ${snapshot.runtimeStatus.latestCheckpoint.turnNumber}`
                  : ''}
              </div>
            </div>
          </div>

          <div>
            <div className="font-medium mb-2">Cycle Runtime Metrics</div>
            {turnReports.length === 0 ? (
              <div className="t-text-muted">No cycle metrics yet.</div>
            ) : (
              <div className="space-y-1">
                {[...turnReports].slice(-8).reverse().map((turn) => (
                  <div key={`diag-turn-${turn.turnNumber}`} className="rounded-md border t-border px-2 py-1">
                    <div className="font-medium">Cycle {turn.turnNumber} · {friendlyStage(turn.turnSpec?.stage)}</div>
                    <div className="t-text-secondary">
                      tools {turn.consumedBudgets?.toolCalls ?? 0}
                      {' · '}
                      wall {turn.consumedBudgets?.wallClockSec ?? 0}s
                      {' · '}
                      read {(turn.consumedBudgets?.readBytes ?? 0).toLocaleString()}B
                      {' · '}
                      discovery {turn.consumedBudgets?.discoveryOps ?? 0}
                    </div>
                    <div className="t-text-secondary">
                      prompt {turn.consumedBudgets?.promptTokens ?? 0}
                      {' · '}
                      completion {turn.consumedBudgets?.completionTokens ?? 0}
                      {' · '}
                      total {turn.consumedBudgets?.turnTokens ?? 0}
                      {' · '}
                      ${Number(turn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="font-medium mb-2">Event Feed</div>
            {rawEvents.length === 0 ? (
              <div className="t-text-muted">No events yet.</div>
            ) : (
              <div className="space-y-1">
                {rawEvents.slice(0, 40).map((event, index) => {
                  const formatted = formatEvent(event)
                  return (
                    <div key={`raw-event-${index}`} className="rounded-md border t-border px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span className="t-text-muted">{new Date(formatted.at).toLocaleTimeString()}</span>
                        <span className="font-medium">{formatted.type}</span>
                      </div>
                      <div className="mt-0.5 t-text-secondary">{formatted.text}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </AccordionSection>
    </div>
  )
}
