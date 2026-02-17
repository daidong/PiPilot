#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="resgroup-create"
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
usage: resgroup-create.sh --project <project> --reason <text> [options]

Options:
  --group <group>
  --duration <hours>            optional query parameter
  --start-at <iso8601>
  --expires-at <iso8601>
  --nodetypes-json '<json>'
  --nodetypes-file <path>
  --ranges-json '<json>'
  --ranges-file <path>
  --routes-json '<json>'
  --routes-file <path>
  --noautoapprove               pass noautoapprove=true query
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

PROJECT=""
REASON=""
GROUP=""
DURATION=""
START_AT=""
EXPIRES_AT=""
NODETYPES_JSON=""
NODETYPES_FILE=""
RANGES_JSON=""
RANGES_FILE=""
ROUTES_JSON=""
ROUTES_FILE=""
NOAUTOAPPROVE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    --group)
      GROUP="${2:-}"
      shift 2
      ;;
    --duration)
      DURATION="${2:-}"
      shift 2
      ;;
    --start-at)
      START_AT="${2:-}"
      shift 2
      ;;
    --expires-at)
      EXPIRES_AT="${2:-}"
      shift 2
      ;;
    --nodetypes-json)
      NODETYPES_JSON="${2:-}"
      shift 2
      ;;
    --nodetypes-file)
      NODETYPES_FILE="${2:-}"
      shift 2
      ;;
    --ranges-json)
      RANGES_JSON="${2:-}"
      shift 2
      ;;
    --ranges-file)
      RANGES_FILE="${2:-}"
      shift 2
      ;;
    --routes-json)
      ROUTES_JSON="${2:-}"
      shift 2
      ;;
    --routes-file)
      ROUTES_FILE="${2:-}"
      shift 2
      ;;
    --noautoapprove)
      NOAUTOAPPROVE="true"
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
clab_require_bin jq || fail "jq is required" 2

[[ -n "$PROJECT" ]] || fail "--project is required" 2
[[ -n "$REASON" ]] || fail "--reason is required" 2

if [[ -n "$DURATION" && ! "$DURATION" =~ ^[0-9]+$ ]]; then
  fail "--duration must be integer hours" 2
fi

if [[ -n "$NODETYPES_JSON" && -n "$NODETYPES_FILE" ]]; then
  fail "use either --nodetypes-json or --nodetypes-file" 2
fi
if [[ -n "$RANGES_JSON" && -n "$RANGES_FILE" ]]; then
  fail "use either --ranges-json or --ranges-file" 2
fi
if [[ -n "$ROUTES_JSON" && -n "$ROUTES_FILE" ]]; then
  fail "use either --routes-json or --routes-file" 2
fi

if [[ -n "$NODETYPES_FILE" ]]; then
  [[ -f "$NODETYPES_FILE" ]] || fail "nodetypes file not found: $NODETYPES_FILE" 2
  NODETYPES_JSON="$(cat "$NODETYPES_FILE")"
fi
if [[ -n "$RANGES_FILE" ]]; then
  [[ -f "$RANGES_FILE" ]] || fail "ranges file not found: $RANGES_FILE" 2
  RANGES_JSON="$(cat "$RANGES_FILE")"
fi
if [[ -n "$ROUTES_FILE" ]]; then
  [[ -f "$ROUTES_FILE" ]] || fail "routes file not found: $ROUTES_FILE" 2
  ROUTES_JSON="$(cat "$ROUTES_FILE")"
fi

for pair in "NODETYPES_JSON:$NODETYPES_JSON" "RANGES_JSON:$RANGES_JSON" "ROUTES_JSON:$ROUTES_JSON"; do
  key="${pair%%:*}"
  val="${pair#*:}"
  if [[ -n "$val" ]]; then
    if ! jq -e 'type == "object"' <<<"$val" >/dev/null 2>&1; then
      fail "$key must be a JSON object" 2
    fi
  fi
done

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

BODY_FILE="$(mktemp)"
jq -n \
  --arg project "$PROJECT" \
  --arg reason "$REASON" \
  --arg group "$GROUP" \
  --arg start_at "$START_AT" \
  --arg expires_at "$EXPIRES_AT" \
  --arg nodetypes_json "$NODETYPES_JSON" \
  --arg ranges_json "$RANGES_JSON" \
  --arg routes_json "$ROUTES_JSON" \
  '
  {
    project: $project,
    reason: $reason
  }
  + (if $group != "" then {group: $group} else {} end)
  + (if $start_at != "" then {start_at: $start_at} else {} end)
  + (if $expires_at != "" then {expires_at: $expires_at} else {} end)
  + (if $nodetypes_json != "" then {nodetypes: ($nodetypes_json|fromjson)} else {} end)
  + (if $ranges_json != "" then {ranges: ($ranges_json|fromjson)} else {} end)
  + (if $routes_json != "" then {routes: ($routes_json|fromjson)} else {} end)
  ' > "$BODY_FILE"

QUERY=""
if [[ -n "$DURATION" ]]; then
  QUERY="duration=${DURATION}"
fi
if [[ "$NOAUTOAPPROVE" == "true" ]]; then
  if [[ -n "$QUERY" ]]; then
    QUERY="${QUERY}&"
  fi
  QUERY="${QUERY}noautoapprove=true"
fi

API_PATH="/resgroups"
if [[ -n "$QUERY" ]]; then
  API_PATH="/resgroups?${QUERY}"
fi

if ! clab_api_request POST "$API_PATH" "$BODY_FILE"; then
  fail "resgroup create failed: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

RESGROUP_ID="$(jq -r '.id // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
START_OUT="$(jq -r '.start_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
EXPIRES_OUT="$(jq -r '.expires_at // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"

[[ -n "$RESGROUP_ID" ]] || fail "API response missing reservation group id" 3

RESPONSE_PATH="$CLOUDLAB_DISTRIBUTED_TMP_DIR/resgroup-create-$(clab_sanitize_name "$RESGROUP_ID").json"
cp "$CLAB_LAST_BODY_FILE" "$RESPONSE_PATH"

clab_print_kv resgroup_id "$RESGROUP_ID"
clab_print_kv start_at "${START_OUT:-unknown}"
clab_print_kv expires_at "${EXPIRES_OUT:-unknown}"
clab_print_kv response_path "$RESPONSE_PATH"

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg project "$PROJECT" \
  --arg reason "$REASON" \
  --arg resgroup_id "$RESGROUP_ID" \
  --arg start_at "$START_OUT" \
  --arg expires_at "$EXPIRES_OUT" \
  --arg duration "$DURATION" \
  --argjson noautoapprove "$NOAUTOAPPROVE" \
  --arg response_path "$RESPONSE_PATH" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    project: $project,
    reason: $reason,
    resgroup_id: $resgroup_id,
    start_at: (if $start_at == "" then null else $start_at end),
    expires_at: (if $expires_at == "" then null else $expires_at end),
    duration_hours: (if $duration == "" then null else ($duration|tonumber) end),
    noautoapprove: $noautoapprove,
    response_path: $response_path
  }')"

emit_result "$RESULT_JSON"
