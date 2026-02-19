#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent-common.sh
source "$SCRIPT_DIR/../lib/agent-common.sh"

SCRIPT_NAME="change-plan"
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

TASK="${*:-}"

if [[ -z "$TASK" ]]; then
  echo "usage: change-plan.sh \"<task description>\"" >&2
  fail "task description is required" 2
fi

PLAN_DIR=".yolo-researcher/tmp/coding-large-repo"
mkdir -p "$PLAN_DIR"

STAMP="$(date +"%Y%m%d-%H%M%S")"
PLAN_PATH="$PLAN_DIR/plan-$STAMP.md"

cat > "$PLAN_PATH" <<EOF
# Coding Change Plan

## Task
$TASK

## 1. Scope and Impact Scan
- Identify likely files/modules first (prefer \`rg --files\` and targeted \`rg\`).
- Note related tests, scripts, and config that can regress.

## 2. Edit Strategy
- Apply smallest safe edit batch.
- Keep each batch tied to one expected behavior change.
- Re-read affected code paths after each edit batch.

## 3. Verification Strategy
- Run targeted verification command after each edit batch.
- If targeted checks pass, run one broader guardrail check.
- Save command output/log paths for turn evidence.

## 4. Fallback / Escalation
- If blocked, record command + error + attempted fallback.
- Escalate to user only after local attempts and verification retries fail.
EOF

echo "plan_path: $PLAN_PATH"
cat "$PLAN_PATH"

RESULT_JSON="$(printf '{\"schema\":\"%s\",\"script\":\"change-plan\",\"status\":\"completed\",\"exit_code\":0,\"plan_path\":%s,\"task_chars\":%s}' \
  "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
  "$(clrepo_json_string_or_null "$PLAN_PATH")" \
  "$(clrepo_json_number_or_null "${#TASK}")")"
emit_result "$RESULT_JSON"
