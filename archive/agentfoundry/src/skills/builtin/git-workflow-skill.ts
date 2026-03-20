/**
 * Git Workflow Skill
 *
 * Provides procedural knowledge for Git operations:
 * - Branching and merging strategies
 * - Commit best practices
 * - Conflict resolution
 * - Common workflows
 *
 * This skill provides guidance for git-related tools.
 */

import { defineSkill } from '../define-skill.js'
import type { Skill } from '../../types/skill.js'

/**
 * Git Workflow Skill
 */
export const gitWorkflowSkill: Skill = defineSkill({
  id: 'git-workflow-skill',
  name: 'Git Workflow',
  shortDescription: 'Git operations, branching strategies, and version control best practices',

  instructions: {
    summary: `Git workflow guidance for:
- **Commits**: Atomic changes with descriptive messages
- **Branches**: Feature branches, naming conventions
- **Merging**: Strategies for integrating changes
- **Common operations**: status, diff, log, reset, stash`,

    procedures: `
## Commit Best Practices

### Message Format
\`\`\`
<type>(<scope>): <subject>

<body>

<footer>
\`\`\`

Types: feat, fix, docs, style, refactor, test, chore

### Guidelines
- Subject line: 50 chars max, imperative mood ("Add feature" not "Added feature")
- Body: Explain what and why, not how
- Reference issues: "Fixes #123" or "Relates to #456"

## Branching Strategy

### Branch Naming
- Features: \`feature/short-description\`
- Fixes: \`fix/issue-description\`
- Releases: \`release/v1.2.0\`
- Hotfixes: \`hotfix/critical-issue\`

### Workflow
1. Create branch from main/develop
2. Make atomic commits
3. Keep branch up-to-date with base
4. Create PR when ready
5. Squash or rebase before merge

## Common Operations

### Check Status
\`\`\`bash
git status              # Working tree status
git diff                # Unstaged changes
git diff --staged       # Staged changes
\`\`\`

### Undo Changes
\`\`\`bash
git checkout -- <file>  # Discard working changes
git reset HEAD <file>   # Unstage file
git reset --soft HEAD~1 # Undo last commit, keep changes
git reset --hard HEAD~1 # Undo last commit, discard changes
\`\`\`

### Stashing
\`\`\`bash
git stash               # Stash changes
git stash pop           # Apply and remove stash
git stash list          # List stashes
git stash drop          # Remove stash
\`\`\`

## Merge Strategies

### Fast-Forward (linear history)
\`\`\`bash
git checkout main
git merge --ff-only feature/x
\`\`\`

### Merge Commit (preserves history)
\`\`\`bash
git checkout main
git merge --no-ff feature/x
\`\`\`

### Rebase (clean linear history)
\`\`\`bash
git checkout feature/x
git rebase main
git checkout main
git merge feature/x
\`\`\`

## Safety Rules
- Never force push to main/master without explicit approval
- Always create backup branch before destructive operations
- Use \`--dry-run\` flag when available
- Review diff before committing
`,

    examples: `
## Feature Development Workflow
\`\`\`bash
# Start feature
git checkout -b feature/user-auth
git status

# Make changes and commit
git add src/auth.ts
git commit -m "feat(auth): add JWT token validation"

# Keep up to date
git fetch origin
git rebase origin/main

# Push and create PR
git push -u origin feature/user-auth
\`\`\`

## Fix Commit Message
\`\`\`bash
# Amend last commit message
git commit --amend -m "fix(auth): correct token expiry check"

# Amend without changing message
git commit --amend --no-edit
\`\`\`

## Interactive Rebase (squash commits)
\`\`\`bash
# Squash last 3 commits
git rebase -i HEAD~3
# In editor: change 'pick' to 'squash' for commits to combine
\`\`\`

## Resolve Merge Conflict
\`\`\`bash
git merge feature/x
# Conflict detected
git status                    # See conflicted files
# Edit files to resolve
git add <resolved-files>
git merge --continue
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "Your branch is behind"
\`\`\`bash
git fetch origin
git rebase origin/main
# or
git pull --rebase
\`\`\`

### "Merge conflict"
1. Check conflicted files: \`git status\`
2. Open files, look for \`<<<<<<<\`, \`=======\`, \`>>>>>>>\`
3. Edit to resolve, remove conflict markers
4. Stage resolved files: \`git add <files>\`
5. Continue: \`git merge --continue\` or \`git rebase --continue\`

### "Detached HEAD"
\`\`\`bash
# Create branch from current state
git checkout -b recovery-branch
# Or return to main
git checkout main
\`\`\`

### Accidentally committed to wrong branch
\`\`\`bash
git branch correct-branch      # Save commit to new branch
git reset --hard HEAD~1        # Remove from wrong branch
git checkout correct-branch    # Switch to correct branch
\`\`\`

### Lost commits after reset
\`\`\`bash
git reflog                     # Find commit SHA
git checkout <sha>             # Recover commit
git checkout -b recovery       # Create branch
\`\`\`
`
  },

  tools: ['bash', 'git_status', 'git_diff', 'git_add', 'git_commit', 'git_log'],  // Git operations
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 50,
    full: 700
  },

  tags: ['git', 'version-control', 'workflow', 'devops']
})

export default gitWorkflowSkill
