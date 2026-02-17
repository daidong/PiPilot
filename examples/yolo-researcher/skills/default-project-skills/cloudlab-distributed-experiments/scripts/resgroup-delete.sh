#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="resgroup-delete"
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
  local exit_code="$2"
  echo "error: $message" >&2
  emit_failure_result "$message" "$exit_code"
  exit "$exit_code"
}

trap 'status=$?; if [[ "$status" -ne 0 && "$RESULT_EMITTED" -eq 0 ]]; then emit_failure_result "unexpected_failure" "$status"; fi' EXIT

usage() {
  cat <<'HELP'
usage: resgroup-delete.sh --resgroup-id <id> [options]

Options:
  --allow-missing               treat 404 as success
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

RESGROUP_ID=""
ALLOW_MISSING="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resgroup-id)
      RESGROUP_ID="${2:-}"
      shift 2
      ;;
    --allow-missing)
      ALLOW_MISSING="true"
      shift
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

[[ -n "$RESGROUP_ID" ]] || fail "--resgroup-id is required" 2

DELETE_STATE="deleted"
if ! clab_api_request DELETE "/resgroups/${RESGROUP_ID}"; then
  if [[ "$CLAB_LAST_HTTP_CODE" == "404" && "$ALLOW_MISSING" == "true" ]]; then
    DELETE_STATE="already_missing"
  else
    fail "resgroup delete failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
  fi
fi

clab_print_kv resgroup_id "$RESGROUP_ID"
clab_print_kv delete_state "$DELETE_STATE"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg resgroup_id "$RESGROUP_ID" \
  --arg delete_state "$DELETE_STATE" \
  --argjson allow_missing "$ALLOW_MISSING" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    resgroup_id: $resgroup_id,
    delete_state: $delete_state,
    allow_missing: $allow_missing
  }')"

emit_result "$RESULT_JSON"
