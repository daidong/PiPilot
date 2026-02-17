# YOLO Researcher Desktop (v2)

Minimal Electron UI for `examples/yolo-researcher` v2.

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

## Scope

This desktop app is intentionally v2-only:

- One project folder at a time
- One v2 session rooted at workspace
- Evidence-first inspection of:
  - `PROJECT.md`
  - `FAILURES.md`
  - `runs/turn-xxxx/*`

UI includes:

- Session controls (`start`, `run-turn`, `run-loop`, `stop`)
- Live event feed
- Turn evidence browser (turn files + artifacts)

## IPC (v2 only)

Invoke channels:

- `session:current`
- `project:pick-folder`
- `project:close`
- `yolo:start`
- `yolo:run-turn`
- `yolo:run-loop`
- `yolo:stop`
- `yolo:get-overview`
- `yolo:get-project-markdown`
- `yolo:get-failures-markdown`
- `yolo:list-turns`
- `yolo:read-turn-file`
- `yolo:list-turn-artifacts`
- `yolo:read-artifact-file`

Push events:

- `yolo:event`
- `yolo:turn-result`
- `project:closed`

## Turn files exposed in UI

- `action.md`
- `cmd.txt`
- `stdout.txt`
- `stderr.txt`
- `exit_code.txt`
- `result.json`
- `patch.diff`

Artifacts are read from `runs/turn-xxxx/artifacts/`.
