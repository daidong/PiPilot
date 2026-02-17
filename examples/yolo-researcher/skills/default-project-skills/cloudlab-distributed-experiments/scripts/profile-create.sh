#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="profile-create"
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
usage: profile-create.sh --name <name> --project <project> [options]

Options:
  --script-file <path>
  --script-text '<python script>'
  --repository-url <url>
  --public <true|false>
  --project-writable <true|false>
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

NAME=""
PROJECT=""
SCRIPT_FILE=""
SCRIPT_TEXT=""
REPOSITORY_URL=""
PUBLIC_VALUE=""
PROJECT_WRITABLE_VALUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --script-file)
      SCRIPT_FILE="${2:-}"
      shift 2
      ;;
    --script-text)
      SCRIPT_TEXT="${2:-}"
      shift 2
      ;;
    --repository-url)
      REPOSITORY_URL="${2:-}"
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

[[ -n "$NAME" ]] || fail "--name is required" 2
[[ -n "$PROJECT" ]] || fail "--project is required" 2

if [[ -n "$SCRIPT_FILE" && -n "$SCRIPT_TEXT" ]]; then
  fail "use either --script-file or --script-text" 2
fi

if [[ -n "$SCRIPT_FILE" ]]; then
  [[ -f "$SCRIPT_FILE" ]] || fail "script file not found: $SCRIPT_FILE" 2
  SCRIPT_TEXT="$(cat "$SCRIPT_FILE")"
fi

if [[ -z "$SCRIPT_TEXT" && -z "$REPOSITORY_URL" ]]; then
  fail "provide --script-file/--script-text or --repository-url" 2
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

BODY_FILE="$(mktemp)"
jq -n \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg script "$SCRIPT_TEXT" \
  --arg repository_url "$REPOSITORY_URL" \
  --argjson public_json "$PUBLIC_JSON" \
  --argjson project_writable_json "$PROJECT_WRITABLE_JSON" \
  '
  {
    name: $name,
    project: $project
  }
  + (if $script != "" then {script: $script} else {} end)
  + (if $repository_url != "" then {repository_url: $repository_url} else {} end)
  + (if $public_json == null then {} else {public: $public_json} end)
  + (if $project_writable_json == null then {} else {project_writable: $project_writable_json} end)
  ' > "$BODY_FILE"

if ! clab_api_request POST "/profiles" "$BODY_FILE"; then
  fail "profile create failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

PROFILE_ID="$(jq -r '.id // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
VERSION="$(jq -r '.version // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
REPO_HASH="$(jq -r '.repository_hash // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

[[ -n "$PROFILE_ID" ]] || fail "API response missing profile id" 3

RESPONSE_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/profile-create-$(clab_sanitize_name "$PROFILE_ID").json"
cp "$CLAB_LAST_BODY_FILE" "$RESPONSE_PATH"

clab_print_kv profile_id "$PROFILE_ID"
clab_print_kv version "${VERSION:-unknown}"
clab_print_kv response_path "$RESPONSE_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg profile_id "$PROFILE_ID" \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg version "$VERSION" \
  --arg repository_url "$REPOSITORY_URL" \
  --arg repository_hash "$REPO_HASH" \
  --arg response_path "$RESPONSE_PATH" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    profile_id: $profile_id,
    name: $name,
    project: $project,
    version: (if $version == "" then null else ($version|tonumber) end),
    repository_url: (if $repository_url == "" then null else $repository_url end),
    repository_hash: (if $repository_hash == "" then null else $repository_hash end),
    response_path: $response_path
  }')"

emit_result "$RESULT_JSON"
