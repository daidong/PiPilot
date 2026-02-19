#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="agent-log"
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
usage: agent-log.sh --session-id "<id>" [--tail-lines <n>]
EOF
}

SESSION_ID=""
TAIL_LINES="200"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --tail-lines)
      TAIL_LINES="${2:-200}"
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

if [[ ! -f "$LOG_PATH" ]]; then
  fail "log file not found: $LOG_PATH" 2
fi

clrepo_print_kv session_id "$SESSION_ID"
clrepo_print_kv session_dir "$SESSION_DIR"
clrepo_print_kv log_path "$LOG_PATH"
clrepo_print_kv tail_lines "$TAIL_LINES"
echo "log_begin:"
tail -n "$TAIL_LINES" "$LOG_PATH"
echo "log_end"

TAIL_PREVIEW="$(tail -n "$TAIL_LINES" "$LOG_PATH" 2>/dev/null || true)"
TAIL_PREVIEW="$(clrepo_compact_text "$TAIL_PREVIEW" 500)"
RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-log\",\"status\":\"ok\",\"session_id\":%s,\"session_dir\":%s,\"log_path\":%s,\"tail_lines\":%s,\"tail_preview\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$SESSION_ID")" \
  "$(clrepo_json_string_or_null "$SESSION_DIR")" \
  "$(clrepo_json_string_or_null "$LOG_PATH")" \
  "$(clrepo_json_number_or_null "$TAIL_LINES")" \
  "$(clrepo_json_string_or_null "$TAIL_PREVIEW")")"
emit_result "$RESULT_JSON"
