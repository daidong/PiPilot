#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="experiment-extend"
RESULT_EMITTED=0

emit_result() {
  RESULT_EMITTED=1
  clab_emit_result_json "$1"
}

emit_failure_result() {
  local message="${1:-script_failed}"
  local exit_code="${2:-2}"
  RESULT_EMITTED=1
  clab_emit_error_result_json "$SCRIPT_NAME" "$exit_code" "$message" "error"
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
  cat <<'HELP'
usage: experiment-extend.sh --experiment-id <id> [--extend-by <hours> | --expires-at <iso8601>] [options]

Options:
  --reason <text>
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

EXPERIMENT_ID=""
EXTEND_BY=""
EXPIRES_AT=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --experiment-id)
      EXPERIMENT_ID="${2:-}"
      shift 2
      ;;
    --extend-by)
      EXTEND_BY="${2:-}"
      shift 2
      ;;
    --expires-at)
      EXPIRES_AT="${2:-}"
      shift 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    --portal-url)
      PORTAL_HTTP="${2:-}"
      shift 2
      ;;
    --token)
      PORTAL_TOKEN="${2:-}"
      shift 2
      ;;
    --token-file)
      PORTAL_TOKEN_FILE="${2:-}"
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

clab_require_bin curl || fail "curl is required" 2
clab_require_bin jq || fail "jq is required" 2

[[ -n "$EXPERIMENT_ID" ]] || fail "--experiment-id is required" 2
if [[ -n "$EXTEND_BY" && ! "$EXTEND_BY" =~ ^[0-9]+$ ]]; then
  fail "--extend-by must be integer hours" 2
fi
if [[ -n "$EXTEND_BY" && -n "$EXPIRES_AT" ]]; then
  fail "use either --extend-by or --expires-at" 2
fi
if [[ -z "$EXTEND_BY" && -z "$EXPIRES_AT" ]]; then
  fail "provide --extend-by or --expires-at" 2
fi

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

BODY_FILE="$(mktemp)"
jq -n \
  --arg extend_by "$EXTEND_BY" \
  --arg expires_at "$EXPIRES_AT" \
  --arg reason "$REASON" \
  '
  {}
  + (if $extend_by != "" then {extend_by: ($extend_by|tonumber)} else {} end)
  + (if $expires_at != "" then {expires_at: $expires_at} else {} end)
  + (if $reason != "" then {reason: $reason} else {} end)
  ' > "$BODY_FILE"

if ! clab_api_request PUT "/experiments/${EXPERIMENT_ID}" "$BODY_FILE"; then
  fail "experiment extend failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

STATUS="$(jq -r '.status // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
NEW_EXPIRES_AT="$(jq -r '.expires_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

RESPONSE_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/experiment-extend-$(clab_sanitize_name "$EXPERIMENT_ID")-$(date +%Y%m%d-%H%M%S).json"
cp "$CLAB_LAST_BODY_FILE" "$RESPONSE_PATH"

clab_print_kv experiment_id "$EXPERIMENT_ID"
clab_print_kv status "${STATUS:-unknown}"
clab_print_kv new_expires_at "${NEW_EXPIRES_AT:-unknown}"
clab_print_kv response_path "$RESPONSE_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg experiment_id "$EXPERIMENT_ID" \
  --arg status "$STATUS" \
  --arg new_expires_at "$NEW_EXPIRES_AT" \
  --arg extend_by "$EXTEND_BY" \
  --arg expires_at "$EXPIRES_AT" \
  --arg reason "$REASON" \
  --arg response_path "$RESPONSE_PATH" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    experiment_id: $experiment_id,
    experiment_status: (if $status == "" then null else $status end),
    new_expires_at: (if $new_expires_at == "" then null else $new_expires_at end),
    extend_by_hours: (if $extend_by == "" then null else ($extend_by|tonumber) end),
    requested_expires_at: (if $expires_at == "" then null else $expires_at end),
    reason: (if $reason == "" then null else $reason end),
    response_path: $response_path
  }')"

emit_result "$RESULT_JSON"
