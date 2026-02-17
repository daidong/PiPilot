#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="portal-intake"
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

while [[ $# -gt 0 ]]; do
  case "$1" in
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
      cat <<'HELP'
usage: portal-intake.sh [--portal-url <url>] [--token <token>] [--token-file <file>]

Checks CloudLab Portal API reachability and token validity.
HELP
      exit 0
      ;;
    *)
      fail "unknown argument: $1" 2
      ;;
  esac
done

clab_require_bin curl || fail "curl is required" 2
clab_require_bin jq || fail "jq is required" 2

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

PORTAL_URL="$(clab_require_portal_url)" || fail "missing PORTAL_HTTP" 2
TOKEN_VALUE="$(clab_require_portal_token)" || fail "missing portal token" 2
unset TOKEN_VALUE

VERSION_HTTP_CODE=""
TOKEN_HTTP_CODE=""
VERSION_TEXT=""
TOKEN_OWNER=""
TOKEN_ID=""
TOKEN_EXPIRES_AT=""

if clab_api_request GET "/version"; then
  VERSION_HTTP_CODE="$CLAB_LAST_HTTP_CODE"
  VERSION_TEXT="$(jq -c '.' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
else
  fail "version check failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

if clab_api_request GET "/tokens/this"; then
  TOKEN_HTTP_CODE="$CLAB_LAST_HTTP_CODE"
  TOKEN_OWNER="$(jq -r '.owner // .user // .name // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
  TOKEN_ID="$(jq -r '.id // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
  TOKEN_EXPIRES_AT="$(jq -r '.expires_at // .expires // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
else
  fail "token check failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

PORTAL_CLI_AVAILABLE="false"
if command -v portal-cli >/dev/null 2>&1; then
  PORTAL_CLI_AVAILABLE="true"
fi

SSH_AVAILABLE="false"
SCP_AVAILABLE="false"
if command -v ssh >/dev/null 2>&1; then
  SSH_AVAILABLE="true"
fi
if command -v scp >/dev/null 2>&1; then
  SCP_AVAILABLE="true"
fi

clab_print_kv portal_url "$PORTAL_URL"
clab_print_kv version_http_code "$VERSION_HTTP_CODE"
clab_print_kv token_http_code "$TOKEN_HTTP_CODE"
clab_print_kv token_owner "${TOKEN_OWNER:-unknown}"
clab_print_kv token_id "${TOKEN_ID:-unknown}"
clab_print_kv token_expires_at "${TOKEN_EXPIRES_AT:-unknown}"
clab_print_kv portal_cli_available "$PORTAL_CLI_AVAILABLE"
clab_print_kv ssh_available "$SSH_AVAILABLE"
clab_print_kv scp_available "$SCP_AVAILABLE"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg portal_url "$PORTAL_URL" \
  --arg version_http_code "$VERSION_HTTP_CODE" \
  --arg token_http_code "$TOKEN_HTTP_CODE" \
  --arg token_owner "$TOKEN_OWNER" \
  --arg token_id "$TOKEN_ID" \
  --arg token_expires_at "$TOKEN_EXPIRES_AT" \
  --arg version_text "$(clab_compact_text "$VERSION_TEXT" 500)" \
  --argjson portal_cli_available "$PORTAL_CLI_AVAILABLE" \
  --argjson ssh_available "$SSH_AVAILABLE" \
  --argjson scp_available "$SCP_AVAILABLE" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    portal_url: $portal_url,
    version_http_code: ($version_http_code|tonumber),
    token_http_code: ($token_http_code|tonumber),
    token_owner: $token_owner,
    token_id: $token_id,
    token_expires_at: $token_expires_at,
    version_text: $version_text,
    portal_cli_available: $portal_cli_available,
    ssh_available: $ssh_available,
    scp_available: $scp_available
  }')"

emit_result "$RESULT_JSON"
