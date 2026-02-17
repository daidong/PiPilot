#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="profile-update"
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
usage: profile-update.sh --profile-id <id> [options]

Options:
  --refresh-repo                 trigger PUT /profiles/{id} for repo-backed profile
  --script-file <path>           PATCH body script field
  --script-text '<text>'         PATCH body script field
  --public <true|false>          PATCH body public field
  --project-writable <true|false> PATCH body project_writable field
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

PROFILE_ID=""
REFRESH_REPO="false"
SCRIPT_FILE=""
SCRIPT_TEXT=""
PUBLIC_VALUE=""
PROJECT_WRITABLE_VALUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile-id)
      PROFILE_ID="${2:-}"
      shift 2
      ;;
    --refresh-repo)
      REFRESH_REPO="true"
      shift
      ;;
    --script-file)
      SCRIPT_FILE="${2:-}"
      shift 2
      ;;
    --script-text)
      SCRIPT_TEXT="${2:-}"
      shift 2
      ;;
    --public)
      PUBLIC_VALUE="${2:-}"
      shift 2
      ;;
    --project-writable)
      PROJECT_WRITABLE_VALUE="${2:-}"
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

if [[ -n "$SCRIPT_FILE" && -n "$SCRIPT_TEXT" ]]; then
  fail "use either --script-file or --script-text" 2
fi
if [[ -n "$SCRIPT_FILE" ]]; then
  [[ -f "$SCRIPT_FILE" ]] || fail "script file not found: $SCRIPT_FILE" 2
  SCRIPT_TEXT="$(cat "$SCRIPT_FILE")"
fi

normalize_bool_json() {
  local input_value="$1"
  if [[ -z "$input_value" ]]; then
    printf 'null'
    return 0
  fi
  case "$input_value" in
    true|TRUE|1)
      printf 'true'
      ;;
    false|FALSE|0)
      printf 'false'
      ;;
    *)
      fail "boolean flag values must be true/false (got: $input_value)" 2
      ;;
  esac
}

PUBLIC_JSON="$(normalize_bool_json "$PUBLIC_VALUE")"
PROJECT_WRITABLE_JSON="$(normalize_bool_json "$PROJECT_WRITABLE_VALUE")"

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

ACTION="refresh"
if [[ "$REFRESH_REPO" == "true" ]]; then
  if [[ -n "$SCRIPT_TEXT" || "$PUBLIC_JSON" != "null" || "$PROJECT_WRITABLE_JSON" != "null" ]]; then
    fail "--refresh-repo cannot be combined with PATCH fields" 2
  fi
  if ! clab_api_request PUT "/profiles/${PROFILE_ID}"; then
    fail "profile refresh failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
  fi
else
  ACTION="modify"
  if [[ -z "$SCRIPT_TEXT" && "$PUBLIC_JSON" == "null" && "$PROJECT_WRITABLE_JSON" == "null" ]]; then
    fail "for modify mode provide at least one of --script-file/--script-text/--public/--project-writable" 2
  fi

  BODY_FILE="$(mktemp)"
  jq -n \
    --arg script "$SCRIPT_TEXT" \
    --argjson public_json "$PUBLIC_JSON" \
    --argjson project_writable_json "$PROJECT_WRITABLE_JSON" \
    '
    {}
    + (if $script != "" then {script: $script} else {} end)
    + (if $public_json == null then {} else {public: $public_json} end)
    + (if $project_writable_json == null then {} else {project_writable: $project_writable_json} end)
    ' > "$BODY_FILE"

  if ! clab_api_request PATCH "/profiles/${PROFILE_ID}" "$BODY_FILE"; then
    fail "profile modify failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
  fi
fi

NAME="$(jq -r '.name // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
PROJECT="$(jq -r '.project // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
VERSION="$(jq -r '.version // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
REPO_HASH="$(jq -r '.repository_hash // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

RESPONSE_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/profile-update-$(clab_sanitize_name "$PROFILE_ID")-$(date +%Y%m%d-%H%M%S).json"
cp "$CLAB_LAST_BODY_FILE" "$RESPONSE_PATH"

clab_print_kv profile_id "$PROFILE_ID"
clab_print_kv action "$ACTION"
clab_print_kv version "${VERSION:-unknown}"
clab_print_kv response_path "$RESPONSE_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg profile_id "$PROFILE_ID" \
  --arg action "$ACTION" \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg version "$VERSION" \
  --arg repository_hash "$REPO_HASH" \
  --arg response_path "$RESPONSE_PATH" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    profile_id: $profile_id,
    action: $action,
    name: (if $name == "" then null else $name end),
    project: (if $project == "" then null else $project end),
    version: (if $version == "" then null else ($version|tonumber) end),
    repository_hash: (if $repository_hash == "" then null else $repository_hash end),
    response_path: $response_path
  }')"

emit_result "$RESULT_JSON"
