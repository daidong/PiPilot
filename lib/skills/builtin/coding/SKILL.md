---
name: coding
description: Systematic coding workflow for implementing, debugging, and refactoring code. Covers test-first development, 300-line generation limits, edit-over-rewrite, error-feedback loops, and incremental verification patterns.
category: General
depends: []
tags: [code, programming, development, debugging, refactoring, testing]
triggers: [write code, implement, fix bug, debug, refactor, add feature, unit test, coding, code review, build error, test failure, programming, develop, 写代码, 编程, 调试, 重构]
allowed-tools: [Read, Write, Edit, Bash, Grep, Find, Ls]
---

# Coding

## Overview

This skill provides a disciplined workflow for writing, modifying, and debugging code inside the workspace. The core principle is **small verified steps**: never generate large blocks without running tests, never rewrite a file when a targeted edit suffices, and always close the feedback loop by checking the result of every change.

## When to Use This Skill

- Implementing a new feature, function, or module
- Fixing a bug or build error
- Refactoring existing code
- Adding or updating tests
- Reviewing code and suggesting improvements
- Any task that involves reading, writing, or running code in the workspace

## Core Principles

### 1. Understand Before Changing

Before writing any code:
1. Use `grep` and `find` to locate relevant files and understand the existing structure.
2. Use `read` with offset+limit to inspect specific sections — avoid reading entire large files.
3. Identify existing patterns, conventions, naming schemes, and test styles in the project.
4. Check for existing tests related to the area you are changing.

### 2. Test-First Development

When the project has a test framework:
1. **Write or update the test first** that captures the expected behavior.
2. Run the test to confirm it fails (red).
3. Implement the minimal code to make the test pass (green).
4. Run the test again to confirm it passes.
5. Refactor if needed, re-running tests after each change.

When there is no test framework or when writing a quick script, verify by running the code and checking output instead.

### 3. Small Generation Limit

- **Never generate more than 300 lines of code in a single write/edit operation.** If the task requires more, break it into multiple steps, verifying each step before proceeding.
- Prefer multiple small, tested increments over one large generation.
- Each increment should leave the codebase in a working state.

### 4. Edit Over Rewrite

- **Use `edit` (oldText/newText) for targeted changes** to existing files. Do not rewrite an entire file when only a few lines need to change.
- Use `write` only for new files or when the majority of a file must change.
- Before editing, `read` the relevant section to get the exact `oldText` — do not guess.

### 5. Error-Feedback Loop

After every code change:
1. **Run the relevant command** (build, test, lint, or the script itself) using `bash`.
2. **Read the error output carefully.** Do not guess what went wrong.
3. If the command fails, diagnose the root cause from the actual error message.
4. Fix the specific issue. Do not make speculative bulk changes.
5. Re-run to confirm the fix. Repeat until green.

Never move on to the next step while the current step has failing tests or build errors.

### 6. Iteration Awareness

For multi-step tasks:
- Plan the sequence of changes before starting.
- After each step, verify the codebase is in a clean state (tests pass, no lint errors).
- If you discover that your plan needs adjustment, state the revised plan before continuing.
- Keep the user informed of progress: what was done, what comes next.

## Workflow

### New Feature Implementation

1. **Locate**: `grep`/`find` to understand where the feature fits.
2. **Read**: Inspect related modules, interfaces, and existing tests.
3. **Plan**: State the files to create/modify and the order.
4. **Test**: Write the test(s) first.
5. **Implement**: Write code in increments of <=300 lines per operation.
6. **Verify**: Run tests after each increment.
7. **Clean up**: Remove dead code, add comments where non-obvious.

### Bug Fix

1. **Reproduce**: Run the failing test or command; read the error.
2. **Locate**: Use `grep` to find the relevant code path.
3. **Diagnose**: Read the code and identify the root cause.
4. **Test**: Write a test that reproduces the bug (if one doesn't exist).
5. **Fix**: Make the minimal targeted edit.
6. **Verify**: Run tests to confirm the fix and no regressions.

### Refactoring

1. **Ensure coverage**: Confirm existing tests pass before refactoring.
2. **Change incrementally**: One refactoring step at a time.
3. **Verify after each step**: Run tests between every change.
4. **Do not change behavior**: If tests break, the refactoring introduced a bug — fix it before continuing.

## Anti-Patterns to Avoid

- Generating an entire file from scratch when only a few lines need changing.
- Writing code without checking existing patterns/conventions in the project.
- Making multiple changes before running any verification.
- Ignoring test failures and continuing to the next step.
- Guessing at file contents instead of reading them.
- Using `bash cat` or `bash grep` when the built-in `read`/`grep`/`find` tools are available.
- Generating more than 300 lines in a single operation.
