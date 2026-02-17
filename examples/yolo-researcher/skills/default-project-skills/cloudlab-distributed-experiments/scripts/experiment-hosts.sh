#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="experiment-hosts"
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
usage: experiment-hosts.sh --experiment-id <id> [options]

Options:
  --hosts-out <path>        default: .yolo-researcher/tmp/cloudlab-distributed-experiments/hosts-<exp>.json
  --ssh-config-out <path>   optional generated SSH config file
  --ssh-user <user>         default: geniuser
  --portal-url <url>
  --token <token>
  --token-file <file>
HELP
}

EXPERIMENT_ID=""
HOSTS_OUT=""
SSH_CONFIG_OUT=""
SSH_USER="geniuser"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --experiment-id)
      EXPERIMENT_ID="${2:-}"
      shift 2
      ;;
    --hosts-out)
      HOSTS_OUT="${2:-}"
      shift 2
      ;;
    --ssh-config-out)
      SSH_CONFIG_OUT="${2:-}"
      shift 2
      ;;
    --ssh-user)
      SSH_USER="${2:-}"
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

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

if ! clab_api_request GET "/experiments/${EXPERIMENT_ID}" "" "true"; then
  fail "failed to read experiment hosts: http=$CLAB_LAST_HTTP_CODE $(clab_api_error_message)" 3
fi

HOSTS_JSON="$(clab_extract_hosts_array_json "$CLAB_LAST_BODY_FILE")"
HOST_COUNT="$(jq -r 'length' <<<"$HOSTS_JSON")"

if [[ "$HOST_COUNT" == "0" ]]; then
  fail "experiment has zero host entries in aggregates" 4
fi

if [[ -z "$HOSTS_OUT" ]]; then
  HOSTS_OUT="$CLOUDLAB_DISTRIBUTED_TMP_DIR/hosts-$(clab_sanitize_name "$EXPERIMENT_ID").json"
fi

mkdir -p "$(dirname "$HOSTS_OUT")"
jq '.' <<<"$HOSTS_JSON" > "$HOSTS_OUT"

if [[ -n "$SSH_CONFIG_OUT" ]]; then
  mkdir -p "$(dirname "$SSH_CONFIG_OUT")"
  jq -r --arg user "$SSH_USER" '
    to_entries[]
    | .key as $idx
    | .value as $h
    | ($h.client_id | if . == "" then ("node" + ($idx|tostring)) else . end) as $name
    | ($h.ssh_target // "") as $target
    | select($target != "")
    | "Host \($name)\n  HostName \($target)\n  User \($user)\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ~/.ssh/known_hosts\n"
  ' "$HOSTS_OUT" > "$SSH_CONFIG_OUT"
fi

clab_print_kv experiment_id "$EXPERIMENT_ID"
clab_print_kv host_count "$HOST_COUNT"
clab_print_kv hosts_out "$HOSTS_OUT"
if [[ -n "$SSH_CONFIG_OUT" ]]; then
  clab_print_kv ssh_config_out "$SSH_CONFIG_OUT"
fi

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg experiment_id "$EXPERIMENT_ID" \
  --arg hosts_out "$HOSTS_OUT" \
  --arg ssh_config_out "$SSH_CONFIG_OUT" \
  --arg ssh_user "$SSH_USER" \
  --arg host_count "$HOST_COUNT" \
  '{
    schema: $schema,
    script: $script,
    status: "completed",
    exit_code: 0,
    experiment_id: $experiment_id,
    host_count: ($host_count|tonumber),
    hosts_out: $hosts_out,
    ssh_config_out: (if $ssh_config_out == "" then null else $ssh_config_out end),
    ssh_user: $ssh_user
  }')"

emit_result "$RESULT_JSON"
