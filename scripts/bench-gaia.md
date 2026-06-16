# Headless GAIA batch runner

Runs the Research Pilot coordinator over GAIA tasks **without the Electron UI**.
Each task runs in its own fresh project folder → **isolation + clean context +
provenance**, with zero changes to the app.

- **Producer** = this script (headless, batch, isolated).
- **Consumer** = the Electron app (open any task folder to view its audit graph).

## One-time setup

1. Download GAIA (gated — needs HF access) to `~/Desktop/Provenance/gaia-data/`:
   ```bash
   huggingface-cli login        # paste your HF token
   huggingface-cli download gaia-benchmark/GAIA --repo-type dataset \
     --local-dir ~/Desktop/Provenance/gaia-data
   ```
2. Convert metadata parquet → jsonl (Node can't read parquet):
   ```bash
   /opt/anaconda3/bin/python scripts/gaia_to_jsonl.py
   ```
3. Auth — pick ONE, selected by the model id's provider prefix (same rule as the app):

   | `--model` prefix | billing | credential source |
   |------------------|---------|-------------------|
   | `anthropic-sub:` | **Claude subscription** | `~/.research-copilot/anthropic-sub-credentials.json` (OAuth, auto-refreshed) |
   | `openai-codex:`  | **ChatGPT subscription** | `~/.research-copilot/openai-codex-credentials.json`, else falls back to the Codex CLI's `~/.codex/auth.json` (OAuth, auto-refreshed) |
   | `anthropic:`     | API key | `ANTHROPIC_API_KEY` (config.json or shell env) |
   | `openai:` / other | API key | `OPENAI_API_KEY` (config.json or shell env) |

   For subscription, sign in once in the app (model selector → sign in); the script
   reuses the saved OAuth credentials and refreshes the token when it's near expiry.
   For API keys, the script reads `~/.research-copilot/config.json` first (same
   priority as the app), then falls back to shell env.

## Run

```bash
# Preview the selection — no LLM calls, nothing written:
node --import tsx scripts/bench-gaia.ts --model anthropic:claude-opus-4-8 --dry-run

# Real run on Claude subscription (no API key needed):
node --import tsx scripts/bench-gaia.ts --model anthropic-sub:claude-opus-4-7 --per-level 2

# Real run on an API key:
node --import tsx scripts/bench-gaia.ts --model anthropic:claude-opus-4-7 --per-level 2
```

Model ids must exist in the installed pi-ai registry (e.g. `claude-opus-4-7`,
`claude-sonnet-4-6`, `gpt-5.5`) — use the dashed form, not `claude-opus-4.7`.
A model id the registry doesn't know fails with `No API provider registered for
api: unknown`.

### Flags

| flag | default | meaning |
|------|---------|---------|
| `--model` | (required) | pi-mono model id, e.g. `anthropic:claude-opus-4-8`, `openai:gpt-5.5` |
| `--gaia` | `~/Desktop/Provenance/gaia-data` | dataset root |
| `--split` | `validation` | `validation` (has answers) or `test` |
| `--out` | auto | output root; when omitted, auto-named `runs/GAIA-<split>_<YYYYMMDD-HHMM>_<N>q` |
| `--per-level` | `2` | tasks per level (deterministic: sorted by task_id, first N) |
| `--levels` | `1,2,3` | which levels to sample |
| `--tasks` | – | explicit comma-separated task_ids (overrides sampling) |
| `--all` | off | run the whole split (165 for validation) |
| `--limit` | `0` | global cap on selected tasks |
| `--concurrency` | `1` | parallel workers |
| `--reasoning` | `high` | `max｜high｜medium｜low` |
| `--dry-run` | off | print selection only |

## Output layout

```
runs/gaia-validation/
├── index.json                      # summary: model, ok/failed, per-task pointers
└── <task_id>/
    ├── result.json                 # task_id, question, answer, ground_truth, ok, elapsed_ms
    ├── <attachment>                # copied in for tasks that have a file
    └── .research-pilot/            # full project state
        ├── traces/                 # ← provenance (OTLP/JSON spans)
        ├── sessions/<task_id>.jsonl # ← prompt + answer (so the chat panel renders)
        ├── artifacts/              # produced notes/papers/data
        └── ...
```

Open `runs/gaia-validation/<task_id>/` as a project in the Research Pilot app:
- **audit graph** (provenance) renders normally, and
- the **chat panel** shows the prompt + final answer. (The runner writes the
  Q+A into `sessions/<task_id>.jsonl` itself — message persistence is normally
  renderer-driven, which a headless run bypasses.)

## Parallelism

`--concurrency N` runs N tasks at once. Span file routing is per-instance
(each task's TraceStore is bound to its own folder) and OTel context uses
AsyncLocalStorage, so provenance never crosses between concurrent tasks. The
only real limits are external: N× API throughput → watch rate limits (429) and
cost. Start modest (`--concurrency 2`–`3`).

## Notes / known limits

- **No scoring.** The runner stores the raw model output plus the GAIA ground
  truth (`Final answer`) so you can score later with a separate tool. The GAIA
  `FINAL ANSWER: ...` format instruction is appended to every prompt, so the
  answer is ready for exact-match scoring.
- **Audio/video tasks** (`mp3`, `m4a`, `MOV`) will usually fail — the agent has
  no built-in transcription tool. This measures the capability boundary; the
  run still records the attempt + trace. Image tasks go through vision and work.
- **Reset context = new folder; continue = same folder.** A fresh folder per
  task means no session-summary/recap/bootstrap leaks between tasks (the leak
  the in-app "Reset AI context" can't clear when a folder is reused).
- The tracer is constructed directly, bypassing the app's opt-in `tracingMode`
  gate, so provenance is always captured in batch runs.
