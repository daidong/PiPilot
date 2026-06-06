# RFC-017: Compute Tab UX Redesign

> Spec version: 0.1 (DRAFT — not implemented) | Last updated: 2026-06-06
>
> Status: **PROPOSED**. Redesigns the Compute tab around *user intent and
> operation type* instead of internal lifecycle buckets. Supersedes the relevant
> center-panel sections of `local-compute-ui.md`, which predate the dual-track
> lifecycle (RFC-016), the auto-run-local decision (RFC-016 §4.4), and the
> experiment-sweep workflow this RFC centers on.
>
> Depends on **RFC-016** (compute lifecycle: ephemeral-local + poll-remote) and
> **RFC-015** (approval bridge — now remote-only). This RFC is the UI layer; those
> are the model layer.

## 1. Problem

The current Compute tab is organized around *internal lifecycle state*
(unapproved plans → approved-placeholder → active runs → recent runs), which
produces a tab that is hard to act on:

- **Internal states leak into the UI.** "approved — waiting for agent to execute"
  is an implementation artifact (and, pre-RFC-016, a bug symptom). Users see
  transient internal buckets as first-class rows.
- **The most useful signals are hidden.** What you actually want to watch — live
  output and progress — is behind an expand chevron; the surface shows
  `DURATION --` and `0 lines`.
- **Local and remote look identical** despite radically different affordances and
  risk (local is tied to this machine; remote keeps running after you quit and
  costs money).
- **No notion of a campaign / sweep.** The real workflow is *batches of related
  runs* (e.g. `phase1_semantics`, `phase2_construction_delay`, threshold sweeps,
  branchability probes). The flat per-row table can't express "this is one sweep
  of 10 runs; 8 done, 1 failed, 1 running."
- **Status can be stale** (the zombie-run bug). The UI trusts a persisted flag
  instead of RFC-016's re-derived truth.

## 2. Principles

1. **Organize by user intent, not internal state.** Three zones: *needs you* /
   *running* / *finished* — not four lifecycle buckets.
2. **Live output + progress are first-class**, not hidden behind expand. The tab
   exists to *watch work*; surface what you watch.
3. **Local vs remote is legible at a glance** — different badges, different
   affordances, different risk framing.
4. **Campaigns/sweeps are first-class** in the finished zone — group related runs
   so a sweep reads as one thing.
5. **Show re-derived truth** (RFC-016): status reflects OS/remote reality, never a
   trusted persisted flag.
6. **Decisions are rare and meaningful** (RFC-016 §4.4): local auto-runs, so the
   "needs you" zone is for *remote cost confirmation* + *flagged-danger
   confirmation* only — not routine per-task approval.

## 3. Operation / intent matrix

The redesign is driven by what the user actually wants to do:

| Intent | Operation | Zone |
|---|---|---|
| Decide on real spend / risk | confirm remote run (cost); confirm a flagged-dangerous local command | ① Needs you |
| Watch a task | live output tail, progress, resource use | ② Running |
| Trust it's alive | re-derived status (RFC-016) | ② Running |
| End it early | stop / kill | ② Running |
| See how it finished | output, exit code, failure reason + suggestions | ③ Finished |
| Fix & rerun | retry (with lineage), clone/re-run | ③ Finished |
| Track a sweep | grouped campaign view, group progress | ③ Finished |
| Understand cost | per-run + per-campaign remote cost | ②/③ |
| Feed results back | jump to Chat / hand run output to the agent | ②/③ |
| Declutter | dismiss/delete a record | ③ |
| Know where it runs | target/backend + resources | Target strip |

## 4. Layout

```
┌─ Target strip (sticky) ──────────────────────────────────────────────┐
│  ⚙ Local · darwin arm64 · 24GB · M4      ☁ Modal idle    ☁ AWS off    │
├─ ① Needs you  (hidden when empty) ──────────────────────────────────┤
│  ☁ Modal run — est. $0.40, A100·10min        [Confirm & run] [Skip]   │
│  ⚠ Local: `rm -rf results/` flagged risky    [Run anyway]   [Skip]    │
├─ ② Running  (the heart) ────────────────────────────────────────────┤
│  ● run_ttl_sentinel_anthropic.py   ⚙ local · this Mac      [Stop]     │
│     ▓▓▓▓▓▓░░░ 62%   tail: "probe 124/200 · 512-tok prefix… "           │
│  ● phase2_construction_delay        ☁ Modal · keeps running · $0.12   │
│     ▓▓▓░░░░░░ 31%   tail: "delay=2s … cache-usable=false"     [Stop]   │
├─ ③ Finished  (grouped by campaign) ─────────────────────────────────┤
│  Search […]            All · ⚙ Local · ☁ Modal · ☁ AWS                │
│  ▸ branchability sweep        8 ✓ · 1 ✗ · 1 ●        2h ago           │
│  ▾ ttl-sentinel campaign      3 ✓                    just now         │
│       ✓ run_ttl…anthropic   exit 0 · 4m12s   [View][Retry][Reuse]     │
│       ✓ run_ttl…openai      exit 0 · 3m58s   [View][Retry][Reuse]     │
│  ▸ (ungrouped)                phase1_semantics ✓                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Target strip (sticky)
Backends and their state at a glance: local host + resources; remote backends
idle/active + whether configured. Click → backend detail / settings. (Reuses
much of today's `ComputeSidebar` target card, promoted to a thin sticky strip so
it never scrolls away.)

### 4.2 Zone ① — Needs you (conditional)
Only rendered when something genuinely needs a decision. Under RFC-016 §4.4 that
is **not** routine local approval. It is:
- **Remote cost confirmation**: a remote run with an estimated cost (and the
  RFC-015 approval bridge submits it on confirm).
- **Flagged-danger confirmation**: a *rule-based* danger check (not LLM plan
  approval) flagged a local command (e.g. recursive delete, network exfil). One
  tap to proceed or skip. Everything not flagged auto-runs and never appears here.
- Respects `forceApprovalForAll` (the paranoid/shared-lab escape hatch): when on,
  local runs route through this zone too.

### 4.3 Zone ② — Running (the heart of the tab)
Each running task shows, **inline without expanding**:
- live **output tail** (last line or two) + a **progress bar** (when the task
  emits structured progress);
- a **locality badge**: `⚙ local · this Mac` vs `☁ Modal · keeps running if you
  quit · $X` — making the durability/cost difference impossible to miss;
- **re-derived status** (RFC-016): running / stalled (with "no output for N min"),
  never a stale flag;
- **Stop** (and for stalled, a nudge). Expanding shows the full live stream, env,
  resource use, and (remote) cost.

### 4.4 Zone ③ — Finished, grouped by campaign
- Runs **group into campaigns/sweeps** (grouping key — see §6). A collapsed
  campaign shows aggregate outcome (`8 ✓ · 1 ✗ · 1 ●`) + relative time. Expanding
  lists member runs.
- Per run: outcome + exit code + duration, and actions **View** (output/logs),
  **Retry** (re-submit with parent lineage), **Reuse** (clone command into a new
  run / hand to chat).
- Search + per-backend filter (today's filter bar, retained).
- Ungrouped runs fall into an "(ungrouped)" bucket.

### 4.5 Scheduled tasks (management surface)
A **Scheduled** section manages the home-scoped cron tasks defined in RFC-016
§4.5 (multi-day / recurring experiments). Per task: command, schedule, backend,
enabled toggle, **next-due**, **last-run**, and **missed-since-last-open** (so
app-open/best-effort gaps are visible, not silent — RFC-016 §4.5). Actions:
edit, enable/disable, delete, run-now. Each fired tick appears in Zone ③ as a
normal run, grouped into the task's campaign. Placement (its own zone vs. a
panel off the target strip) — see §11.

## 5. Run detail (expanded)
A running or finished row expands to:
- **Output stream** (the persisted append-only file, RFC-016 §4.1) — tail by
  default, scrollable, with a "jump to live" affordance for running tasks.
- **Outcome**: exit code; for failures, the derived failure signal + suggestions.
- **Environment**: sandbox, resources, command.
- **Cost** (remote only).
- **Lineage**: parent/retry chain; link to the campaign.
- **Hand to chat**: send this run's output/summary back to the agent.

## 6. Campaign / sweep grouping — open decision
Grouping is the biggest new concept. Candidate keys (need to pick one, or a
priority chain):
- **(a) Submission batch** — runs the agent submitted in one turn (a `turnId` /
  batch id stamped at submit). Most precise to "one sweep the agent kicked off."
- **(b) Retry lineage** — `parentRunId` chains. Necessary but only captures
  retries, not sibling sweeps.
- **(c) Command family** — normalize the command (script path + suite, minus
  varying args) into a family key. Captures "all `dccprobe run-suite …`" but may
  over- or under-group.

Recommendation: **(a) primary** (stamp a `campaignId` at submit time, derived
from the agent turn that produced the batch), with (b) folding retries into their
parent's campaign, and (c) as a soft fallback for ungrouped legacy runs. Decide
before building Zone ③.

## 7. Local vs remote treatment
Same row component, **divergent framing**:
- **Local** (`⚙`): "this Mac", ephemeral, free, OS-scheduled, runs concurrently
  (RFC-016 §4.1). Closing the app → covered by RFC-016 quit policy (§10).
- **Remote** (`☁`): "keeps running if you quit", shows **cost**, status is
  **polled** (RFC-016 §4.2) so a small lag is expected and labeled.
Open: a single list with badges (recommended — fewer modes) vs. split columns. §11.

## 8. Real-time + truth source
- Output streams from the persisted file (RFC-016 §4.1 local / remote logs).
- Status comes from RFC-016 re-derivation (OS+sentinel local / poll remote), so
  the zombie-run class of stale "running" cannot appear here.
- Completion is pushed (notification), not polled by the UI — the row transitions
  on the `compute:event` it already subscribes to.

## 9. Empty & first-run states
- **No runs ever**: a short "what is compute" explainer + the target strip, not a
  blank table.
- **All idle**: target strip + a quiet "no active runs" with recent campaigns
  below.

## 10. Component / store changes
- `ComputeView.tsx`: re-compose around the three zones; demote the lifecycle-bucket
  selectors. The "approved — waiting" placeholder rendering is **deleted** (local
  auto-runs; remote confirms in Zone ①).
- New: `CampaignGroup`, `RunningRow` (with inline output/progress), `NeedsYouCard`
  (remote-cost / danger-confirm).
- Store: add `campaignId` to run views; selectors `useRunningRuns`,
  `useCampaigns(finished)`, `useDecisions` (remote-confirm + flagged-danger).
- `ComputeSidebar` target card → sticky target strip (or keep sidebar; §11).

## 11. Open questions
1. **Campaign grouping key** (§6) — (a) submission-batch recommended.
2. **Local/remote**: one list + badges (recommended) vs. split.
3. **Target strip vs. sidebar**: promote target to a sticky top strip, or keep the
   left `ComputeSidebar`? (Sidebar has more room for stats/experience insights.)
4. **Danger-check policy** (RFC-016 §4.4): which command patterns flag into Zone ①,
   and is the classifier shared with the coding-agent bash permission layer?
5. **"Hand to chat"** payload: full output vs. summary vs. a reference the agent
   fetches on demand.

## 12. Out of scope
- The lifecycle model itself (RFC-016) and the remote approval bridge (RFC-015).
- Backend configuration UIs (Settings → Compute), unchanged.
- The left sidebar's experience-insights / stats content (kept; only its
  placement is touched by §11).
