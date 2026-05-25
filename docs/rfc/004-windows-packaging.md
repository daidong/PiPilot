# RFC-004: Windows Packaging

**Status:** Draft (2026-04-11)
**Affects:** Distribution to non-macOS users, CI/CD pipeline

## Goal

Produce a Windows installer (`.exe` via NSIS or portable `.zip`) that non-programmer users can download and run directly, with the same core functionality as the macOS build minus the integrated terminal.

## Current State

- Electron + electron-builder already in the project; `pack` script targets macOS only (`--mac`)
- `node-pty` moved to `optionalDependencies` — Windows build skips it if native compilation fails
- `terminal.ts` gracefully degrades: spawn returns a clear error message when node-pty is absent
- pi-mono has solid Windows support (see assessment below)

## What Needs to Be Done

### 1. electron-builder Windows config (small)

Add `win` target to `app/package.json` `build` section:

```jsonc
"win": {
  "target": [
    { "target": "nsis", "arch": ["x64"] }
    // optionally add "portable" for a no-install .exe
  ],
  "icon": "build/icon.ico"   // needs .ico format, not .png
}
```

Add a pack script:

```jsonc
"pack:win": "electron-vite build && electron-builder --win"
```

### 2. App icon in .ico format (trivial)

macOS uses `.icns` / `.png`; Windows requires `.ico`. Generate with ImageMagick or the existing `icon:generate` Python script. Electron-builder can also auto-convert from a 256x256+ PNG, but an explicit `.ico` is more reliable.

### 3. GitHub Actions CI for Windows build (medium)

Cannot cross-compile native modules from macOS to Windows reliably. Set up a GitHub Actions workflow:

```yaml
# .github/workflows/build-win.yml
name: Build Windows
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: cd app && npx electron-vite build && npx electron-builder --win
      - uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: app/release/*.exe
```

Key points:
- `windows-latest` runner has Visual Studio Build Tools pre-installed, so `node-pty` will compile if we ever want it
- If `node-pty` compilation fails (e.g. missing Python), the build still succeeds because it's in `optionalDependencies`
- For signed builds, add code-signing certificate as a GitHub secret later

### 4. Hide terminal UI on Windows (small, optional)

The terminal panel already shows an error message when node-pty is unavailable. For a cleaner UX, optionally hide the terminal toggle button entirely:

```typescript
// LeftSidebar.tsx — hide terminal button when platform is win32
// Expose platform info via preload or environment variable
```

This is optional because the current error message is adequate. Can be done later based on user feedback.

## pi-mono Windows Compatibility (verified)

| Component | Status | Notes |
|-----------|--------|-------|
| read / write / edit / ls tools | Full | Pure Node.js fs API |
| bash tool | Full | Auto-detects Git Bash / MSYS2 / WSL; clear error if none found |
| grep tool | Full | Uses ripgrep; auto-downloads Windows binary |
| find tool | Full | Uses Node.js globSync + fd; auto-downloads Windows binary |
| Process management | Full | Uses `taskkill /F /T /PID` on Windows |
| Path handling | Full | `toPosixPath()` converts backslashes |
| Line endings | Full | Detects and preserves CRLF / LF |

**User prerequisite:** Git for Windows must be installed (provides bash.exe, tar, and core Unix utilities). This is the only external dependency.

## Known Tricks and Pitfalls

### Path separator issues

Windows uses `\` as path separator. Most of the codebase uses Node.js `path` module correctly, but any hardcoded `/` in path construction (e.g. template strings building file paths) will break. Audit with:

```bash
grep -rn "'/'" lib/ app/src/ --include='*.ts' | grep -v node_modules | grep -v '//'
```

Pay special attention to:
- `lib/memory-v2/` — JSONL file paths
- `lib/commands/` — artifact storage paths
- `lib/tools/` — tool output paths

### Shell commands in research tools

Some tools (e.g. `data-analyze.ts`) spawn Python via `child_process`. On Windows:
- Python may be `python` or `python3` or `py` — need to detect
- Shebang lines (`#!/usr/bin/env python3`) are ignored
- Script paths with spaces need quoting

### ASAR packaging and extraResources

electron-builder packs `node_modules` into an `asar` archive by default. Native modules and skill files are excluded via `extraResources`. Verify that:
- Skill markdown files are correctly extracted (already configured in `extraResources`)
- The `resourcesPath` resolution works on Windows (different directory structure than macOS `.app` bundle)

### Auto-updater (future)

For distributing updates to non-technical users, consider `electron-updater` with GitHub Releases as the update source. This is not needed for initial distribution but becomes important quickly once real users are on Windows.

### Code signing

Unsigned Windows apps trigger SmartScreen warnings ("Windows protected your PC"). For non-programmer users this is a significant barrier. Options:
- **Short term:** Instruct users to click "More info" → "Run anyway"
- **Long term:** Purchase an EV code signing certificate (~$200-400/year) or use Azure Trusted Signing

### First-launch experience

Non-programmer users need guidance for:
1. Installing Git for Windows (required for pi-mono bash tool)
2. Setting up API keys (Anthropic / OpenAI)
3. Understanding that the agent executes code on their machine

Consider adding a first-run setup wizard or at minimum a "Getting Started" dialog that checks prerequisites.

## Estimated Effort

| Task | Effort |
|------|--------|
| electron-builder win config + icon | 1 hour |
| GitHub Actions CI | 1-2 hours |
| Path separator audit + fixes | 2-3 hours |
| Python detection on Windows | 1 hour |
| Hide terminal UI (optional) | 30 min |
| First-run UX for Windows (optional) | 3-5 hours |
| Code signing (optional) | 2 hours + cert purchase |
| **Total (minimum viable)** | **~5 hours** |
| **Total (polished)** | **~12 hours** |

## Decision

Proceed with minimum viable Windows packaging (config + CI + path audit). Defer code signing and first-run wizard until we get feedback from initial Windows testers.
