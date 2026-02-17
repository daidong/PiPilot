#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="agent-start"
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
usage: agent-start.sh --task "<task>" [options]

Options:
  --provider <auto|codex|claude>     Default: auto
  --cwd <path>                       Default: .
  --model <name>                     Optional model override.
  --timeout-sec <seconds>            Optional timeout passed to delegate script.
  --claude-tools <csv>               Default: Bash,Read,Edit,Write
  --session-id <id>                  Optional custom session id.
  -h, --help                         Show help.
EOF
}

TASK=""
PROVIDER="auto"
CWD="."
MODEL=""
TIMEOUT_SEC=""
CLAUDE_TOOLS="Bash,Read,Edit,Write"
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      TASK="${2:-}"
      shift 2
      ;;
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --cwd)
      CWD="${2:-}"
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
    --claude-tools)
      CLAUDE_TOOLS="${2:-}"
      shift 2
      ;;
    --session-id)
      SESSION_ID="${2:-}"
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

if [[ ! -d "$CWD" ]]; then
  fail "cwd does not exist: $CWD" 2
fi

# Fail fast for provider resolution so start returns actionable errors.
if ! clrepo_pick_provider "$PROVIDER" >/dev/null; then
  fail "provider resolution failed for --provider $PROVIDER" 2
fi

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="coding-agent-$(date +"%Y%m%d-%H%M%S")-$RANDOM"
fi

SESSION_ROOT="$CODING_LARGE_REPO_TMP_DIR/agent-sessions"
SESSION_DIR="$SESSION_ROOT/$SESSION_ID"
LOG_PATH="$SESSION_DIR/agent.log"
EXIT_PATH="$SESSION_DIR/exit_code"
PID_PATH="$SESSION_DIR/pid"
META_PATH="$SESSION_DIR/meta.env"
TASK_PATH="$SESSION_DIR/task.txt"
RUNNER_PATH="$SESSION_DIR/runner.sh"

if [[ -e "$SESSION_DIR" ]]; then
  fail "session already exists: $SESSION_ID" 2
fi

mkdir -p "$SESSION_DIR"
printf '%s\n' "$TASK" > "$TASK_PATH"

declare -a DELEGATE_CMD=(
  env
  CODING_LARGE_REPO_DELEGATE_SYNC_ONLY=1
  bash
  "$SCRIPT_DIR/delegate-coding-agent.sh"
  --task "$TASK"
  --provider "$PROVIDER"
  --cwd "$CWD"
  --claude-tools "$CLAUDE_TOOLS"
)

if [[ -n "$MODEL" ]]; then
  DELEGATE_CMD+=(--model "$MODEL")
fi
if [[ -n "$TIMEOUT_SEC" ]]; then
  DELEGATE_CMD+=(--timeout-sec "$TIMEOUT_SEC")
fi

DELEGATE_CMD_SHELL="$(clrepo_join_shell_words "${DELEGATE_CMD[@]}")"

cat > "$RUNNER_PATH" <<EOF
#!/usr/bin/env bash
set +e
status=1
finalize() {
  printf '%s\n' "\$status" > $(printf "%q" "$EXIT_PATH")
}
on_term() {
  status=143
  exit 143
}
trap finalize EXIT
trap on_term TERM INT HUP
$DELEGATE_CMD_SHELL > $(printf "%q" "$LOG_PATH") 2>&1
status=\$?
exit "\$status"
EOF

chmod +x "$RUNNER_PATH"

nohup bash "$RUNNER_PATH" >/dev/null 2>&1 &
PID="$!"
printf '%s\n' "$PID" > "$PID_PATH"

{
  echo "session_id=$SESSION_ID"
  echo "requested_provider=$PROVIDER"
  echo "cwd=$CWD"
  echo "log_path=$LOG_PATH"
  echo "exit_path=$EXIT_PATH"
  echo "pid_path=$PID_PATH"
  echo "task_path=$TASK_PATH"
  echo "runner_path=$RUNNER_PATH"
  echo "started_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
} > "$META_PATH"

clrepo_print_kv session_id "$SESSION_ID"
clrepo_print_kv state "running"
clrepo_print_kv pid "$PID"
clrepo_print_kv log_path "$LOG_PATH"
clrepo_print_kv session_dir "$SESSION_DIR"
NEXT_POLL_CMD="skill-script-run({\"skillId\":\"coding-large-repo\",\"script\":\"agent-poll\",\"args\":[\"--session-id\",\"$SESSION_ID\"]})"
NEXT_LOG_CMD="skill-script-run({\"skillId\":\"coding-large-repo\",\"script\":\"agent-log\",\"args\":[\"--session-id\",\"$SESSION_ID\",\"--tail-lines\",\"120\"]})"
echo "next_poll: $NEXT_POLL_CMD"
echo "next_log: $NEXT_LOG_CMD"

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"agent-start\",\"status\":\"running\",\"session_id\":%s,\"requested_provider\":%s,\"pid\":%s,\"cwd\":%s,\"log_path\":%s,\"session_dir\":%s,\"next_poll\":%s,\"next_log\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$SESSION_ID")" \
  "$(clrepo_json_string_or_null "$PROVIDER")" \
  "$(clrepo_json_number_or_null "$PID")" \
  "$(clrepo_json_string_or_null "$CWD")" \
  "$(clrepo_json_string_or_null "$LOG_PATH")" \
  "$(clrepo_json_string_or_null "$SESSION_DIR")" \
  "$(clrepo_json_string_or_null "$NEXT_POLL_CMD")" \
  "$(clrepo_json_string_or_null "$NEXT_LOG_CMD")")"
emit_result "$RESULT_JSON"
