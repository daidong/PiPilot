#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="verify-targets"
RESULT_EMITTED=0

emit_result() {
  RESULT_EMITTED=1
  clrepo_emit_result_json "$1"
}

emit_failure_result() {
  local message="${1:-script_failed}"
  local exit_code="${2:-2}"
  RESULT_EMITTED=1
  clrepo_emit_error_result_json "$SCRIPT_NAME" "$exit_code" "$message" "error"
}

fail() {
  local message="$1"
  local exit_code="${2:-2}"
  echo "error: $message" >&2
  emit_failure_result "$message" "$exit_code"
  exit "$exit_code"
}

trap 'status=$?; if [[ "$status" -ne 0 && "$RESULT_EMITTED" -eq 0 ]]; then emit_failure_result "unexpected_failure" "$status"; fi' EXIT

if ! clrepo_require_legacy_entry_opt_in "$SCRIPT_NAME"; then
  RESULT_EMITTED=1
  exit 2
fi

usage() {
  cat <<'EOF'
usage: verify-targets.sh --cmd "<command>" [options]

Examples:
  verify-targets.sh --cmd "npx vitest run tests/yolo-researcher-v2/runtime-contract.test.ts"
  verify-targets.sh --cmd "pytest -q tests/test_runtime.py::test_resume" --cwd "."
  verify-targets.sh --cmd "pytest -q tests/test_runtime.py::test_resume" --runtime docker --docker-image my-repo-dev:latest

Options:
  --cmd <command>                    Required verification command.
  --cwd <path>                       Working directory. Default: auto-detected.
  --timeout-sec <seconds>            Optional timeout for each attempt.
  --runtime <auto|docker|host>       Default: auto (prefer docker, fallback to host).
  --docker-image <image>             Optional image. Falls back to $CODING_LARGE_REPO_DOCKER_IMAGE.
  --docker-network <mode>            Default: none.
  --docker-cpus <value>              Optional --cpus value for docker run.
  --docker-memory <value>            Optional --memory value for docker run.
  --docker-pids-limit <value>        Default: 512.
  --host-fallback <true|false>       Default: true.
EOF
}

CMD=""
CWD=""
CWD_EXPLICIT="false"
TIMEOUT_SEC=""
RUNTIME="auto"
DOCKER_IMAGE="${CODING_LARGE_REPO_DOCKER_IMAGE:-}"
DOCKER_NETWORK="${CODING_LARGE_REPO_DOCKER_NETWORK:-none}"
DOCKER_CPUS="${CODING_LARGE_REPO_DOCKER_CPUS:-}"
DOCKER_MEMORY="${CODING_LARGE_REPO_DOCKER_MEMORY:-}"
DOCKER_PIDS_LIMIT="${CODING_LARGE_REPO_DOCKER_PIDS_LIMIT:-512}"
HOST_FALLBACK="true"
DOCKER_ENV_PASSTHROUGH="${CODING_LARGE_REPO_DOCKER_ENV_PASSTHROUGH:-OPENAI_API_KEY OPENAI_API_BASE OPENAI_BASE_URL OPENAI_ORG_ID ANTHROPIC_API_KEY DEEPSEEK_API_KEY GOOGLE_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT AZURE_API_VERSION}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cmd)
      CMD="${2:-}"
      shift 2
      ;;
    --cwd)
      CWD="${2:-}"
      CWD_EXPLICIT="true"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --runtime)
      RUNTIME="${2:-}"
      shift 2
      ;;
    --docker-image)
      DOCKER_IMAGE="${2:-}"
      shift 2
      ;;
    --docker-network)
      DOCKER_NETWORK="${2:-}"
      shift 2
      ;;
    --docker-cpus)
      DOCKER_CPUS="${2:-}"
      shift 2
      ;;
    --docker-memory)
      DOCKER_MEMORY="${2:-}"
      shift 2
      ;;
    --docker-pids-limit)
      DOCKER_PIDS_LIMIT="${2:-}"
      shift 2
      ;;
    --host-fallback)
      HOST_FALLBACK="${2:-}"
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

if [[ -z "$CMD" ]]; then
  usage >&2
  fail "--cmd is required" 2
fi

REQUESTED_CWD=""
if [[ "$CWD_EXPLICIT" == "true" ]]; then
  REQUESTED_CWD="$CWD"
fi
CWD_REASON="default_root"
clrepo_resolve_cwd "$REQUESTED_CWD" "$CMD" CWD CWD_REASON

case "$RUNTIME" in
  auto|docker|host)
    ;;
  *)
    fail "invalid --runtime: $RUNTIME (expected auto|docker|host)" 2
    ;;
esac

case "$HOST_FALLBACK" in
  true|false|TRUE|FALSE|1|0)
    ;;
  *)
    fail "invalid --host-fallback: $HOST_FALLBACK (expected true|false)" 2
    ;;
esac

if [[ ! -d "$CWD" ]]; then
  fail "cwd does not exist: $CWD" 2
fi

ABS_CWD="$(cd "$CWD" && pwd)"
# Keep verify logs anchored to the target repository (resolved --cwd),
# not the caller process cwd.
LOG_DIR="$ABS_CWD/.yolo-researcher/logs/coding-large-repo"
mkdir -p "$LOG_DIR"
STAMP="$(date +"%Y%m%d-%H%M%S")-$RANDOM"
LOG_PATH="$LOG_DIR/verify-$STAMP.log"

RUNNER=()
if [[ -n "$TIMEOUT_SEC" ]]; then
  if TIMEOUT_BIN="$(clrepo_pick_timeout_runner)"; then
    RUNNER=("$TIMEOUT_BIN" "$TIMEOUT_SEC")
  else
    echo "warning: timeout command not found; running without timeout" >&2
  fi
fi

REQUESTED_RUNTIME="$RUNTIME"
EFFECTIVE_RUNTIME=""
DOCKER_ATTEMPTED="false"
DOCKER_AVAILABLE="false"
DOCKER_EXIT_CODE=""
DOCKER_FAILURE_REASON=""
HOST_ATTEMPTED="false"
HOST_EXIT_CODE=""
FALLBACK_USED="false"
FALLBACK_REASON=""
RESOLVED_DOCKER_IMAGE=""

echo "[coding-large-repo] cwd: $ABS_CWD" | tee "$LOG_PATH"
echo "[coding-large-repo] requested_cwd: ${REQUESTED_CWD:-<auto>}" | tee -a "$LOG_PATH"
echo "[coding-large-repo] cwd_reason: $CWD_REASON" | tee -a "$LOG_PATH"
echo "[coding-large-repo] cmd: $CMD" | tee -a "$LOG_PATH"
echo "[coding-large-repo] requested_runtime: $REQUESTED_RUNTIME" | tee -a "$LOG_PATH"
echo "[coding-large-repo] command output is written to log_path (tail shown on failures)." | tee -a "$LOG_PATH"

print_log_tail() {
  local label="${1:-attempt failed}"
  local lines="${2:-40}"
  echo "[coding-large-repo] $label; showing last $lines log lines (full log: $LOG_PATH)"
  if [[ -f "$LOG_PATH" ]]; then
    tail -n "$lines" "$LOG_PATH"
  fi
}

run_host() {
  HOST_ATTEMPTED="true"
  echo "[coding-large-repo] host attempt start" | tee -a "$LOG_PATH"
  local status=0
  if (
    cd "$ABS_CWD"
    if [[ ${#RUNNER[@]} -gt 0 ]]; then
      "${RUNNER[@]}" bash -lc "$CMD" >>"$LOG_PATH" 2>&1
    else
      bash -lc "$CMD" >>"$LOG_PATH" 2>&1
    fi
  ); then
    status=0
  else
    status=$?
  fi
  HOST_EXIT_CODE="$status"
  echo "[coding-large-repo] host attempt exit_code: $HOST_EXIT_CODE" | tee -a "$LOG_PATH"
  if [[ "$status" -ne 0 ]]; then
    print_log_tail "host attempt failed with exit $status"
  fi
  return "$status"
}

can_use_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_FAILURE_REASON="docker CLI not found"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    DOCKER_FAILURE_REASON="docker daemon unavailable"
    return 1
  fi
  DOCKER_AVAILABLE="true"
  return 0
}

resolve_docker_image() {
  if [[ -n "$DOCKER_IMAGE" ]]; then
    RESOLVED_DOCKER_IMAGE="$DOCKER_IMAGE"
    return 0
  fi

  if [[ -f "$ABS_CWD/Dockerfile" ]]; then
    local repo_name
    repo_name="$(basename "$ABS_CWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-')"
    if [[ -z "$repo_name" ]]; then
      repo_name="repo"
    fi
    RESOLVED_DOCKER_IMAGE="coding-large-repo-${repo_name}:latest"
    if ! docker image inspect "$RESOLVED_DOCKER_IMAGE" >/dev/null 2>&1; then
      echo "[coding-large-repo] docker image missing, building: $RESOLVED_DOCKER_IMAGE" | tee -a "$LOG_PATH"
      set +e
      docker build -t "$RESOLVED_DOCKER_IMAGE" "$ABS_CWD" 2>&1 | tee -a "$LOG_PATH"
      local build_status=${PIPESTATUS[0]}
      set -e
      if [[ "$build_status" -ne 0 ]]; then
        DOCKER_FAILURE_REASON="docker image build failed (exit $build_status)"
        return 1
      fi
    fi
    return 0
  fi

  DOCKER_FAILURE_REASON="no docker image configured and no Dockerfile found in cwd"
  return 1
}

run_docker() {
  DOCKER_ATTEMPTED="true"
  if ! can_use_docker; then
    return 99
  fi
  if ! resolve_docker_image; then
    return 99
  fi

  declare -a docker_cmd
  declare -a docker_env_args
  declare -a docker_env_names

  docker_env_args=()
  docker_env_names=()
  local env_passthrough_lc
  env_passthrough_lc="$(printf '%s' "$DOCKER_ENV_PASSTHROUGH" | tr '[:upper:]' '[:lower:]')"
  if [[ "$env_passthrough_lc" != "none" ]]; then
    # Accept either comma- or whitespace-separated env names.
    local env_list
    env_list="$(printf '%s' "$DOCKER_ENV_PASSTHROUGH" | tr ',' ' ')"
    local env_name
    for env_name in $env_list; do
      if [[ -n "${!env_name:-}" ]]; then
        docker_env_args+=(-e "$env_name")
        docker_env_names+=("$env_name")
      fi
    done
  fi

  docker_cmd=(
    docker
    run
    --rm
    -v "$ABS_CWD:/work"
    -w /work
    --network "$DOCKER_NETWORK"
    --pids-limit "$DOCKER_PIDS_LIMIT"
    --entrypoint sh
  )
  if [[ -n "$DOCKER_CPUS" ]]; then
    docker_cmd+=(--cpus "$DOCKER_CPUS")
  fi
  if [[ -n "$DOCKER_MEMORY" ]]; then
    docker_cmd+=(--memory "$DOCKER_MEMORY")
  fi
  if [[ ${#docker_env_args[@]} -gt 0 ]]; then
    docker_cmd+=("${docker_env_args[@]}")
  fi
  docker_cmd+=(
    "$RESOLVED_DOCKER_IMAGE"
    -lc "$CMD"
  )

  echo "[coding-large-repo] docker attempt start" | tee -a "$LOG_PATH"
  echo "[coding-large-repo] docker image: $RESOLVED_DOCKER_IMAGE" | tee -a "$LOG_PATH"
  if [[ ${#docker_env_names[@]} -gt 0 ]]; then
    echo "[coding-large-repo] docker env passthrough: ${docker_env_names[*]}" | tee -a "$LOG_PATH"
  else
    echo "[coding-large-repo] docker env passthrough: (none)" | tee -a "$LOG_PATH"
  fi
  echo "[coding-large-repo] docker command: $(clrepo_join_shell_words "${docker_cmd[@]}")" | tee -a "$LOG_PATH"

  local status=0
  if [[ ${#RUNNER[@]} -gt 0 ]]; then
    if "${RUNNER[@]}" "${docker_cmd[@]}" >>"$LOG_PATH" 2>&1; then
      status=0
    else
      status=$?
    fi
  else
    if "${docker_cmd[@]}" >>"$LOG_PATH" 2>&1; then
      status=0
    else
      status=$?
    fi
  fi
  DOCKER_EXIT_CODE="$status"
  if [[ "$status" -ne 0 && -z "$DOCKER_FAILURE_REASON" ]]; then
    DOCKER_FAILURE_REASON="docker run failed (exit $status)"
  fi
  echo "[coding-large-repo] docker attempt exit_code: $DOCKER_EXIT_CODE" | tee -a "$LOG_PATH"
  if [[ "$status" -ne 0 ]]; then
    print_log_tail "docker attempt failed with exit $status"
  fi
  return "$status"
}

should_fallback_after_docker_exit() {
  local status="${1:-1}"
  case "$status" in
    125|126|127|99)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

FINAL_STATUS=0

if [[ "$REQUESTED_RUNTIME" == "host" ]]; then
  EFFECTIVE_RUNTIME="host"
  if run_host; then
    FINAL_STATUS=0
  else
    FINAL_STATUS=$?
  fi
else
  docker_status=0
  if run_docker; then
    docker_status=0
  else
    docker_status=$?
  fi

  if [[ "$docker_status" -eq 0 ]]; then
    EFFECTIVE_RUNTIME="docker"
    FINAL_STATUS=0
  else
    if [[ "$HOST_FALLBACK" =~ ^(true|TRUE|1)$ ]] && should_fallback_after_docker_exit "$docker_status"; then
      FALLBACK_USED="true"
      FALLBACK_REASON="$DOCKER_FAILURE_REASON"
      echo "[coding-large-repo] fallback_to_host: $FALLBACK_REASON" | tee -a "$LOG_PATH"
      EFFECTIVE_RUNTIME="host"
      if run_host; then
        FINAL_STATUS=0
      else
        FINAL_STATUS=$?
      fi
    else
      EFFECTIVE_RUNTIME="docker"
      FINAL_STATUS="$docker_status"
    fi
  fi
fi

echo "exit_code: $FINAL_STATUS"
echo "log_path: $LOG_PATH"

STATUS_LABEL="failed"
if [[ "$FINAL_STATUS" == "0" ]]; then
  STATUS_LABEL="completed"
fi

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"verify-targets\",\"status\":%s,\"exit_code\":%s,\"requested_cwd\":%s,\"cwd\":%s,\"cwd_reason\":%s,\"cmd\":%s,\"timeout_sec\":%s,\"requested_runtime\":%s,\"effective_runtime\":%s,\"docker_attempted\":%s,\"docker_available\":%s,\"docker_image\":%s,\"docker_exit_code\":%s,\"host_attempted\":%s,\"host_exit_code\":%s,\"fallback_used\":%s,\"fallback_reason\":%s,\"log_path\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$STATUS_LABEL")" \
  "$(clrepo_json_number_or_null "$FINAL_STATUS")" \
  "$(clrepo_json_string_or_null "$REQUESTED_CWD")" \
  "$(clrepo_json_string_or_null "$ABS_CWD")" \
  "$(clrepo_json_string_or_null "$CWD_REASON")" \
  "$(clrepo_json_string_or_null "$CMD")" \
  "$(clrepo_json_number_or_null "$TIMEOUT_SEC")" \
  "$(clrepo_json_string_or_null "$REQUESTED_RUNTIME")" \
  "$(clrepo_json_string_or_null "$EFFECTIVE_RUNTIME")" \
  "$(clrepo_json_boolean_or_null "$DOCKER_ATTEMPTED")" \
  "$(clrepo_json_boolean_or_null "$DOCKER_AVAILABLE")" \
  "$(clrepo_json_string_or_null "$RESOLVED_DOCKER_IMAGE")" \
  "$(clrepo_json_number_or_null "$DOCKER_EXIT_CODE")" \
  "$(clrepo_json_boolean_or_null "$HOST_ATTEMPTED")" \
  "$(clrepo_json_number_or_null "$HOST_EXIT_CODE")" \
  "$(clrepo_json_boolean_or_null "$FALLBACK_USED")" \
  "$(clrepo_json_string_or_null "$FALLBACK_REASON")" \
  "$(clrepo_json_string_or_null "$LOG_PATH")")"
emit_result "$RESULT_JSON"

exit "$FINAL_STATUS"
