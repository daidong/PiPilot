#!/usr/bin/env bash
set +e
status=1
finalize() {
  printf '%s\n' "$status" > .yolo-researcher/tmp/coding-large-repo/agent-sessions/async-smoke-001/exit_code
}
on_term() {
  status=143
  exit 143
}
trap finalize EXIT
trap on_term TERM INT HUP
env CODING_LARGE_REPO_DELEGATE_SYNC_ONLY=1 bash /Users/daidong/Documents/gitrepos/AgentFoundry/examples/yolo-researcher/skills/default-project-skills/coding-large-repo/scripts/delegate-coding-agent.sh --task short\ async\ smoke --provider auto --cwd . --claude-tools Bash\,Read\,Edit\,Write --timeout-sec 1  > .yolo-researcher/tmp/coding-large-repo/agent-sessions/async-smoke-001/agent.log 2>&1
status=$?
exit "$status"
