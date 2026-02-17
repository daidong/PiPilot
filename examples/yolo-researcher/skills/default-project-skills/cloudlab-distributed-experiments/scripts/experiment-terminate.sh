#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="experiment-terminate"
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
usage: experiment-terminate.sh --experiment-id <id> [options]

Options:
  --wait-gone                   wait until GET /experiments/{id} returns 404
  --timeout-sec <seconds>       default: 600
  --poll-sec <seconds>          default: 15
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

EXPERIMENT_ID=""
WAIT_GONE="false"
TIMEOUT_SEC=600
POLL_SEC=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --experiment-id)
      EXPERIMENT_ID="${2:-}"
      shift 2
      ;;
    --wait-gone)
      WAIT_GONE="true"
      shift
      ;;
    --timeout-sec)
      TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --poll-sec)
      POLL_SEC="${2:-}"
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
[[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || fail "--timeout-sec must be integer" 2
[[ "$POLL_SEC" =~ ^[0-9]+$ ]] || fail "--poll-sec must be integer" 2
if (( POLL_SEC <= 0 )); then
  fail "--poll-sec must be > 0" 2
fi

TERMINATE_STATE="terminate_requested"

if ! clab_api_request DELETE "/experiments/${EXPERIMENT_ID}"; then
  if [[ "$CLAB_LAST_HTTP_CODE" == "404" ]]; then
    TERMINATE_STATE="already_gone"
  else
    fail "terminate request failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
  fi
fi

if [[ "$WAIT_GONE" == "true" && "$TERMINATE_STATE" != "already_gone" ]]; then
  START_TS="$(date +%s)"
  while true; do
    if clab_api_request GET "/experiments/${EXPERIMENT_ID}"; then
      :
    else
      if [[ "$CLAB_LAST_HTTP_CODE" == "404" ]]; then
        TERMINATE_STATE="gone"
        break
      fi
      fail "status query failed while waiting for termination: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 4
    fi

    ELAPSED=$(( $(date +%s) - START_TS ))
    if (( ELAPSED >= TIMEOUT_SEC )); then
      fail "timeout waiting for experiment deletion" 5
    fi

    sleep "$POLL_SEC"
  done
fi

clab_print_kv experiment_id "$EXPERIMENT_ID"
clab_print_kv terminate_state "$TERMINATE_STATE"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg experiment_id "$EXPERIMENT_ID" \
  --arg terminate_state "$TERMINATE_STATE" \
  --argjson wait_gone "$WAIT_GONE" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    experiment_id: $experiment_id,
    terminate_state: $terminate_state,
    wait_gone: $wait_gone
  }')"

emit_result "$RESULT_JSON"
