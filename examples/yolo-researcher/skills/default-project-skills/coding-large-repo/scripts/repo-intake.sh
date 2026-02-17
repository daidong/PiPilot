#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="repo-intake"
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

ROOT="${1:-.}"

if [[ ! -d "$ROOT" ]]; then
  fail "repo root does not exist: $ROOT" 2
fi

cd "$ROOT"

PREFERRED_CWD="."
PREFERRED_CWD_REASON="default_root"
clrepo_resolve_cwd "" "$(pwd)" PREFERRED_CWD PREFERRED_CWD_REASON

git_branch="no-git"
git_dirty="n/a"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    git_dirty="true"
  else
    git_dirty="false"
  fi
fi

stacks=()
verify_cmds=()
coding_agents=()
docker_runtime="unavailable"

if [[ -f package.json ]]; then
  stacks+=("node")
  verify_cmds+=("npm run test -- <target>")
  verify_cmds+=("npm run build")
fi

if [[ -f pyproject.toml || -f requirements.txt || -f setup.py ]]; then
  stacks+=("python")
  verify_cmds+=("pytest -q <target>")
fi

if [[ -f go.mod ]]; then
  stacks+=("go")
  verify_cmds+=("go test ./... -run <pattern>")
fi

if [[ -f Cargo.toml ]]; then
  stacks+=("rust")
  verify_cmds+=("cargo test <pattern>")
fi

if [[ ${#stacks[@]} -eq 0 ]]; then
  stacks+=("unknown")
fi

if [[ ${#verify_cmds[@]} -eq 0 ]]; then
  verify_cmds+=("bash -lc '<project-specific targeted verification command>'")
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    docker_runtime="ready"
  else
    docker_runtime="cli-only"
  fi
fi

if command -v codex >/dev/null 2>&1 || [[ -x "/Applications/Codex.app/Contents/Resources/codex" ]]; then
  coding_agents+=("codex")
fi
if command -v claude >/dev/null 2>&1; then
  coding_agents+=("claude")
fi
if [[ ${#coding_agents[@]} -eq 0 ]]; then
  coding_agents+=("none")
fi

echo "repo_root: $(pwd)"
echo "preferred_cwd: ${PREFERRED_CWD}"
echo "preferred_cwd_reason: ${PREFERRED_CWD_REASON}"
echo "git_branch: ${git_branch}"
echo "git_dirty: ${git_dirty}"
echo "detected_stacks: ${stacks[*]}"
echo "coding_agents: ${coding_agents[*]}"
echo "docker_runtime: ${docker_runtime}"
echo "suggested_verify_commands:"
for cmd in "${verify_cmds[@]}"; do
  echo "- ${cmd}"
done
if [[ "${coding_agents[*]}" != "none" ]]; then
  echo "suggested_delegate_commands:"
  echo "- skill-script-run({\"skillId\":\"coding-large-repo\",\"script\":\"delegate-coding-agent\",\"args\":[\"--task\",\"<task>\",\"--provider\",\"auto\",\"--cwd\",\"$PREFERRED_CWD\"]})"
  echo "- skill-script-run({\"skillId\":\"coding-large-repo\",\"script\":\"delegate-coding-agent\",\"args\":[\"--task\",\"<long-task>\",\"--provider\",\"auto\",\"--cwd\",\"$PREFERRED_CWD\",\"--async\",\"always\"]})"
  echo "- skill-script-run({\"skillId\":\"coding-large-repo\",\"script\":\"agent-start\",\"args\":[\"--task\",\"<long-task>\",\"--provider\",\"auto\",\"--cwd\",\"$PREFERRED_CWD\"]})"
fi

STACKS_JOINED="${stacks[*]}"
VERIFY_JOINED=""
for cmd in "${verify_cmds[@]}"; do
  if [[ -n "$VERIFY_JOINED" ]]; then
    VERIFY_JOINED="$VERIFY_JOINED; "
  fi
  VERIFY_JOINED="$VERIFY_JOINED$cmd"
done
CODING_AGENTS_JOINED="${coding_agents[*]}"
RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"repo-intake\",\"status\":\"completed\",\"exit_code\":0,\"repo_root\":%s,\"preferred_cwd\":%s,\"preferred_cwd_reason\":%s,\"git_branch\":%s,\"git_dirty\":%s,\"detected_stacks\":%s,\"coding_agents\":%s,\"docker_runtime\":%s,\"suggested_verify_commands\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$(pwd)")" \
  "$(clrepo_json_string_or_null "$PREFERRED_CWD")" \
  "$(clrepo_json_string_or_null "$PREFERRED_CWD_REASON")" \
  "$(clrepo_json_string_or_null "$git_branch")" \
  "$(clrepo_json_string_or_null "$git_dirty")" \
  "$(clrepo_json_string_or_null "$STACKS_JOINED")" \
  "$(clrepo_json_string_or_null "$CODING_AGENTS_JOINED")" \
  "$(clrepo_json_string_or_null "$docker_runtime")" \
  "$(clrepo_json_string_or_null "$VERIFY_JOINED")")"
emit_result "$RESULT_JSON"
