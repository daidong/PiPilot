#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="agent-run-to-completion"
RESULT_EMITTED=0

emit_result() {
  RESULT_EMITTED=1
  clrepo_emit_result_json "$1"
}

emit_failure_result() {
  local message="${1:-script_failed}"
  local exit_code="${2:-2}"
  RESULT_EMITTED=1
  clrepo_emit_error_result_json "$SCRIPT_NAME" "$exit_code" "$message" "error"
}

fail() {
  local message="$1"
  local exit_code="${2:-2}"
  echo "error: $message" >&2
  emit_failure_result "$message" "$exit_code"
  exit "$exit_code"
}

trap 'status=$?; if [[ "$status" -ne 0 && "$RESULT_EMITTED" -eq 0 ]]; then emit_failure_result "unexpected_failure" "$status"; fi' EXIT

usage() {
  cat <<'EOF'
usage: agent-run-to-completion.sh --task "<task>" [options]

Options:
  --cwd <path>                       Default: auto-detected.
  --provider <auto|codex|claude>     Default: auto.
  --model <name>                     Optional model override.
  --timeout-sec <seconds>            Optional timeout passed to coding agent and verifier.
  --verify-cmd "<command>"           Optional verification command run after coding completes.
  --deliverable "<path>"             Optional deliverable path that must be touched during this run.
  --poll-interval-sec <seconds>      Default: 6.
  --tail-lines <n>                   Default: 40.
  --max-wait-sec <seconds>           Default: 1800.
  --stale-sec <seconds>              Default: 180.
  --max-restarts <n>                 Default: 1.
  --claude-tools <csv>               Default: Bash,Read,Edit,Write
  -h, --help                         Show help.
EOF
}

TASK=""
CWD=""
CWD_EXPLICIT="false"
PROVIDER="auto"
MODEL=""
TIMEOUT_SEC=""
VERIFY_CMD=""
DELIVERABLE=""
POLL_INTERVAL_SEC="6"
TAIL_LINES="40"
MAX_WAIT_SEC="1800"
STALE_SEC="180"
MAX_RESTARTS="1"
CLAUDE_TOOLS="Bash,Read,Edit,Write"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      TASK="${2:-}"
      shift 2
      ;;
    --cwd)
      CWD="${2:-}"
      CWD_EXPLICIT="true"
      shift 2
      ;;
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --verify-cmd)
      VERIFY_CMD="${2:-}"
      shift 2
      ;;
    --deliverable)
      DELIVERABLE="${2:-}"
      shift 2
      ;;
    --poll-interval-sec)
      POLL_INTERVAL_SEC="${2:-}"
      shift 2
      ;;
    --tail-lines)
      TAIL_LINES="${2:-}"
      shift 2
      ;;
    --max-wait-sec)
      MAX_WAIT_SEC="${2:-}"
      shift 2
      ;;
    --stale-sec)
      STALE_SEC="${2:-}"
      shift 2
      ;;
    --max-restarts)
      MAX_RESTARTS="${2:-}"
      shift 2
      ;;
    --claude-tools)
      CLAUDE_TOOLS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1" 2
      ;;
  esac
done

if [[ -z "$TASK" ]]; then
  usage >&2
  fail "--task is required" 2
fi
case "$PROVIDER" in
  auto|codex|claude)
    ;;
  *)
    fail "invalid --provider: $PROVIDER (expected auto|codex|claude)" 2
    ;;
esac
if [[ -n "$TIMEOUT_SEC" ]] && ! clrepo_require_positive_integer "$TIMEOUT_SEC" "--timeout-sec"; then
  fail "invalid --timeout-sec: $TIMEOUT_SEC" 2
fi
if ! clrepo_require_positive_integer "$POLL_INTERVAL_SEC" "--poll-interval-sec"; then
  fail "invalid --poll-interval-sec: $POLL_INTERVAL_SEC" 2
fi
if ! clrepo_require_positive_integer "$TAIL_LINES" "--tail-lines"; then
  fail "invalid --tail-lines: $TAIL_LINES" 2
fi
if ! clrepo_require_positive_integer "$MAX_WAIT_SEC" "--max-wait-sec"; then
  fail "invalid --max-wait-sec: $MAX_WAIT_SEC" 2
fi
if ! clrepo_require_positive_integer "$STALE_SEC" "--stale-sec"; then
  fail "invalid --stale-sec: $STALE_SEC" 2
fi
if [[ ! "$MAX_RESTARTS" =~ ^[0-9]+$ ]]; then
  fail "invalid --max-restarts: $MAX_RESTARTS (must be >= 0)" 2
fi

REQUESTED_CWD=""
if [[ "$CWD_EXPLICIT" == "true" ]]; then
  REQUESTED_CWD="$CWD"
fi
CWD_REASON="default_root"
clrepo_resolve_cwd "$REQUESTED_CWD" "$TASK $VERIFY_CMD $DELIVERABLE" CWD CWD_REASON
if [[ ! -d "$CWD" ]]; then
  fail "cwd does not exist: $CWD" 2
fi
ABS_CWD="$(cd "$CWD" && pwd)"

RUN_LEGACY_LAST_OUTPUT=""
RUN_LEGACY_LAST_JSON=""
RUN_LEGACY_LAST_STATUS=0

run_legacy_script_capture() {
  local script_name="$1"
  shift || true
  local script_path="$SCRIPT_DIR/$script_name.sh"
  if [[ ! -f "$script_path" ]]; then
    fail "internal script missing: $script_name.sh" 2
  fi
  local output=""
  local status=0
  set +e
  output="$(
    env CODING_LARGE_REPO_ALLOW_LEGACY_ENTRY=1 bash "$script_path" "$@" 2>&1
  )"
  status=$?
  set -e

  RUN_LEGACY_LAST_OUTPUT="$output"
  RUN_LEGACY_LAST_STATUS="$status"
  RUN_LEGACY_LAST_JSON="$(clrepo_extract_result_json_line "$output" || true)"

  printf '%s\n' "$output"
  if [[ -z "$RUN_LEGACY_LAST_JSON" ]]; then
    fail "missing AF_RESULT_JSON from $script_name" 2
  fi
}

json_field_or_empty() {
  local raw_json="${1-}"
  local field="${2-}"
  clrepo_json_field "$raw_json" "$field" 2>/dev/null || true
}

SESSION_ID=""
SESSION_LOG_PATH=""
START_JSON=""
FINAL_AGENT_STATUS=""
FINAL_AGENT_EXIT_CODE=""
RESTART_COUNT=0
RUN_BEGIN_EPOCH="$(date +%s)"
LAST_PROGRESS_EPOCH="$RUN_BEGIN_EPOCH"
LAST_LOG_SIZE=-1

start_new_session() {
  local start_label="${1:-initial}"
  local -a args=(
    --task "$TASK"
    --provider "$PROVIDER"
    --cwd "$ABS_CWD"
    --claude-tools "$CLAUDE_TOOLS"
  )
  if [[ -n "$MODEL" ]]; then
    args+=(--model "$MODEL")
  fi
  if [[ -n "$TIMEOUT_SEC" ]]; then
    args+=(--timeout-sec "$TIMEOUT_SEC")
  fi
  echo "[coding-large-repo] starting session ($start_label)"
  run_legacy_script_capture "agent-start" "${args[@]}"

  START_JSON="$RUN_LEGACY_LAST_JSON"
  local start_status=""
  start_status="$(json_field_or_empty "$START_JSON" "status")"
  SESSION_ID="$(json_field_or_empty "$START_JSON" "session_id")"
  SESSION_LOG_PATH="$(json_field_or_empty "$START_JSON" "log_path")"
  if [[ "$RUN_LEGACY_LAST_STATUS" -ne 0 || "$start_status" != "running" || -z "$SESSION_ID" ]]; then
    fail "agent-start failed to return running session_id (status=${start_status:-unknown})" 2
  fi
  LAST_PROGRESS_EPOCH="$(date +%s)"
  LAST_LOG_SIZE=-1
}

check_log_progress() {
  if [[ -z "$SESSION_LOG_PATH" || ! -f "$SESSION_LOG_PATH" ]]; then
    return 0
  fi
  local current_size=""
  current_size="$(clrepo_file_size_bytes "$SESSION_LOG_PATH" 2>/dev/null || true)"
  if [[ -z "$current_size" || ! "$current_size" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if [[ "$LAST_LOG_SIZE" -lt 0 || "$current_size" -gt "$LAST_LOG_SIZE" ]]; then
    LAST_LOG_SIZE="$current_size"
    LAST_PROGRESS_EPOCH="$(date +%s)"
  fi
}

attempt_restart_if_stale() {
  local now_epoch="$1"
  local stale_for=$((now_epoch - LAST_PROGRESS_EPOCH))
  if [[ "$stale_for" -lt "$STALE_SEC" ]]; then
    return 1
  fi
  if [[ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]]; then
    return 1
  fi

  echo "[coding-large-repo] stale session detected ($stale_for sec), restarting"
  run_legacy_script_capture "agent-kill" --session-id "$SESSION_ID" --signal TERM || true
  RESTART_COUNT=$((RESTART_COUNT + 1))
  start_new_session "restart-$RESTART_COUNT"
  return 0
}

run_legacy_script_capture "repo-intake" "$ABS_CWD"
REPO_INTAKE_JSON="$RUN_LEGACY_LAST_JSON"
if [[ "$RUN_LEGACY_LAST_STATUS" -ne 0 ]]; then
  fail "repo-intake failed" "$RUN_LEGACY_LAST_STATUS"
fi

run_legacy_script_capture "change-plan" "$TASK"
PLAN_JSON="$RUN_LEGACY_LAST_JSON"
PLAN_PATH="$(json_field_or_empty "$PLAN_JSON" "plan_path")"
if [[ "$RUN_LEGACY_LAST_STATUS" -ne 0 ]]; then
  fail "change-plan failed" "$RUN_LEGACY_LAST_STATUS"
fi

start_new_session "initial"

while true; do
  run_legacy_script_capture "agent-poll" --session-id "$SESSION_ID" --tail-lines "$TAIL_LINES"
  POLL_JSON="$RUN_LEGACY_LAST_JSON"
  POLL_STATUS="$(json_field_or_empty "$POLL_JSON" "status")"
  POLL_EXIT_CODE="$(json_field_or_empty "$POLL_JSON" "exit_code")"
  POLL_LOG_PATH="$(json_field_or_empty "$POLL_JSON" "log_path")"
  if [[ -n "$POLL_LOG_PATH" ]]; then
    SESSION_LOG_PATH="$POLL_LOG_PATH"
  fi
  check_log_progress

  case "$POLL_STATUS" in
    completed|failed|error)
      FINAL_AGENT_STATUS="$POLL_STATUS"
      FINAL_AGENT_EXIT_CODE="$POLL_EXIT_CODE"
      break
      ;;
    running)
      ;;
    *)
      FINAL_AGENT_STATUS="error"
      FINAL_AGENT_EXIT_CODE="2"
      break
      ;;
  esac

  NOW_EPOCH="$(date +%s)"
  if (( NOW_EPOCH - RUN_BEGIN_EPOCH >= MAX_WAIT_SEC )); then
    fail "agent session exceeded --max-wait-sec ($MAX_WAIT_SEC)" 124
  fi
  if attempt_restart_if_stale "$NOW_EPOCH"; then
    continue
  fi
  sleep "$POLL_INTERVAL_SEC"
done

if [[ "$FINAL_AGENT_STATUS" != "completed" ]]; then
  fail "agent session failed (status=${FINAL_AGENT_STATUS:-unknown}, exit_code=${FINAL_AGENT_EXIT_CODE:-n/a})" 2
fi

VERIFY_JSON=""
VERIFY_STATUS=""
VERIFY_LOG_PATH=""
if [[ -n "$VERIFY_CMD" ]]; then
  declare -a verify_args=(
    --cmd "$VERIFY_CMD"
    --cwd "$ABS_CWD"
  )
  if [[ -n "$TIMEOUT_SEC" ]]; then
    verify_args+=(--timeout-sec "$TIMEOUT_SEC")
  fi
  run_legacy_script_capture "verify-targets" "${verify_args[@]}"
  VERIFY_JSON="$RUN_LEGACY_LAST_JSON"
  VERIFY_STATUS="$(json_field_or_empty "$VERIFY_JSON" "status")"
  VERIFY_LOG_PATH="$(json_field_or_empty "$VERIFY_JSON" "log_path")"
  if [[ "$RUN_LEGACY_LAST_STATUS" -ne 0 || "$VERIFY_STATUS" != "completed" ]]; then
    fail "verify-targets failed (status=${VERIFY_STATUS:-unknown})" 2
  fi
fi

DELIVERABLE_PATH=""
DELIVERABLE_TOUCHED="null"
if [[ -n "$DELIVERABLE" ]]; then
  if [[ "$DELIVERABLE" == /* ]]; then
    DELIVERABLE_PATH="$DELIVERABLE"
  else
    DELIVERABLE_PATH="$ABS_CWD/$DELIVERABLE"
  fi
  if [[ ! -e "$DELIVERABLE_PATH" ]]; then
    fail "no_delta: deliverable not found ($DELIVERABLE)" 2
  fi
  deliverable_mtime="$(clrepo_file_mtime_epoch "$DELIVERABLE_PATH" 2>/dev/null || true)"
  if [[ -z "$deliverable_mtime" || ! "$deliverable_mtime" =~ ^[0-9]+$ ]]; then
    fail "no_delta: deliverable mtime unavailable ($DELIVERABLE)" 2
  fi
  if [[ "$deliverable_mtime" -lt "$RUN_BEGIN_EPOCH" ]]; then
    fail "no_delta: deliverable not touched in this run ($DELIVERABLE)" 2
  fi
  DELIVERABLE_TOUCHED="true"
fi

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-run-to-completion\",\"status\":\"completed\",\"exit_code\":0,\"requested_cwd\":%s,\"cwd\":%s,\"cwd_reason\":%s,\"provider\":%s,\"model\":%s,\"session_id\":%s,\"agent_log_path\":%s,\"restart_count\":%s,\"repo_intake_status\":%s,\"plan_path\":%s,\"verify_cmd\":%s,\"verify_status\":%s,\"verify_log_path\":%s,\"deliverable\":%s,\"deliverable_path\":%s,\"deliverable_touched\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$REQUESTED_CWD")" \
  "$(clrepo_json_string_or_null "$ABS_CWD")" \
  "$(clrepo_json_string_or_null "$CWD_REASON")" \
  "$(clrepo_json_string_or_null "$PROVIDER")" \
  "$(clrepo_json_string_or_null "$MODEL")" \
  "$(clrepo_json_string_or_null "$SESSION_ID")" \
  "$(clrepo_json_string_or_null "$SESSION_LOG_PATH")" \
  "$(clrepo_json_number_or_null "$RESTART_COUNT")" \
  "$(clrepo_json_string_or_null "$(json_field_or_empty "$REPO_INTAKE_JSON" "status")")" \
  "$(clrepo_json_string_or_null "$PLAN_PATH")" \
  "$(clrepo_json_string_or_null "$VERIFY_CMD")" \
  "$(clrepo_json_string_or_null "$VERIFY_STATUS")" \
  "$(clrepo_json_string_or_null "$VERIFY_LOG_PATH")" \
  "$(clrepo_json_string_or_null "$DELIVERABLE")" \
  "$(clrepo_json_string_or_null "$DELIVERABLE_PATH")" \
  "$DELIVERABLE_TOUCHED")"
emit_result "$RESULT_JSON"
