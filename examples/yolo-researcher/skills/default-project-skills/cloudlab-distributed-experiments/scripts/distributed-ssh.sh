#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

SCRIPT_NAME="distributed-ssh"
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
usage: distributed-ssh.sh --hosts-file <path> --cmd <command> [options]

Options:
  --ssh-user <user>               default: geniuser
  --parallel <n>                  default: 4
  --timeout-sec <seconds>         optional per-host timeout
  --workdir <path>                remote working directory before running command
  --continue-on-error             return success even when some hosts fail
  --out-dir <path>                optional output/log directory
HELP
}

HOSTS_FILE=""
CMD=""
SSH_USER="geniuser"
PARALLEL=4
TIMEOUT_SEC=0
WORKDIR=""
CONTINUE_ON_ERROR="false"
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts-file)
      HOSTS_FILE="${2:-}"
      shift 2
      ;;
    --cmd)
      CMD="${2:-}"
      shift 2
      ;;
    --ssh-user)
      SSH_USER="${2:-}"
      shift 2
      ;;
    --parallel)
      PARALLEL="${2:-}"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --continue-on-error)
      CONTINUE_ON_ERROR="true"
      shift
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
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

clab_require_bin jq || fail "jq is required" 2
clab_require_bin ssh || fail "ssh is required" 2

[[ -n "$HOSTS_FILE" ]] || fail "--hosts-file is required" 2
[[ -f "$HOSTS_FILE" ]] || fail "hosts file not found: $HOSTS_FILE" 2
[[ -n "$CMD" ]] || fail "--cmd is required" 2
[[ "$PARALLEL" =~ ^[0-9]+$ ]] || fail "--parallel must be integer" 2
[[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || fail "--timeout-sec must be integer" 2
if (( PARALLEL <= 0 )); then
  fail "--parallel must be > 0" 2
fi

mkdir -p "$CLOUDLAB_DISTRIBUTED_TMP_DIR" "$CLOUDLAB_DISTRIBUTED_LOG_DIR"

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$CLOUDLAB_DISTRIBUTED_LOG_DIR/distributed-ssh-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$OUT_DIR"

decode_base64() {
  local value="$1"
  local decoded=""
  if decoded="$(printf '%s' "$value" | base64 --decode 2>/dev/null)"; then
    printf '%s' "$decoded"
    return 0
  fi
  if decoded="$(printf '%s' "$value" | base64 -D 2>/dev/null)"; then
    printf '%s' "$decoded"
    return 0
  fi
  return 1
}

run_ssh_one() {
  local encoded="$1"
  local idx="$2"
  local record
  record="$(decode_base64 "$encoded" || true)"
  if [[ -z "$record" ]]; then
    return 0
  fi

  local client_id
  local target
  client_id="$(jq -r '.client_id // empty' <<<"$record")"
  target="$(jq -r '.ssh_target // empty' <<<"$record")"

  if [[ -z "$client_id" ]]; then
    client_id="node-${idx}"
  fi

  local safe_id
  safe_id="$(clab_sanitize_name "$client_id")"
  local log_path="$OUT_DIR/host-${safe_id}.log"
  local status_path="$OUT_DIR/status-${safe_id}.json"

  if [[ -z "$target" ]]; then
    jq -cn --arg client_id "$client_id" --arg target "$target" --arg log_path "$log_path" '{client_id:$client_id,target:$target,exit_code:98,status:"failed",log_path:$log_path,error:"missing_ssh_target"}' > "$status_path"
    return 0
  fi

  local remote_cmd="$CMD"
  if [[ -n "$WORKDIR" ]]; then
    remote_cmd="cd $(printf '%q' "$WORKDIR") && $CMD"
  fi

  local quoted_remote
  quoted_remote="$(printf '%q' "$remote_cmd")"

  local -a ssh_cmd=(
    ssh
    -o BatchMode=yes
    -o ConnectTimeout=20
    -o StrictHostKeyChecking=accept-new
    "${SSH_USER}@${target}"
    "bash -lc ${quoted_remote}"
  )

  local -a exec_cmd
  if (( TIMEOUT_SEC > 0 )); then
    if timeout_bin="$(clab_pick_timeout_runner)"; then
      exec_cmd=("$timeout_bin" "$TIMEOUT_SEC" "${ssh_cmd[@]}")
    else
      exec_cmd=("${ssh_cmd[@]}")
    fi
  else
    exec_cmd=("${ssh_cmd[@]}")
  fi

  set +e
  "${exec_cmd[@]}" > "$log_path" 2>&1
  local exit_code=$?
  set -e

  local status_label="failed"
  if [[ "$exit_code" == "0" ]]; then
    status_label="completed"
  fi

  jq -cn \
    --arg client_id "$client_id" \
    --arg target "$target" \
    --arg log_path "$log_path" \
    --arg status "$status_label" \
    --argjson exit_code "$exit_code" \
    '{client_id:$client_id,target:$target,exit_code:$exit_code,status:$status,log_path:$log_path}' > "$status_path"

  return 0
}

HOST_LINES=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  HOST_LINES+=("$line")
done < <(
  jq -r '
    if type != "array" then
      error("hosts file must be a JSON array")
    else
      .
    end
    | to_entries[]
    | .key as $idx
    | (
        if (.value|type) == "string" then
          {client_id: ("node" + ($idx|tostring)), ssh_target: .value}
        elif (.value|type) == "object" then
          {
            client_id: (.value.client_id // ("node" + ($idx|tostring))),
            ssh_target: (.value.ssh_target // .value.hostname // .value.ipv4 // "")
          }
        else
          empty
        end
      )
    | @base64
  ' "$HOSTS_FILE"
)

if [[ "${#HOST_LINES[@]}" -eq 0 ]]; then
  fail "hosts file resolved to zero runnable hosts" 3
fi

clab_print_kv host_count "${#HOST_LINES[@]}"
clab_print_kv parallel "$PARALLEL"
clab_print_kv out_dir "$OUT_DIR"

RUNNING_PIDS=()

prune_running_pids() {
  local alive=()
  local pid
  for pid in "${RUNNING_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive+=("$pid")
    else
      wait "$pid" || true
    fi
  done
  RUNNING_PIDS=("${alive[@]}")
}

idx=0
for line in "${HOST_LINES[@]}"; do
  run_ssh_one "$line" "$idx" &
  RUNNING_PIDS+=("$!")
  idx=$((idx + 1))

  while [[ "${#RUNNING_PIDS[@]}" -ge "$PARALLEL" ]]; do
    prune_running_pids
    if [[ "${#RUNNING_PIDS[@]}" -ge "$PARALLEL" ]]; then
      sleep 0.2
    fi
  done
done

for pid in "${RUNNING_PIDS[@]}"; do
  wait "$pid" || true
done

STATUS_FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  STATUS_FILES+=("$f")
done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'status-*.json' | sort)

if [[ "${#STATUS_FILES[@]}" -eq 0 ]]; then
  fail "no status files produced" 4
fi

SUMMARY_PATH="$OUT_DIR/summary.json"
jq -s '.' "${STATUS_FILES[@]}" > "$SUMMARY_PATH"

TOTAL_HOSTS="$(jq -r 'length' "$SUMMARY_PATH")"
SUCCESS_HOSTS="$(jq -r '[.[] | select(.exit_code == 0)] | length' "$SUMMARY_PATH")"
FAILED_HOSTS="$(jq -r '[.[] | select(.exit_code != 0)] | length' "$SUMMARY_PATH")"

clab_print_kv success_hosts "$SUCCESS_HOSTS"
clab_print_kv failed_hosts "$FAILED_HOSTS"
clab_print_kv summary_path "$SUMMARY_PATH"

STATUS_LABEL="completed"
EXIT_CODE=0
if [[ "$FAILED_HOSTS" != "0" ]]; then
  STATUS_LABEL="partial"
  if [[ "$CONTINUE_ON_ERROR" != "true" ]]; then
    STATUS_LABEL="failed"
    EXIT_CODE=5
  fi
fi

RESULT_JSON="$(jq -cn \
  --arg schema "$CLOUDLAB_DISTRIBUTED_RESULT_SCHEMA" \
  --arg script "$SCRIPT_NAME" \
  --arg status "$STATUS_LABEL" \
  --arg out_dir "$OUT_DIR" \
  --arg summary_path "$SUMMARY_PATH" \
  --arg cmd "$CMD" \
  --arg ssh_user "$SSH_USER" \
  --argjson total_hosts "$TOTAL_HOSTS" \
  --argjson success_hosts "$SUCCESS_HOSTS" \
  --argjson failed_hosts "$FAILED_HOSTS" \
  --argjson continue_on_error "$CONTINUE_ON_ERROR" \
  --argjson exit_code "$EXIT_CODE" \
  '{
    schema: $schema,
    script: $script,
    status: $status,
    exit_code: $exit_code,
    total_hosts: $total_hosts,
    success_hosts: $success_hosts,
    failed_hosts: $failed_hosts,
    ssh_user: $ssh_user,
    command: $cmd,
    out_dir: $out_dir,
    summary_path: $summary_path,
    continue_on_error: $continue_on_error
  }')"

emit_result "$RESULT_JSON"
exit "$EXIT_CODE"
