#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="delegate-coding-agent"
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
usage: delegate-coding-agent.sh --task "<task>" [options]

Options:
  --provider <auto|codex|claude>     Default: auto (prefer codex, fallback claude)
  --cwd <path>                       Working directory for the coding agent. Default: .
  --model <name>                     Optional model override passed through to provider.
  --timeout-sec <seconds>            Optional timeout. Uses timeout/gtimeout if available.
  --async <auto|always|never>        Default: auto (long tasks auto-route to agent-start).
  --session-id <id>                  Optional session id when async routing to agent-start.
  --claude-tools <csv>               Default: Bash,Read,Edit,Write
  -h, --help                         Show help
EOF
}

TASK=""
PROVIDER="auto"
CWD="."
MODEL=""
TIMEOUT_SEC=""
ASYNC_MODE="${CODING_LARGE_REPO_DELEGATE_ASYNC_MODE:-auto}"
ASYNC_SESSION_ID=""
CLAUDE_TOOLS="Bash,Read,Edit,Write"

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
    --async)
      ASYNC_MODE="${2:-}"
      shift 2
      ;;
    --session-id)
      ASYNC_SESSION_ID="${2:-}"
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

if [[ ! -d "$CWD" ]]; then
  fail "cwd does not exist: $CWD" 2
fi

mkdir -p "$CODING_LARGE_REPO_LOG_DIR" "$CODING_LARGE_REPO_TMP_DIR"

case "$PROVIDER" in
  auto|codex|claude)
    ;;
  *)
    fail "invalid --provider: $PROVIDER (expected auto|codex|claude)" 2
    ;;
esac

case "$ASYNC_MODE" in
  auto|always|never)
    ;;
  *)
    fail "invalid --async: $ASYNC_MODE (expected auto|always|never)" 2
    ;;
esac

STAMP="$(date +"%Y%m%d-%H%M%S")-$RANDOM"
RUN_LOG_PATH="$CODING_LARGE_REPO_LOG_DIR/delegate-$STAMP.log"
LAST_MESSAGE_PATH="$CODING_LARGE_REPO_TMP_DIR/coding-agent-last-message-$STAMP.txt"
AUTO_ASYNC_TASK_CHARS="${CODING_LARGE_REPO_DELEGATE_AUTO_ASYNC_TASK_CHARS:-280}"
AUTO_ASYNC_TIMEOUT_SEC="${CODING_LARGE_REPO_DELEGATE_AUTO_ASYNC_TIMEOUT_SEC:-180}"
DELEGATE_SYNC_ONLY="${CODING_LARGE_REPO_DELEGATE_SYNC_ONLY:-0}"

print_log_tail() {
  local lines="${1:-40}"
  echo "[coding-large-repo] showing last $lines log lines from $RUN_LOG_PATH"
  if [[ -f "$RUN_LOG_PATH" ]]; then
    tail -n "$lines" "$RUN_LOG_PATH"
  fi
}

json_string_array() {
  local out="["
  local first=1
  local item=""
  for item in "$@"; do
    if [[ "$first" -eq 0 ]]; then
      out+=","
    fi
    out+="\"$(clrepo_json_escape "$item")\""
    first=0
  done
  out+="]"
  printf '%s' "$out"
}

should_route_async() {
  local reason_ref_name="$1"
  # shellcheck disable=SC2034
  local reason_value="none"

  case "$DELEGATE_SYNC_ONLY" in
    1|true|TRUE|yes|YES)
      reason_value="sync_only_env"
      ;;
    *)
      case "$ASYNC_MODE" in
        always)
          reason_value="async_mode_always"
          ;;
        never)
          reason_value="async_mode_never"
          ;;
        auto)
          if [[ "$TASK" == *$'\n'* ]]; then
            reason_value="task_contains_newlines"
          elif [[ "${#TASK}" -ge "$AUTO_ASYNC_TASK_CHARS" ]]; then
            reason_value="task_chars_${#TASK}_ge_${AUTO_ASYNC_TASK_CHARS}"
          elif [[ -n "$TIMEOUT_SEC" && "$TIMEOUT_SEC" =~ ^[0-9]+$ && "$TIMEOUT_SEC" -ge "$AUTO_ASYNC_TIMEOUT_SEC" ]]; then
            reason_value="timeout_${TIMEOUT_SEC}_ge_${AUTO_ASYNC_TIMEOUT_SEC}"
          else
            reason_value="auto_short_task"
          fi
          ;;
        *)
          reason_value="invalid_async_mode"
          ;;
      esac
      ;;
  esac

  printf -v "$reason_ref_name" '%s' "$reason_value"
  case "$reason_value" in
    async_mode_always|task_contains_newlines|task_chars_*|timeout_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

maybe_route_to_async_delegate() {
  local route_reason=""
  if ! should_route_async route_reason; then
    return 1
  fi

  declare -a START_CMD=(
    bash
    "$SCRIPT_DIR/agent-start.sh"
    --task "$TASK"
    --provider "$PROVIDER"
    --cwd "$CWD"
    --claude-tools "$CLAUDE_TOOLS"
  )
  if [[ -n "$MODEL" ]]; then
    START_CMD+=(--model "$MODEL")
  fi
  if [[ -n "$TIMEOUT_SEC" ]]; then
    START_CMD+=(--timeout-sec "$TIMEOUT_SEC")
  fi
  if [[ -n "$ASYNC_SESSION_ID" ]]; then
    START_CMD+=(--session-id "$ASYNC_SESSION_ID")
  fi

  clrepo_print_kv async_routed "true"
  clrepo_print_kv async_reason "$route_reason"
  clrepo_print_kv async_command "$(clrepo_join_shell_words "${START_CMD[@]}")"

  # Hand over control to agent-start so callers receive its machine-readable running session payload.
  exec "${START_CMD[@]}"
}

maybe_route_to_async_delegate || true

declare -a ATTEMPT_ORDER=()
if [[ "$PROVIDER" == "auto" ]]; then
  if clrepo_resolve_codex_bin >/dev/null 2>&1; then
    ATTEMPT_ORDER+=("codex")
  fi
  if clrepo_has_claude; then
    ATTEMPT_ORDER+=("claude")
  fi
  if [[ ${#ATTEMPT_ORDER[@]} -eq 0 ]]; then
    fail "provider resolution failed for --provider auto (no codex/claude executable found)" 2
  fi
elif [[ "$PROVIDER" == "codex" ]]; then
  if ! clrepo_resolve_codex_bin >/dev/null 2>&1; then
    fail "provider=codex requested but codex executable was not found" 2
  fi
  ATTEMPT_ORDER=("codex")
else
  if ! clrepo_has_claude; then
    fail "provider=claude requested but claude executable was not found" 2
  fi
  ATTEMPT_ORDER=("claude")
fi

: > "$RUN_LOG_PATH"
{
  echo "[coding-large-repo] requested_provider: $PROVIDER"
  echo "[coding-large-repo] async_mode: $ASYNC_MODE"
  echo "[coding-large-repo] cwd: $CWD"
  echo "[coding-large-repo] task_chars: ${#TASK}"
  echo "[coding-large-repo] provider_attempt_order: ${ATTEMPT_ORDER[*]}"
  echo "[coding-large-repo] command output is written to log_path (tail shown on failures)."
} >> "$RUN_LOG_PATH"

build_run_cmd_for_provider() {
  local provider_name="$1"
  RUN_CMD=()
  if [[ "$provider_name" == "codex" ]]; then
    local codex_bin=""
    if ! codex_bin="$(clrepo_resolve_codex_bin)"; then
      return 2
    fi
    RUN_CMD=(
      env
      -u OPENAI_API_KEY
      -u OPENAI_BASE_URL
      -u OPENAI_ORG_ID
      "$codex_bin"
      --dangerously-bypass-approvals-and-sandbox
      exec
      --skip-git-repo-check
      --color never
      -C "$CWD"
      -o "$LAST_MESSAGE_PATH"
    )
    if [[ -n "$MODEL" ]]; then
      RUN_CMD+=(-m "$MODEL")
    fi
    RUN_CMD+=("$TASK")
    return 0
  fi

  if [[ "$provider_name" == "claude" ]]; then
    local abs_cwd=""
    abs_cwd="$(cd "$CWD" && pwd)"
    RUN_CMD=(
      claude
      -p "$TASK"
      --output-format text
      --tools "$CLAUDE_TOOLS"
      --dangerously-skip-permissions
      --permission-mode bypassPermissions
      --add-dir "$abs_cwd"
    )
    if [[ -n "$MODEL" ]]; then
      RUN_CMD+=(--model "$MODEL")
    fi
    return 0
  fi

  return 2
}

declare -a RUN_CMD=()
declare -a EXEC_CMD=()
declare -a ATTEMPTED_PROVIDERS=()
STATUS=2
FINAL_PROVIDER=""
FALLBACK_USED="false"
FALLBACK_REASON=""
ATTEMPT_COUNT=0
TOTAL_ATTEMPTS="${#ATTEMPT_ORDER[@]}"

for ATTEMPT_PROVIDER in "${ATTEMPT_ORDER[@]}"; do
  ATTEMPT_COUNT=$((ATTEMPT_COUNT + 1))
  FINAL_PROVIDER="$ATTEMPT_PROVIDER"
  ATTEMPTED_PROVIDERS+=("$ATTEMPT_PROVIDER")

  if ! build_run_cmd_for_provider "$ATTEMPT_PROVIDER"; then
    STATUS=2
    echo "[coding-large-repo] provider=$ATTEMPT_PROVIDER command build failed" | tee -a "$RUN_LOG_PATH"
  else
    EXEC_CMD=("${RUN_CMD[@]}")
    if [[ -n "$TIMEOUT_SEC" ]]; then
      if TIMEOUT_BIN="$(clrepo_pick_timeout_runner)"; then
        EXEC_CMD=("$TIMEOUT_BIN" "$TIMEOUT_SEC" "${RUN_CMD[@]}")
      else
        echo "warning: timeout requested but timeout/gtimeout not found; running without timeout" | tee -a "$RUN_LOG_PATH"
      fi
    fi

    clrepo_print_kv provider "$ATTEMPT_PROVIDER"
    clrepo_print_kv cwd "$CWD"
    clrepo_print_kv task_chars "${#TASK}"
    clrepo_print_kv command "$(clrepo_join_shell_words "${EXEC_CMD[@]}")"

    {
      echo "[coding-large-repo] attempt: $ATTEMPT_COUNT/$TOTAL_ATTEMPTS provider=$ATTEMPT_PROVIDER"
      echo "[coding-large-repo] command: $(clrepo_join_shell_words "${EXEC_CMD[@]}")"
    } >> "$RUN_LOG_PATH"

    if "${EXEC_CMD[@]}" >>"$RUN_LOG_PATH" 2>&1; then
      STATUS=0
    else
      STATUS=$?
    fi
  fi

  clrepo_print_kv exit_code "$STATUS"
  clrepo_print_kv log_path "$RUN_LOG_PATH"
  if [[ "$ATTEMPT_PROVIDER" == "codex" && -f "$LAST_MESSAGE_PATH" ]]; then
    clrepo_print_kv last_message_path "$LAST_MESSAGE_PATH"
  fi

  if [[ "$STATUS" -eq 0 ]]; then
    break
  fi

  print_log_tail 40

  if [[ "$PROVIDER" == "auto" && "$ATTEMPT_COUNT" -lt "$TOTAL_ATTEMPTS" ]]; then
    FALLBACK_USED="true"
    FALLBACK_REASON="provider=$ATTEMPT_PROVIDER exited_with=$STATUS"
    echo "[coding-large-repo] fallback_to_next_provider: $FALLBACK_REASON" | tee -a "$RUN_LOG_PATH"
    continue
  fi

  break
done

STATUS_LABEL="failed"
if [[ "$STATUS" == "0" ]]; then
  STATUS_LABEL="completed"
fi

LAST_MESSAGE=""
EMITTED_LAST_MESSAGE_PATH=""
ATTEMPTED_JSON="$(json_string_array "${ATTEMPTED_PROVIDERS[@]}")"
if [[ -f "$LAST_MESSAGE_PATH" ]]; then
  EMITTED_LAST_MESSAGE_PATH="$LAST_MESSAGE_PATH"
  LAST_MESSAGE="$(cat "$LAST_MESSAGE_PATH" 2>/dev/null || true)"
  LAST_MESSAGE="$(clrepo_compact_text "$LAST_MESSAGE" 500)"
fi

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"delegate-coding-agent\",\"provider\":%s,\"requested_provider\":%s,\"attempted_providers\":%s,\"attempt_count\":%s,\"fallback_used\":%s,\"fallback_reason\":%s,\"status\":%s,\"exit_code\":%s,\"cwd\":%s,\"task_chars\":%s,\"log_path\":%s,\"last_message_path\":%s,\"last_message\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$FINAL_PROVIDER")" \
  "$(clrepo_json_string_or_null "$PROVIDER")" \
  "$ATTEMPTED_JSON" \
  "$(clrepo_json_number_or_null "$ATTEMPT_COUNT")" \
  "$(clrepo_json_boolean_or_null "$FALLBACK_USED")" \
  "$(clrepo_json_string_or_null "$FALLBACK_REASON")" \
  "$(clrepo_json_string_or_null "$STATUS_LABEL")" \
  "$(clrepo_json_number_or_null "$STATUS")" \
  "$(clrepo_json_string_or_null "$CWD")" \
  "$(clrepo_json_number_or_null "${#TASK}")" \
  "$(clrepo_json_string_or_null "$RUN_LOG_PATH")" \
  "$(clrepo_json_string_or_null "$EMITTED_LAST_MESSAGE_PATH")" \
  "$(clrepo_json_string_or_null "$LAST_MESSAGE")")"
emit_result "$RESULT_JSON"

exit "$STATUS"
