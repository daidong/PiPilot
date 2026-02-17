#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="resgroup-get"
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
usage: resgroup-get.sh --resgroup-id <id> [options]

Options:
  --elaborate                    set X-Api-Elaborate=true
  --out <path>                   optional response JSON output path
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

RESGROUP_ID=""
ELABORATE="false"
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resgroup-id)
      RESGROUP_ID="${2:-}"
      shift 2
      ;;
    --elaborate)
      ELABORATE="true"
      shift
      ;;
    --out)
      OUT_PATH="${2:-}"
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

[[ -n "$RESGROUP_ID" ]] || fail "--resgroup-id is required" 2

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

if ! clab_api_request GET "/resgroups/${RESGROUP_ID}" "" "$ELABORATE"; then
  fail "resgroup get failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

if [[ -z "$OUT_PATH" ]]; then
  OUT_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/resgroup-get-$(clab_sanitize_name "$RESGROUP_ID").json"
fi
mkdir -p "$(dirname "$OUT_PATH")"
cp "$CLAB_LAST_BODY_FILE" "$OUT_PATH"

PROJECT="$(jq -r '.project // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
START_AT="$(jq -r '.start_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
EXPIRES_AT="$(jq -r '.expires_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

clab_print_kv resgroup_id "$RESGROUP_ID"
clab_print_kv project "${PROJECT:-unknown}"
clab_print_kv start_at "${START_AT:-unknown}"
clab_print_kv expires_at "${EXPIRES_AT:-unknown}"
clab_print_kv out "$OUT_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg resgroup_id "$RESGROUP_ID" \
  --arg project "$PROJECT" \
  --arg start_at "$START_AT" \
  --arg expires_at "$EXPIRES_AT" \
  --arg out "$OUT_PATH" \
  --argjson elaborate "$ELABORATE" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    resgroup_id: $resgroup_id,
    project: (if $project == "" then null else $project end),
    start_at: (if $start_at == "" then null else $start_at end),
    expires_at: (if $expires_at == "" then null else $expires_at end),
    elaborate: $elaborate,
    out: $out
  }')"

emit_result "$RESULT_JSON"
