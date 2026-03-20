/**
 * Coding Workflow Skill
 *
 * Lazy-loaded procedural knowledge for the coding agent.
 * Covers: TDD workflow, safe edits, commit conventions, debugging.
 */

import { defineSkill } from '../../../src/skills/define-skill.js'
import type { Skill } from '../../../src/types/skill.js'

export const codingWorkflowSkill: Skill = defineSkill({
  id: 'coding-workflow',
  name: 'Coding Workflow',
  shortDescription: 'TDD loop, safe edits, commit conventions, debugging approach',

  instructions: {
    summary: `
Work in a tight loop: read → understand → change → test → commit.
Always read files before editing. Run tests after every change.
Commit in small logical units with clear messages.
    `.trim(),

    procedures: `
## Core Loop

1. **Understand first** — read the relevant files; use grep/glob to find the right ones
2. **Plan before touching** — state the change in one sentence before making it
3. **Edit, don't rewrite** — prefer \`edit\` over \`write\` to avoid clobbering context
4. **Test immediately** — run tests after every non-trivial change
5. **Fix before moving on** — don't accumulate failures; fix each one before the next change

## Safe Editing

- Always \`read\` a file before calling \`edit\` on it
- Use \`glob\` + \`grep\` to locate the right file; never assume paths
- For large files use \`read\` with \`offset\`/\`limit\` to find the relevant section
- Prefer targeted edits (old_string/new_string) over full rewrites
- Check \`git_diff\` after editing to confirm the change looks right

## Running Tests

- Discover the test command from package.json / Makefile / README before running
- Run the full suite after completing a feature; run targeted tests during iteration
  - npm: \`npm test\` or \`npm run test:run\`
  - pytest: \`pytest -x\` (stop on first failure)
  - go: \`go test ./...\`
- If a test fails: read the error, read the test file, read the implementation, then fix
- Never comment out tests to make them pass

## Commit Conventions

- Stage only related files (\`git_add\` specific paths, not ".")
- Commit message format: \`type(scope): short description\`
  - Types: feat / fix / refactor / test / docs / chore
  - Example: \`fix(auth): handle expired JWT tokens gracefully\`
- One logical change per commit
- Check \`git_status\` and \`git_diff --staged\` before committing

## Debugging Approach

1. Reproduce the failure with a test or command
2. Read the stack trace carefully — start from the first frame in your code
3. Add targeted \`console.log\` or use \`grep\` to trace data flow
4. Fix the root cause, not the symptom
5. Remove debug logging before committing
    `.trim(),

    examples: `
## Example: Fix a bug

\`\`\`
# 1. Locate the relevant code
glob("src/**/*.ts") → find candidate files
grep("getUserById") → src/services/user-service.ts:45

# 2. Read before editing
read("src/services/user-service.ts", offset=40, limit=30)

# 3. Edit
edit(old_string="...", new_string="...")

# 4. Run tests
bash("npm run test:run -- --testPathPattern=user-service")

# 5. Commit
git_diff(staged=false) → confirm change
git_add(files=["src/services/user-service.ts"])
git_commit(message="fix(users): handle null userId in getUserById")
\`\`\`

## Example: Add a feature

\`\`\`
# 1. Find existing patterns to follow
grep("export function create") → see how similar functions are structured

# 2. Write the implementation (small edit first)
edit(...)

# 3. Write or update the test
edit("src/__tests__/feature.test.ts", ...)

# 4. Run and iterate
bash("npm run test:run")

# 5. Commit when green
git_add(files=["src/feature.ts", "src/__tests__/feature.test.ts"])
git_commit(message="feat(feature): add X capability")
\`\`\`
    `.trim(),

    troubleshooting: `
## Tests Failing After Edit

- Run \`git_diff\` to confirm your edit was applied correctly
- Check if there are TypeScript errors: \`bash("npx tsc --noEmit")\`
- Read the full test output, not just the summary
- Search for usages of the thing you changed: \`grep("oldFunctionName")\`

## Can't Find the Right File

- Start broad: \`glob("src/**/*.ts")\`
- Then narrow: \`grep("functionName")\`
- Check the barrel exports: look for index.ts files
- Read the README or package.json to understand project structure

## Edit Tool Says "old_string not found"

- Re-read the file to get the exact current content
- Check for trailing whitespace or different line endings
- Use a larger, more unique surrounding context in old_string

## Commit Fails

- Check \`git_status\` — may be nothing staged
- Check for pre-commit hooks: \`bash("cat .husky/pre-commit 2>/dev/null")\`
- If lint fails: fix lint errors, then re-stage and retry
    `.trim()
  },

  tools: ['edit', 'write', 'git_commit', 'git_add'],
  loadingStrategy: 'lazy',
  estimatedTokens: { summary: 60, full: 900 },
  tags: ['coding', 'tdd', 'git', 'debugging', 'refactor']
})
