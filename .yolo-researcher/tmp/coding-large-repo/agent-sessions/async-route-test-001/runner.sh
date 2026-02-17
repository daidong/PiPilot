#!/usr/bin/env bash
set +e
env CODING_LARGE_REPO_DELEGATE_SYNC_ONLY=1 bash /Users/daidong/Documents/gitrepos/AgentFoundry/examples/yolo-researcher/skills/default-project-skills/coding-large-repo/scripts/delegate-coding-agent.sh --task small\ task\ for\ async\ route --provider auto --cwd . --claude-tools Bash\,Read\,Edit\,Write  > .yolo-researcher/tmp/coding-large-repo/agent-sessions/async-route-test-001/agent.log 2>&1
status=$?
printf '%s\n' "$status" > .yolo-researcher/tmp/coding-large-repo/agent-sessions/async-route-test-001/exit_code
exit "$status"
