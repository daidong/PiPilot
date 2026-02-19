#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="agent-poll"
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

if ! clrepo_require_legacy_entry_opt_in "$SCRIPT_NAME"; then
  RESULT_EMITTED=1
  exit 2
fi

usage() {
  cat <<'EOF'
usage: agent-poll.sh --session-id "<id>" [--tail-lines <n>]
EOF
}

SESSION_ID=""
TAIL_LINES="40"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --tail-lines)
      TAIL_LINES="${2:-40}"
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

if [[ -z "$SESSION_ID" ]]; then
  usage >&2
  fail "--session-id is required" 2
fi
if ! clrepo_require_positive_integer "$TAIL_LINES" "--tail-lines"; then
  fail "invalid --tail-lines: $TAIL_LINES" 2
fi

SESSION_DIR="$(clrepo_find_agent_session_dir "$SESSION_ID" || true)"
if [[ -z "$SESSION_DIR" ]]; then
  fail "session not found: $SESSION_ID" 2
fi

LOG_PATH="$SESSION_DIR/agent.log"
EXIT_PATH="$SESSION_DIR/exit_code"
PID_PATH="$SESSION_DIR/pid"
META_PATH="$SESSION_DIR/meta.env"

PID=""
if [[ -f "$PID_PATH" ]]; then
  PID="$(cat "$PID_PATH" 2>/dev/null || true)"
fi

infer_exit_code_from_log() {
  if [[ ! -f "$LOG_PATH" ]]; then
    return 1
  fi
  local marker_line
  marker_line="$(grep -E 'AF_RESULT_JSON:\s*\{' "$LOG_PATH" | tail -n 1 || true)"
  if [[ -z "$marker_line" ]]; then
    return 1
  fi
  if [[ "$marker_line" =~ \"exit_code\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

pid_matches_session() {
  if [[ -z "$PID" || -z "$SESSION_DIR" ]]; then
    return 1
  fi
  local runner_path="$SESSION_DIR/runner.sh"
  if [[ ! -f "$runner_path" ]]; then
    return 1
  fi
  local cmdline=""
  cmdline="$(ps -o command= -p "$PID" 2>/dev/null || true)"
  [[ -n "$cmdline" && "$cmdline" == *"$runner_path"* ]]
}

STATE="unknown"
EXIT_CODE="n/a"
STATE_REASON=""

if [[ -n "$PID" ]] && kill -0 "$PID" >/dev/null 2>&1 && pid_matches_session; then
  STATE="running"
  STATE_REASON="pid_running"
elif [[ -f "$EXIT_PATH" ]]; then
  EXIT_CODE="$(cat "$EXIT_PATH" 2>/dev/null || echo "n/a")"
  if [[ "$EXIT_CODE" == "0" ]]; then
    STATE="completed"
    STATE_REASON="exit_file_zero"
  else
    STATE="failed"
    STATE_REASON="exit_file_nonzero"
  fi
elif [[ -n "$PID" ]]; then
  if kill -0 "$PID" >/dev/null 2>&1; then
    STATE="failed"
    STATE_REASON="pid_mismatch"
  fi
  inferred_exit_code="$(infer_exit_code_from_log || true)"
  if [[ -n "$inferred_exit_code" ]]; then
    EXIT_CODE="$inferred_exit_code"
    if [[ "$EXIT_CODE" == "0" ]]; then
      STATE="completed"
      STATE_REASON="inferred_exit_zero"
    else
      STATE="failed"
      STATE_REASON="inferred_exit_nonzero"
    fi
  else
    if [[ "$STATE_REASON" != "pid_mismatch" ]]; then
      STATE="failed"
      STATE_REASON="missing_exit_code"
    fi
  fi
fi

clrepo_print_kv session_id "$SESSION_ID"
clrepo_print_kv state "$STATE"
clrepo_print_kv state_reason "$STATE_REASON"
clrepo_print_kv pid "${PID:-n/a}"
clrepo_print_kv exit_code "$EXIT_CODE"
clrepo_print_kv log_path "$LOG_PATH"
clrepo_print_kv meta_path "$META_PATH"
clrepo_print_kv session_dir "$SESSION_DIR"

if [[ -f "$LOG_PATH" ]]; then
  echo "log_tail_begin:"
  tail -n "$TAIL_LINES" "$LOG_PATH"
  echo "log_tail_end"
else
  echo "log_tail: <missing>"
fi

TAIL_PREVIEW=""
if [[ -f "$LOG_PATH" ]]; then
  TAIL_PREVIEW="$(tail -n "$TAIL_LINES" "$LOG_PATH" 2>/dev/null || true)"
  TAIL_PREVIEW="$(clrepo_compact_text "$TAIL_PREVIEW" 500)"
fi

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-poll\",\"status\":%s,\"state_reason\":%s,\"session_id\":%s,\"pid\":%s,\"exit_code\":%s,\"session_dir\":%s,\"log_path\":%s,\"meta_path\":%s,\"tail_preview\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$STATE")" \
  "$(clrepo_json_string_or_null "$STATE_REASON")" \
  "$(clrepo_json_string_or_null "$SESSION_ID")" \
  "$(clrepo_json_number_or_null "${PID:-}")" \
  "$(clrepo_json_number_or_null "${EXIT_CODE:-}")" \
  "$(clrepo_json_string_or_null "$SESSION_DIR")" \
  "$(clrepo_json_string_or_null "$LOG_PATH")" \
  "$(clrepo_json_string_or_null "$META_PATH")" \
  "$(clrepo_json_string_or_null "$TAIL_PREVIEW")")"
emit_result "$RESULT_JSON"
