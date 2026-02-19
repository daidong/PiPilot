#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="agent-kill"
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
usage: agent-kill.sh --session-id "<id>" [--signal <TERM|KILL|INT>]
EOF
}

SESSION_ID=""
SIGNAL="TERM"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --signal)
      SIGNAL="${2:-TERM}"
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
case "$SIGNAL" in
  TERM|KILL|INT)
    ;;
  *)
    fail "invalid --signal: $SIGNAL (expected TERM|KILL|INT)" 2
    ;;
esac

SESSION_DIR="$(clrepo_find_agent_session_dir "$SESSION_ID" || true)"
if [[ -z "$SESSION_DIR" ]]; then
  fail "session not found: $SESSION_ID" 2
fi

PID_PATH="$SESSION_DIR/pid"

if [[ ! -f "$PID_PATH" ]]; then
  fail "pid file not found for session: $SESSION_ID" 2
fi

PID="$(cat "$PID_PATH" 2>/dev/null || true)"
if [[ -z "$PID" ]]; then
  fail "empty pid for session: $SESSION_ID" 2
fi

if kill -0 "$PID" >/dev/null 2>&1; then
  kill "-$SIGNAL" "$PID"
  clrepo_print_kv session_id "$SESSION_ID"
  clrepo_print_kv pid "$PID"
  clrepo_print_kv signal "$SIGNAL"
  clrepo_print_kv state "kill_sent"
  RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-kill\",\"status\":\"kill_sent\",\"session_id\":%s,\"session_dir\":%s,\"pid\":%s,\"signal\":%s}' \
    "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
    "$(clrepo_json_string_or_null "$SESSION_ID")" \
    "$(clrepo_json_string_or_null "$SESSION_DIR")" \
    "$(clrepo_json_number_or_null "$PID")" \
    "$(clrepo_json_string_or_null "$SIGNAL")")"
  emit_result "$RESULT_JSON"
else
  clrepo_print_kv session_id "$SESSION_ID"
  clrepo_print_kv pid "$PID"
  clrepo_print_kv state "not_running"
  RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-kill\",\"status\":\"not_running\",\"session_id\":%s,\"session_dir\":%s,\"pid\":%s,\"signal\":%s}' \
    "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
    "$(clrepo_json_string_or_null "$SESSION_ID")" \
    "$(clrepo_json_string_or_null "$SESSION_DIR")" \
    "$(clrepo_json_number_or_null "$PID")" \
    "$(clrepo_json_string_or_null "$SIGNAL")")"
  emit_result "$RESULT_JSON"
fi
