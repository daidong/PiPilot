#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="experiment-wait-ready"
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
usage: experiment-wait-ready.sh --experiment-id <id> [options]

Options:
  --timeout-sec <seconds>   default: 2400
  --poll-sec <seconds>      default: 20
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

EXPERIMENT_ID=""
TIMEOUT_SEC=2400
POLL_SEC=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --experiment-id)
      EXPERIMENT_ID="${2:-}"
      shift 2
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

START_TS="$(date +%s)"
POLLS=0
LAST_STATUS=""
READY_NODES=0
TOTAL_NODES=0

while true; do
  if ! clab_api_request GET "/experiments/${EXPERIMENT_ID}" "" "true"; then
    if [[ "$CLAB_LAST_HTTP_CODE" == "404" ]]; then
      fail "experiment not found: $EXPERIMENT_ID" 3
    fi
    fail "status query failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
  fi

  POLLS=$((POLLS + 1))
  LAST_STATUS="$(jq -r '.status // "unknown"' "$CLAB_LAST_BODY_FILE" 2>/dev/null || echo "unknown")"
  TOTAL_NODES="$(jq -r '[.aggregates // {} | to_entries[]? | .value.nodes[]?] | length' "$CLAB_LAST_BODY_FILE" 2>/dev/null || echo 0)"
  READY_NODES="$(jq -r '[.aggregates // {} | to_entries[]? | .value.nodes[]? | select((.status // "") == "ready")] | length' "$CLAB_LAST_BODY_FILE" 2>/dev/null || echo 0)"

  ELAPSED=$(( $(date +%s) - START_TS ))
  clab_print_kv poll "$POLLS"
  clab_print_kv elapsed_sec "$ELAPSED"
  clab_print_kv status "$LAST_STATUS"
  clab_print_kv ready_nodes "$READY_NODES/$TOTAL_NODES"

  if [[ "$LAST_STATUS" == "ready" ]]; then
    RESULT_JSON="$(jq -cn \
      --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
      --arg script "$SCRIPT_NAME" \
      --arg experiment_id "$EXPERIMENT_ID" \
      --arg status "$LAST_STATUS" \
      --arg polls "$POLLS" \
      --arg elapsed "$ELAPSED" \
      --arg ready_nodes "$READY_NODES" \
      --arg total_nodes "$TOTAL_NODES" \
      '{
        schema: $schema,
        script: $script,
        status: "completed",
        exit_code: 0,
        experiment_id: $experiment_id,
        experiment_status: $status,
        polls: ($polls|tonumber),
        elapsed_sec: ($elapsed|tonumber),
        ready_nodes: ($ready_nodes|tonumber),
        total_nodes: ($total_nodes|tonumber)
      }')"
    emit_result "$RESULT_JSON"
    exit 0
  fi

  if [[ "$LAST_STATUS" == "failed" || "$LAST_STATUS" == "error" || "$LAST_STATUS" == "terminated" ]]; then
    fail "experiment reached non-ready terminal state: $LAST_STATUS" 4
  fi

  if (( ELAPSED >= TIMEOUT_SEC )); then
    fail "timeout waiting for ready state (last_status=$LAST_STATUS elapsed=${ELAPSED}s)" 5
  fi

  sleep "$POLL_SEC"
done
