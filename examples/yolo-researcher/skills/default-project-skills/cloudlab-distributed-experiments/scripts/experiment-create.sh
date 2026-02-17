#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="experiment-create"
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
usage: experiment-create.sh --name <name> --project <project> --profile-name <profile> --profile-project <project> [options]

Options:
  --duration <hours>
  --group <group>
  --start-at <iso8601>
  --stop-at <iso8601>
  --paramset-name <name>
  --paramset-owner <owner>
  --bindings-json '<json object>'
  --bindings-file <path>
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

NAME=""
PROJECT=""
PROFILE_NAME=""
PROFILE_PROJECT=""
DURATION=""
GROUP=""
START_AT=""
STOP_AT=""
PARAMSET_NAME=""
PARAMSET_OWNER=""
BINDINGS_JSON=""
BINDINGS_FILE=""

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
    --profile-name)
      PROFILE_NAME="${2:-}"
      shift 2
      ;;
    --profile-project)
      PROFILE_PROJECT="${2:-}"
      shift 2
      ;;
    --duration)
      DURATION="${2:-}"
      shift 2
      ;;
    --group)
      GROUP="${2:-}"
      shift 2
      ;;
    --start-at)
      START_AT="${2:-}"
      shift 2
      ;;
    --stop-at)
      STOP_AT="${2:-}"
      shift 2
      ;;
    --paramset-name)
      PARAMSET_NAME="${2:-}"
      shift 2
      ;;
    --paramset-owner)
      PARAMSET_OWNER="${2:-}"
      shift 2
      ;;
    --bindings-json)
      BINDINGS_JSON="${2:-}"
      shift 2
      ;;
    --bindings-file)
      BINDINGS_FILE="${2:-}"
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
[[ -n "$PROFILE_NAME" ]] || fail "--profile-name is required" 2
[[ -n "$PROFILE_PROJECT" ]] || fail "--profile-project is required" 2

if [[ -n "$DURATION" && ! "$DURATION" =~ ^[0-9]+$ ]]; then
  fail "--duration must be an integer number of hours" 2
fi

if [[ -n "$BINDINGS_JSON" && -n "$BINDINGS_FILE" ]]; then
  fail "use either --bindings-json or --bindings-file, not both" 2
fi

if [[ -n "$BINDINGS_FILE" ]]; then
  if [[ ! -f "$BINDINGS_FILE" ]]; then
    fail "bindings file does not exist: $BINDINGS_FILE" 2
  fi
  BINDINGS_JSON="$(cat "$BINDINGS_FILE")"
fi

if [[ -n "$BINDINGS_JSON" ]]; then
  if ! jq -e 'type == "object"' <<<"$BINDINGS_JSON" >/dev/null 2>&1; then
    fail "bindings must be a JSON object" 2
  fi
fi

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

BODY_FILE="$(mktemp)"
jq -n \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg profile_name "$PROFILE_NAME" \
  --arg profile_project "$PROFILE_PROJECT" \
  --arg duration "$DURATION" \
  --arg group "$GROUP" \
  --arg start_at "$START_AT" \
  --arg stop_at "$STOP_AT" \
  --arg paramset_name "$PARAMSET_NAME" \
  --arg paramset_owner "$PARAMSET_OWNER" \
  --arg bindings_json "$BINDINGS_JSON" \
  '
  {
    name: $name,
    project: $project,
    profile_name: $profile_name,
    profile_project: $profile_project
  }
  + (if $duration != "" then {duration: ($duration|tonumber)} else {} end)
  + (if $group != "" then {group: $group} else {} end)
  + (if $start_at != "" then {start_at: $start_at} else {} end)
  + (if $stop_at != "" then {stop_at: $stop_at} else {} end)
  + (if $paramset_name != "" then {paramset_name: $paramset_name} else {} end)
  + (if $paramset_owner != "" then {paramset_owner: $paramset_owner} else {} end)
  + (if $bindings_json != "" then {bindings: ($bindings_json|fromjson)} else {} end)
  ' > "$BODY_FILE"

if ! clab_api_request POST "/experiments" "$BODY_FILE"; then
  fail "experiment create failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

EXPERIMENT_ID="$(jq -r '.id // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
EXPERIMENT_STATUS="$(jq -r '.status // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
EXPIRES_AT="$(jq -r '.expires_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

if [[ -z "$EXPERIMENT_ID" ]]; then
  fail "API response did not include experiment id" 3
fi

clab_print_kv experiment_id "$EXPERIMENT_ID"
clab_print_kv status "${EXPERIMENT_STATUS:-unknown}"
clab_print_kv expires_at "${EXPIRES_AT:-unknown}"

HAS_BINDINGS="false"
if [[ -n "$BINDINGS_JSON" ]]; then
  HAS_BINDINGS="true"
fi

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg experiment_id "$EXPERIMENT_ID" \
  --arg experiment_status "$EXPERIMENT_STATUS" \
  --arg expires_at "$EXPIRES_AT" \
  --arg name "$NAME" \
  --arg project "$PROJECT" \
  --arg profile_name "$PROFILE_NAME" \
  --arg profile_project "$PROFILE_PROJECT" \
  --arg duration "$DURATION" \
  --argjson has_bindings "$HAS_BINDINGS" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    experiment_id: $experiment_id,
    experiment_status: $experiment_status,
    expires_at: $expires_at,
    name: $name,
    project: $project,
    profile_name: $profile_name,
    profile_project: $profile_project,
    duration_hours: (if $duration == "" then null else ($duration|tonumber) end),
    has_bindings: $has_bindings
  }')"

emit_result "$RESULT_JSON"
