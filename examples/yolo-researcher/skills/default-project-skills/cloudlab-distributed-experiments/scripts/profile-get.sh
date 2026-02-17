#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="profile-get"
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
usage: profile-get.sh --profile-id <id> [options]

Options:
  --elaborate
  --out <path>
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

PROFILE_ID=""
ELABORATE="false"
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile-id)
      PROFILE_ID="${2:-}"
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

[[ -n "$PROFILE_ID" ]] || fail "--profile-id is required" 2

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

if ! clab_api_request GET "/profiles/${PROFILE_ID}" "" "$ELABORATE"; then
  fail "profile get failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

if [[ -z "$OUT_PATH" ]]; then
  OUT_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/profile-get-$(clab_sanitize_name "$PROFILE_ID").json"
fi
mkdir -p "$(dirname "$OUT_PATH")"
cp "$CLAB_LAST_BODY_FILE" "$OUT_PATH"

NAME="$(jq -r '.name // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
PROJECT="$(jq -r '.project // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
VERSION="$(jq -r '.version // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
REPOSITORY_URL="$(jq -r '.repository_url // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

clab_print_kv profile_id "$PROFILE_ID"
clab_print_kv name "${NAME:-unknown}"
clab_print_kv project "${PROJECT:-unknown}"
clab_print_kv version "${VERSION:-unknown}"
clab_print_kv out "$OUT_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg profile_id "$PROFILE_ID" \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg version "$VERSION" \
  --arg repository_url "$REPOSITORY_URL" \
  --arg out "$OUT_PATH" \
  --argjson elaborate "$ELABORATE" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    profile_id: $profile_id,
    name: (if $name == "" then null else $name end),
    project: (if $project == "" then null else $project end),
    version: (if $version == "" then null else ($version|tonumber) end),
    repository_url: (if $repository_url == "" then null else $repository_url end),
    elaborate: $elaborate,
    out: $out
  }')"

emit_result "$RESULT_JSON"
