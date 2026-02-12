---
id: repo-quick-audit
name: Repo Quick Audit
shortDescription: Fast local repository sanity checks
loadingStrategy: lazy
tools:
  - skill-script-run
  - read
  - glob
  - grep
tags:
  - community
  - audit
meta:
  approvedByUser: true
---

# Summary
Run a fast repository audit with `skill-script-run` before deep debugging.

## Procedures
1. Run script `audit-basics` to collect quick health signals.
2. Review output for dirty git state, TODO count, and unresolved merge markers.
3. If warnings exist, prioritize fixes before adding new features.

## Examples
- `skill-script-run` with `{ "skillId": "repo-quick-audit", "script": "audit-basics" }`

## Troubleshooting
- If script output is empty, run from project root (`cwd: "."`).
