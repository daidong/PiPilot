# YOLO Researcher Desktop

Independent Electron UI for `examples/yolo-researcher`.

## Run

```bash
npm run example:yolo-researcher:desktop:install
npm run example:yolo-researcher:desktop:dev
```

Or run directly in this folder:

```bash
cd examples/yolo-researcher/desktop
npm install
npm run dev
```

## What is implemented (P0/P1 UI)

- Mission Control view (goal, runtime state, controls, budgets)
- Turn Timeline view (turn reports and event feed)
- Branch Explorer view (branch nodes, active pointer, branch lineage)
- Asset Inventory view (asset type counts + latest asset ledger)
- Evidence Map view (graphical nodes/edges for Claim/EvidenceLink/evidence/decision relationships + claim matrix list)
- Checkpoint Dialog behavior for `WAITING_FOR_USER`
- Checkpoint modal for freeze decisions + side-panel question card for non-checkpoint asks
- Checkpoint reply auto-records `Decision` asset and `checkpoint_confirmed` event
- Input queue panel (view, reprioritize, reorder, remove)
- Session recovery: reopen project restores snapshot + turn timeline for the saved session id
- Budget warning bands (80% warning, 95% critical) + timeline filters (stage/gate/progress)
- Event panel restores recent history from `events.jsonl` on session restore
- Export actions:
  - session summary (`yolo/<sid>/exports/session-summary-*.json`)
  - claim-evidence table (`yolo/<sid>/exports/claim-evidence-table-*.json`)
  - asset inventory (`yolo/<sid>/exports/asset-inventory-*.json`)
  - final bundle manifest (`yolo/<sid>/exports/final-bundle-*.manifest.json`) linking all three exports
- Session auto-exports final bundle when runtime first reaches `COMPLETE`
- Phase selector (`P0-P3`) on start and P1+ External Wait panel (`WAITING_EXTERNAL` flow)
- P1+ ingress upload bridge: pick local files and stage into session `ingress/user-turn-*-upload` directories
- Resolving `WAITING_EXTERNAL` now requires at least one file in the task upload directory
- Wait-ticket state changes are snapshotted under `wait-tasks/history/*.json`
- Resource extension request/decision flow (`WAITING_FOR_USER` with `ResourceBudget` append-only records)
- Full-text missing path helper in runtime: `requestFullTextUploadWait(...)` emits `ask_user` + `WAITING_EXTERNAL`
- Mission Control includes a quick form to request full-text wait tickets from citation + required files
- Full-text wait resolution enforces declared `requiredFiles` (not just any file present)
- `completionRule` supports deterministic checklist syntax (`checklist:has_upload,required_files`)

## IPC contracts

Main process exposes:

- `yolo:start(goal, options)`
- `yolo:pause({ immediate? })`
- `yolo:resume()`
- `yolo:stop()`
- `yolo:enqueue-input(text, priority?)`
- `yolo:get-input-queue()`
- `yolo:queue-remove(id)`
- `yolo:queue-reprioritize(id, priority)`
- `yolo:queue-move(id, toIndex)`
- `yolo:get-snapshot()`
- `yolo:get-turn-reports()`
- `yolo:get-events()`
- `yolo:export-summary()`
- `yolo:export-claim-evidence-table()`
- `yolo:export-asset-inventory()`
- `yolo:export-final-bundle()`
- `yolo:wait-external({ title, completionRule, resumeAction, details? })`
- `yolo:request-fulltext-wait({ citation, requiredFiles?, reason? })`
- `yolo:list-wait-tasks()`
- `yolo:validate-wait-task({ taskId })`
- `yolo:add-ingress-files({ taskId?, turnNumber? })`
- `yolo:cancel-wait-task({ taskId, reason })`
- `yolo:resolve-wait-task({ taskId, resolutionNote })`
- `yolo:request-resource-extension({ rationale, delta, requestedBy? })`
- `yolo:resolve-resource-extension({ approved, note? })`

Push events:

- `yolo:state`
- `yolo:turn-report`
- `yolo:question`
- `yolo:event`
