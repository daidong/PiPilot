#!/usr/bin/env bash
set -euo pipefail

CLOUDLAB_DISTRIBUTED_TMP_DIR="${CLOUDLAB_DISTRIBUTED_TMP_DIR:-.yolo-researcher/tmp/cloudlab-distributed-experiments}"
CLOUDLAB_DISTRIBUTED_LOG_DIR="${CLOUDLAB_DISTRIBUTED_LOG_DIR:-.yolo-researcher/logs/cloudlab-distributed-experiments}"
CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA="cloudlab-distributed-experiments.result.v1"

CLAB_LAST_HTTP_CODE=""
CLAB_LAST_BODY_FILE=""

clab_print_kv() {
  local key="$1"
  local value="$2"
  echo "${key}: ${value}"
}

clab_json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

clab_json_string_or_null() {
  local value="${1-}"
  if [[ -z "$value" ]]; then
    printf 'null'
    return 0
  fi
  printf '"%s"' "$(clab_json_escape "$value")"
}

clab_json_number_or_null() {
  local value="${1-}"
  if [[ -z "$value" ]]; then
    printf 'null'
    return 0
  fi
  if [[ ! "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    printf 'null'
    return 0
  fi
  printf '%s' "$value"
}

clab_json_boolean_or_null() {
  local value="${1-}"
  case "$value" in
    true|TRUE|1)
      printf 'true'
      ;;
    false|FALSE|0)
      printf 'false'
      ;;
    *)
      printf 'null'
      ;;
  esac
}

clab_emit_result_json() {
  local payload="$1"
  echo "AF_RESULT_JSON: $payload"
}

clab_emit_error_result_json() {
  local script_name="$1"
  local exit_code="${2:-2}"
  local error_message="${3:-script_failed}"
  local status_label="${4:-error}"
  local payload
  payload="$(printf '{"schema":"%s","script":%s,"status":%s,"exit_code":%s,"error":%s}' \
    "$(clab_json_escape "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA")" \
    "$(clab_json_string_or_null "$script_name")" \
    "$(clab_json_string_or_null "$status_label")" \
    "$(clab_json_number_or_null "$exit_code")" \
    "$(clab_json_string_or_null "$error_message")")"
  clab_emit_result_json "$payload"
}

clab_compact_text() {
  local value="${1-}"
  local max_chars="${2:-400}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  value="${value//$'\t'/ }"
  while [[ "$value" == *"  "* ]]; do
    value="${value//  / }"
  done
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ -n "$value" && "${#value}" -gt "$max_chars" ]]; then
    value="${value:0:max_chars}..."
  fi
  printf '%s' "$value"
}

clab_require_bin() {
  local bin_name="$1"
  if ! command -v "$bin_name" >/dev/null 2>&1; then
    echo "error: required command not found: $bin_name" >&2
    return 1
  fi
}

clab_pick_timeout_runner() {
  if command -v timeout >/dev/null 2>&1; then
    echo "timeout"
    return 0
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    echo "gtimeout"
    return 0
  fi
  return 1
}

clab_sanitize_name() {
  local value="${1-}"
  value="${value//[^a-zA-Z0-9._-]/-}"
  if [[ -z "$value" ]]; then
    value="item"
  fi
  printf '%s' "$value"
}

clab_require_portal_url() {
  local portal_url="${PORTAL_HTTP:-}"
  portal_url="${portal_url%/}"
  if [[ -z "$portal_url" ]]; then
    echo "error: PORTAL_HTTP is required (for example: https://boss.emulab.net:43794)" >&2
    return 1
  fi
  printf '%s' "$portal_url"
}

clab_token_from_file() {
  local token_file="$1"
  if [[ ! -f "$token_file" ]]; then
    echo "error: token file does not exist: $token_file" >&2
    return 1
  fi

  local token
  token="$(tr -d '\r' < "$token_file" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

  if [[ "$token" == \{*\} ]]; then
    if command -v jq >/dev/null 2>&1; then
      local parsed
      parsed="$(jq -r '.token // .api_token // .value // empty' "$token_file" 2>/dev/null || true)"
      if [[ -n "$parsed" ]]; then
        token="$parsed"
      fi
    fi
  fi

  if [[ -z "$token" ]]; then
    echo "error: token file is empty: $token_file" >&2
    return 1
  fi

  printf '%s' "$token"
}

clab_require_portal_token() {
  local token="${PORTAL_TOKEN:-}"
  if [[ -n "$token" ]]; then
    printf '%s' "$token"
    return 0
  fi

  local token_file="${PORTAL_TOKEN_FILE:-}"
  if [[ -n "$token_file" ]]; then
    clab_token_from_file "$token_file"
    return 0
  fi

  echo "error: set PORTAL_TOKEN or PORTAL_TOKEN_FILE before calling CloudLab API" >&2
  return 1
}

clab_api_request() {
  local method="$1"
  local api_path="$2"
  local body_file="${3:-}"
  local elaborate="${4:-false}"

  local portal_url
  portal_url="$(clab_require_portal_url)"
  local token
  token="$(clab_require_portal_token)"

  local normalized_path="/${api_path#/}"
  local request_url="${portal_url}${normalized_path}"

  local response_body
  response_body="$(mktemp)"

  local -a curl_cmd=(
    curl
    -sS
    -X "$method"
    -H "Accept: application/json"
    -H "X-Api-Token: $token"
    -o "$response_body"
    -w "%{http_code}"
  )

  if [[ "$elaborate" == "true" ]]; then
    curl_cmd+=( -H "X-Api-Elaborate: true" )
  fi

  if [[ -n "$body_file" ]]; then
    curl_cmd+=( -H "Content-Type: application/json" --data-binary "@$body_file" )
  fi

  curl_cmd+=( "$request_url" )

  local http_code
  set +e
  http_code="$("${curl_cmd[@]}")"
  local curl_status=$?
  set -e

  CLAB_LAST_HTTP_CODE="$http_code"
  CLAB_LAST_BODY_FILE="$response_body"

  if [[ "$curl_status" -ne 0 ]]; then
    return 2
  fi

  if [[ "$http_code" =~ ^[0-9]+$ ]] && (( http_code >= 200 && http_code < 300 )); then
    return 0
  fi

  return 1
}

clab_api_error_message() {
  if [[ -z "$CLAB_LAST_BODY_FILE" || ! -f "$CLAB_LAST_BODY_FILE" ]]; then
    printf '%s' "cloudlab_api_error"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    local parsed
    parsed="$(jq -r '.error // .message // .detail // .details // empty' "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
    parsed="$(clab_compact_text "$parsed" 400)"
    if [[ -n "$parsed" ]]; then
      printf '%s' "$parsed"
      return 0
    fi
  fi

  local raw
  raw="$(cat "$CLAB_LAST_BODY_FILE" 2>/dev/null || true)"
  raw="$(clab_compact_text "$raw" 400)"
  if [[ -n "$raw" ]]; then
    printf '%s' "$raw"
  else
    printf '%s' "cloudlab_api_error"
  fi
}

clab_extract_hosts_array_json() {
  local experiment_json_file="$1"
  jq -c '
    [
      (.aggregates // {})
      | to_entries[]?
      | .value.nodes[]?
      | {
          urn: (.urn // ""),
          client_id: (.client_id // ""),
          hostname: (.hostname // ""),
          ipv4: (.ipv4 // ""),
          ssh_target: (.hostname // .ipv4 // ""),
          status: (.status // ""),
          state: (.state // ""),
          rawstate: (.rawstate // "")
        }
    ]
    | unique_by((.client_id // "") + "|" + (.ssh_target // ""))
    | sort_by(.client_id)
  ' "$experiment_json_file"
}
