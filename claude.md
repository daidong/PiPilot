always reply to me staring with "Hey, Captain!"

Design axiom: The system does not pursue complex architecture to guarantee quality. Instead, it pursues minimum discipline to guarantee survival + evidence-driven incremental improvement.

# Research Copilot Development Guide

## Project Overview

Research Copilot is an AI-powered research assistant desktop application built on:
- **pi-mono** (`@mariozechner/pi-coding-agent`) — agent runtime, LLM integration, session management
- **Electron + React + Zustand + TailwindCSS** — desktop UI
- **Custom research tools** — artifact management, literature search, data analysis

## Project Structure

```
app/                      # Electron desktop application
├── src/main/
│   ├── index.ts          # Electron app lifecycle
│   └── ipc.ts            # IPC handlers, agent setup
├── src/preload/
│   └── index.ts          # Context bridge (ElectronAPI)
└── src/renderer/
    ├── App.tsx            # Root component
    ├── stores/            # Zustand stores (chat, entity, session, ui, activity, usage, progress, skill)
    └── components/        # React components (layout, left, center, right)

lib/                      # Research agent logic (framework-independent)
├── agents/
│   ├── coordinator.ts    # Main agent orchestrator
│   └── prompts/
│       └── index.ts      # Prompt registry (bundler-safe inline strings)
├── commands/             # Artifact CRUD, search, enrichment, session summaries
├── mentions/             # @-mention parsing, resolution, candidate generation
├── memory-v2/            # Artifact storage (JSONL), session summaries
├── skills/               # Skills system (SKILL.md format)
│   ├── builtin/          # 12 builtin skills (see below)
│   ├── data-analysis/    # Python analysis guidance
│   └── loader.ts         # Runtime skill discovery
├── tools/                # Research tools (pi-mono AgentTool format)
│   ├── index.ts          # createResearchTools() factory
│   ├── web-tools.ts      # web_search + web_fetch
│   ├── literature-search.ts  # Multi-source literature pipeline
│   ├── data-analyze.ts   # LLM-generated Python analysis
│   ├── convert-document.ts   # PDF/DOCX → Markdown
│   ├── entity-tools.ts   # artifact-create, artifact-update, artifact-search
│   ├── skill-tools.ts    # load_skill tool
│   ├── tool-utils.ts     # toAgentResult adapter
│   └── types.ts          # ResearchToolContext
└── types.ts              # Shared types (Artifact, ProjectConfig, etc.)

shared-electron/          # Reusable Electron IPC utilities
shared-ui/                # Shared React components and Zustand stores
```

### Builtin Skills (12)

| Category | Skills |
|----------|--------|
| Writing & Review | paper-writing, research-grants, rewrite-humanize, scholar-evaluation, scientific-writing |
| Visualization | matplotlib, seaborn, scientific-schematics, scientific-visualization |
| Research | brainstorming-research-ideas, creative-thinking-for-research |
| Development | coding |

## Key Patterns

### IPC Pattern
```
Renderer (React + Zustand) → IPC invoke → Preload bridge → Main process → Agent/Commands → IPC response → Zustand update → React re-render
```

### Agent Layer (pi-mono)
The coordinator in `lib/agents/coordinator.ts` creates a pi-mono Agent with:
- Built-in coding tools from `@mariozechner/pi-coding-agent` (read, write, edit, bash, grep, find)
- Custom research tools via `createResearchTools()` from `lib/tools/index.ts`
- Prompt registry in `lib/agents/prompts/index.ts` (10 prompts as key-value entries)
- Intent detection (rule-based + optional LLM) for dynamic skill loading
  - Intent labels: `literature`, `data`, `writing`, `critique`, `web`, `citation`, `grants`, `docx`, `general`
- beforeToolCall/afterToolCall hooks for activity tracking
- Skills discovered at runtime from builtin + user + workspace directories

### Artifact Storage
- Stored in `.research-pilot/artifacts/{notes,papers,data,web-content,tool-output}/`
- Session summaries in `.research-pilot/memory-v2/session-summaries/`
- Entity types: `'note' | 'paper' | 'data' | 'web-content' | 'tool-output'`

### Configuration priority (Settings UI > shell env)

For every config slot that has both a Settings UI surface **and** a shell-env counterpart, the order is:
**explicit override (per call) > value saved in Settings UI > shell env > built-in default.**

Concrete instances:
- **API keys / secrets** (`AWS_ACCESS_KEY_ID`, `MODAL_TOKEN_ID`, `OPENAI_API_KEY`, etc.) — `shared-electron/api-key-loader.ts:applyApiKeysToEnv()` writes config values into `process.env` on startup, overwriting stale shell exports. The Settings UI is the user's authoritative signal; env is the fallback when nothing has been saved (CI / first-run / scripted launches).
- **AWS region / profile** — `lib/aws/credentials.ts:AwsCredentialProvider.resolve()` uses the same chain: per-call `opts.region` → `settings.region` → `process.env.AWS_REGION` → `process.env.AWS_DEFAULT_REGION`.

Inverting this order is a footgun: a user who saved fresh keys via the UI would still get stale shell-exported keys on the next launch and never know why "Test connection" looked right but operations talked to the wrong account. We hit this with AWS Phase 1 — the regression test is `shared-electron/__tests__/api-key-priority.test.ts`.

**Out of scope for this rule:**
- Dev/debug flags (`RESEARCH_COPILOT_DEBUG`, `ENABLE_COMPUTE_STUB`, `ELECTRON_RENDERER_URL`) — intentionally env-only, no UI surface.
- `~/.aws/credentials` profile path overrides (`AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`) — env-only by design (they point to disk locations the UI never persists).

## Development Commands

```bash
# From root
npm install              # Install all workspace dependencies
npm run dev              # Dev mode with hot reload
npm run build            # Production build
npm run clean            # Remove build artifacts

# From app/
npm run pack             # Build + package macOS DMG
npm run icon:generate    # Regenerate app icon (Python)
```

## Adding New Research Tools

Define tools using pi-mono's AgentTool interface in `lib/tools/`, then register in `lib/tools/index.ts`:

```typescript
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'

export function createMyTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'my-tool',
    label: 'My Tool',
    description: 'What it does',
    parameters: Type.Object({
      input: Type.String({ description: 'Input parameter' })
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      // ... tool logic ...
      return toAgentResult('my-tool', { success: true, data: result })
    }
  }
}
```

Then add to `createResearchTools()` in `lib/tools/index.ts`.

## Adding New Skills

Create a markdown file in `lib/skills/builtin/<name>/SKILL.md` (or workspace `.research-pilot/skills/<name>/SKILL.md`):

```markdown
---
id: my-skill
name: My Skill
shortDescription: Brief description
---

Summary loaded at startup.

## Procedures
Detailed guidance loaded on demand.
```

Skills are auto-discovered from three locations (later overrides earlier):
1. `lib/skills/builtin/` — shipped with the app
2. `~/.research-pilot/skills/` — user-global
3. `<workspace>/.research-pilot/skills/` — project-specific

## Adding New Prompts

Add prompt strings to `lib/agents/prompts/index.ts` as key-value entries in the `prompts` record. Access via `loadPrompt('key-name')`.

Current prompts: `coordinator-system`, `data-analysis-system`, `data-analysis-tasks`, `data-code-template`, `literature-planner-system`, `literature-reviewer-system`, `literature-summarizer-system`, `data-analyzer-system`, `writing-outliner-system`, `writing-drafter-system`.

## Signing, Notarization & Auto-Update

The macOS build is signed with a Developer ID Application certificate, notarized via Apple's notarytool, and stapled — first-launch has zero Gatekeeper warning. Inside the app, `electron-updater` checks GitHub Releases on startup and every 4 hours against `DIR-LAB/Research-Pilot`; when an update has finished downloading the StatusBar shows a small `Update ready · Restart` pill. All update logic is gated behind `app.isPackaged`, so it stays inert during `npm run dev`.

### Dual-repo distribution

Source code lives in a **private** repo (`daidong/PiPilot`); user-facing assets live in a separate **public** repo (`DIR-LAB/Research-Pilot`). The public repo holds only distribution artifacts — release `.dmg`/`.exe`/`.deb` files, the marketing website on its `gh-pages` branch, and community Issues/Discussions. No source code is mirrored to the public repo.

Code touchpoints:
- `app/package.json` → `build.publish.owner` = `DIR-LAB`, `repo` = `Research-Pilot` (electron-builder + electron-updater target)
- `.github/workflows/release.yml` → uses `PUBLIC_REPO_TOKEN` (PAT with `repo` write scope on the public repo) instead of the default `GITHUB_TOKEN`
- `.github/workflows/deploy-website.yml` → builds `website/` and pushes the result to `DIR-LAB/Research-Pilot:gh-pages` via `peaceiris/actions-gh-pages`
- `website/astro.config.mjs` → `site: https://dir-lab.github.io`, `base: /Research-Pilot/`
- `website/src/pages/index.astro` → fetches releases from `DIR-LAB/Research-Pilot`
- `install.sh` / `install.ps1` / root `package.json` / `README.md` / public wiki community links → all point at the public repo
- Source-only links (wiki blob/main references to private RFCs, branch-protection examples below) → keep `daidong/PiPilot` since only collaborators read those surfaces

Required GitHub Secrets on the **private** repo:
- `PUBLIC_REPO_TOKEN` — PAT with `repo` write scope on `DIR-LAB/Research-Pilot` (lets release.yml upload artifacts and deploy-website.yml push to `gh-pages`)
- existing macOS signing secrets unchanged (`MAC_CERTS`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)

### Day-to-day development
Nothing extra. `npm install && npm run dev` is unchanged. The auto-updater is dormant in dev (no network calls, no pill, no events). To preview the StatusBar pill while developing, set the store directly in DevTools:
```js
window.__zustand_useUpdateStore?.getState().setState({ status: 'ready', version: '0.3.99', current: '0.3.3' })
```
…or import `useUpdateStore` and do the same from a temporary component.

### Local `pack` with signing (release maintainers only)
Required only when reproducing a signed build locally (rare — CI handles real releases). Create `app/.env.local` (gitignored) with:
```
APPLE_ID=<developer apple id email>
APPLE_APP_SPECIFIC_PASSWORD=<from appleid.apple.com>
APPLE_TEAM_ID=<10-char team id>
CSC_LINK=<absolute path to Developer ID .p12>
CSC_KEY_PASSWORD=<.p12 password>
```
Then `set -a && source .env.local && set +a && npm run pack`. Verify with:
```
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Research Copilot.app"
xcrun stapler validate "release/mac-arm64/Research Copilot.app"
spctl -a -vvv -t install "release/mac-arm64/Research Copilot.app"   # expect: source=Notarized Developer ID
```

For unsigned local packs (demos, smoke tests) skip the env file and run `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`.

### Release flow
Bump `app/package.json` version, commit, tag `vX.Y.Z`, push the tag. `release.yml` reads signing credentials from GitHub Secrets (`MAC_CERTS`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), builds all three platforms, signs+notarizes macOS, and uploads to a draft GitHub Release. Manually publish the draft when the artifacts look right; `deploy-website.yml` listens for `release: published` and rebuilds the marketing site so download links stay current.

## Main Branch Protection

The `main` branch is protected via GitHub branch protection rules. The intent is "fail-safe by default, fast path for the maintainer":

- **Required status check**: `build` (the `ci.yml` job) must pass before a PR can merge
- **Strict mode**: PR branches must be up-to-date with `main` before merging
- **Required approvals**: 0 — solo maintainer doesn't need to self-approve
- **Force pushes**: blocked
- **Deletions**: blocked
- **`enforce_admins: false`**: admins (the maintainer) bypass all rules, so direct `git push origin main` and tag pushes still work for routine version bumps and emergency fixes

This means the day-to-day release flow above is unchanged. The protection only catches accidents: a stray `git push --force`, a leaked token, or a misconfigured automation.

### Inspecting and modifying protection
```bash
# View current settings
gh api repos/daidong/PiPilot/branches/main/protection

# Update (re-PUT the full payload)
gh api -X PUT repos/daidong/PiPilot/branches/main/protection --input rules.json

# Temporarily disable (e.g. to rewrite history) — remember to re-enable
gh api -X DELETE repos/daidong/PiPilot/branches/main/protection
```

If a PR is stuck because the `build` check name changed, update `required_status_checks.contexts` to match the new job name from `ci.yml`.
