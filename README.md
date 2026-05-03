# Research Copilot

<p align="center">
  <a href="https://github.com/daidong/PiPilot/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/daidong/PiPilot?style=for-the-badge&color=14B8A6&labelColor=1f2937&label=LATEST"></a>
  <a href="https://github.com/daidong/PiPilot/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/daidong/PiPilot?style=for-the-badge&color=eab308&labelColor=1f2937&logo=github&logoColor=white&label=STARS"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/daidong/PiPilot?style=for-the-badge&color=14B8A6&labelColor=1f2937&label=LICENSE"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/PLATFORMS-macOS_%7C_Windows_%7C_Linux-7c3aed?style=for-the-badge&labelColor=1f2937">
</p>

<p align="center">
  <img alt="macOS signed" src="https://img.shields.io/badge/MACOS-SIGNED_%26_NOTARIZED-14B8A6?style=for-the-badge&labelColor=1f2937&logo=apple&logoColor=white">
  <img alt="Auto-update" src="https://img.shields.io/badge/AUTO--UPDATE-ENABLED-14B8A6?style=for-the-badge&labelColor=1f2937">
  <img alt="Electron" src="https://img.shields.io/badge/ELECTRON-DESKTOP-2dd4bf?style=for-the-badge&labelColor=1f2937&logo=electron&logoColor=white">
  <a href="https://github.com/daidong/PiPilot/discussions"><img alt="Discussions" src="https://img.shields.io/badge/COMMUNITY-DISCUSSIONS-7c3aed?style=for-the-badge&labelColor=1f2937&logo=github&logoColor=white"></a>
</p>

An AI-powered desktop research assistant for scientists and academics. Literature search, data analysis, academic writing, cross-project paper memory, and project management — powered by your **ChatGPT Pro / Claude Max subscription** (or an API key), all in one desktop app.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (agent runtime) + Electron + React.

<p align="center">
  <a href="https://youtu.be/aE0-2O9_ALE" title="Watch the demo on YouTube">
    <img alt="Research Copilot demo — click to play on YouTube" src="https://img.youtube.com/vi/aE0-2O9_ALE/maxresdefault.jpg" width="100%" />
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/aE0-2O9_ALE">▶ Watch the demo on YouTube</a>
</p>

## What's new in 0.3.4

- 🔐 **Signed & notarized macOS builds** — first launch from a fresh download is now zero-warning. Apple Silicon and Intel both pass Gatekeeper out of the box.
- ⤴️ **In-app auto-update** — the app checks GitHub Releases on startup and every 4 hours. When a new version finishes downloading, a small `Update ready · Restart` pill appears in the StatusBar; one click and the app relaunches into the new build.
- 🧹 **One-time migration**: pre-0.3.4 users need to download once more from the [latest release](https://github.com/daidong/PiPilot/releases/latest) to migrate to the auto-updating channel. Every subsequent release reaches you automatically.

---

## Signing in (READ THIS FIRST)

Research Copilot supports three auth methods and automatically prefers the cheapest working one. When multiple are configured, priority is:

**ChatGPT subscription → Claude subscription → OpenAI API key → Anthropic API key**

First-launch model selection follows this order; you can override it any time from the model selector.

### Option 1 — Sign in with a subscription (recommended)

The fastest and most cost-predictable path. No API key needed, no metered billing surprises.

- **ChatGPT Pro / Plus** — click the model selector, pick a `GPT-5.4 (sub)` entry, sign in via OAuth. Uses the official ChatGPT subscription endpoint.
- **Claude Pro / Max** — click the model selector, pick a `Claude … (sub)` entry, sign in via OAuth. Uses the official Anthropic subscription endpoint. *(Previously gated behind `ENABLE_CLAUDE_SUB=1`; enabled by default since `0235a3f`.)*

Credentials are stored in the OS keychain via pi-ai's OAuth helper and refreshed automatically.

### Option 2 — Bring an API key

Open the unified settings panel (**Cmd+.**) and paste a key, or set it in your shell profile:

```bash
export OPENAI_API_KEY="sk-..."           # GPT-5.4, GPT-4o, o-series
export ANTHROPIC_API_KEY="sk-ant-..."    # Claude Opus / Sonnet / Haiku
```

Keys entered in the UI are saved to `~/.research-copilot/config.json`.

### Optional supporting keys

| Key | Enhances | Without it |
|-----|----------|------------|
| `BRAVE_API_KEY` | `web_search` tool — general web search via Brave | Falls back gracefully to arXiv-only academic search |
| `OPENROUTER_API_KEY` | `scientific-schematics` skill — AI-generated diagrams | The schematics skill fails when invoked; all other skills still work |

> **Semantic Scholar, arXiv, OpenAlex, DBLP**: used for literature search and **do not require API keys**. They work out of the box.

---

## How is Research Copilot different from Claude Cowork?

[Claude Cowork](https://www.anthropic.com/product/claude-cowork) is Anthropic's general-purpose autonomous agent for knowledge workers — it handles file organization, document drafting, and data extraction across everyday desktop tasks.

Research Copilot is a **vertical tool built specifically for academic research**. The two differ in depth, not surface:

| | Claude Cowork | Research Copilot |
|---|---|---|
| **Scope** | Horizontal — any knowledge work | Vertical — academic research lifecycle |
| **Literature** | No academic search | Multi-source search (Semantic Scholar, arXiv, OpenAlex, DBLP) with relevance scoring, coverage tracking, and citation tracing |
| **Paper management** | Processes files you already have | Structured artifact system with DOI, bibtex, citeKey, citation counts, and relevance metadata |
| **Academic writing** | Generic document drafting | Venue-specific templates (NeurIPS, ICML, journals), IMRAD structure, LaTeX, citation verification (never hallucinated) |
| **Grant writing** | None | Agency-specific guidance (NSF, NIH, DOE, DARPA, NSTC) with compliance checklists |
| **Data analysis** | Extracts data from documents | LLM-generated Python scripts with statistical modeling, matplotlib/seaborn visualization, and output manifests |
| **Domain skills** | General capabilities | 14 pluggable research skills (scientific writing, visualization, scholar evaluation, paper revision, slides, etc.) — extensible via Markdown |
| **Cross-project memory** | Per-conversation only | Background **Paper Wiki** agent that indexes every paper you touch into a local, concept-organized knowledge base shared across all your projects |
| **Knowledge persistence** | Not specified | Artifact store, session summaries, cross-session memory, @-mention references |
| **Auth** | Claude subscription only | **ChatGPT Pro / Claude Max** via OAuth *or* OpenAI / Anthropic API keys — priority-ordered so subscriptions are preferred automatically |
| **Openness** | Closed-source commercial product | Open source (MIT) — fully customizable |

**In short**: Claude Cowork is like a smart office assistant. Research Copilot is like a lab partner who knows how to search literature, run stats, write papers, and apply for grants.

---

## Features

### AI Chat with Coding & Writing Tools
Converse with an AI research assistant that can read, write, and edit files in your workspace. It generates LaTeX manuscripts, creates publication-quality figures, runs Python analysis scripts, and manages your project files — all through natural language.

### Multi-Source Literature Search
Search across **Semantic Scholar**, **arXiv**, **OpenAlex**, and **DBLP** simultaneously. Papers are scored for relevance, deduplicated, and organized in a searchable table. Quick actions let you do deep searches, fill coverage gaps, or trace citation chains.

![Literature Management](docs/literature.png)

### Cross-Project Paper Wiki
A background agent that turns every paper you've ever opened into a **local, concept-organized knowledge base** shared across all your projects. Each paper gets a summarized wiki page; recurring concepts get their own pages with back-references to the papers that mention them. The wiki is searchable from any project via `wiki_search` / `wiki_get` / `wiki_coverage` tools, so the AI can recall and cite work from earlier projects without you re-feeding it context.

The wiki runs offline and **is disabled by default** — it consumes LLM tokens (roughly 8K–25K input / 2K–4K output per paper), so you opt in from the Settings panel and pick a model you're comfortable paying for. Subscription-backed models are recommended; an "Auto" option follows the system-wide priority (sub before API key). Identity drift across DOI/arXiv/title lookups is reconciled automatically so papers don't get reprocessed.

### Extensible Skills System
Skills are lazy-loaded knowledge modules that give the AI domain expertise. The app ships with **15 builtin skills** covering academic writing (paper-writing, paper-revision, research-grants, rewrite-humanize, scientific-writing, scholar-evaluation), visualization (matplotlib, seaborn, scientific-schematics, scientific-visualization), presentations (academic-marp-slides, teaching-marp-slides), research ideation (brainstorming, creative-thinking), and general coding. You can also add your own project-specific skills as plain Markdown files.

### File Attachments in Chat
Attach files directly in the chat input via the paperclip button, drag & drop, or paste. Supported formats:

| Format | How it's processed |
|--------|--------------------|
| **Images** (PNG, JPEG, GIF, WebP) | Sent as vision content — the LLM sees the image visually |
| **Text files** (CSV, MD, TXT, JSON, XML, HTML) | Read directly and injected as text into the message |
| **Documents** (PDF, DOCX) | Converted to text via `markitdown` CLI (with `pypdf` fallback for PDF), then injected into the message |

> **Note**: Document conversion requires `markitdown` (`pip install markitdown[all]`) or `pypdf` (`pip install pypdf`) for PDF/DOCX files. Text-based formats work out of the box with no extra dependencies.

> **Future plan**: The underlying Anthropic API supports native PDF document blocks (preserving layout, tables, and embedded images). Once the pi-mono agent runtime adds `DocumentContent` support, PDF attachments will be upgraded to use native API handling instead of text extraction.

### More
- **Document conversion** — PDF / DOCX / PPTX / XLSX → Markdown (via agent tools)
- **Python data analysis** — LLM-generated analysis with matplotlib/seaborn visualization
- **Artifact management** — notes, papers, data, web content with CRUD tools
- **@-mention system** — reference entities inline in chat
- **Session continuity** — automatic context compaction and session summaries
- **Integrated terminal** — run commands without leaving the app
- **LLM providers** — OpenAI and Anthropic, via ChatGPT Pro / Claude Max subscription OAuth *or* API keys, with automatic priority selection
- **Unified settings panel** — `Cmd+.` opens a single pane for models, API keys, research presets, data-analysis timeouts, and the Paper Wiki agent

## Installation

Prebuilt binaries for **macOS / Linux / Windows** are published on every tagged release.
👉 **[Download the latest release](https://github.com/daidong/PiPilot/releases/latest)** or use the one-liner installer for your OS:

### macOS (Apple Silicon & Intel)

The macOS build is **signed with a Developer ID certificate and notarized by Apple** — first launch has zero Gatekeeper warning. Just download the `.dmg`, drag to Applications, and double-click.

```bash
# or via the install script (auto-detects arm64 / x64):
curl -fsSL https://raw.githubusercontent.com/daidong/PiPilot/main/install.sh | bash
```

### Linux (x86_64)

```bash
curl -fsSL https://raw.githubusercontent.com/daidong/PiPilot/main/install.sh | bash
```

Installs the AppImage to `~/.local/share/research-copilot/`, symlinks `~/.local/bin/research-copilot`, and writes a `.desktop` entry. Ubuntu 22.04+ needs `libfuse2`:

```bash
sudo apt install libfuse2
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/daidong/PiPilot/main/install.ps1 | iex
```

Downloads and runs the NSIS installer. SmartScreen still shows "Unrecognized app" — click **More info → Run anyway**. (Windows code signing is on the roadmap.)

### Updating

**0.3.4 and later** — the app updates itself. It checks GitHub Releases in the background and shows a small `Update ready · Restart` button in the status bar when a new build is downloaded. One click restarts into the new version. No more re-running the installer.

**Pre-0.3.4** — please download the latest installer one more time to migrate to the auto-updating channel. After that, you're set.

### Build from source

```bash
git clone https://github.com/daidong/PiPilot.git
cd PiPilot
npm install
npm run dev          # dev mode with hot reload
# or:
cd app && npm run pack:mac      # macOS DMG (arm64 + x64)
cd app && npm run pack:win      # Windows NSIS installer
cd app && npm run pack:linux    # Linux AppImage + .deb
cd app && npm run pack:all      # all three (requires native runners or VMs)
```

Prerequisites for source builds: **Node.js ≥ 18**, **npm ≥ 9**, and **Python 3** (optional, for data analysis and figure generation).

### Authentication

On first launch, open the model selector (top of the chat pane) and either **sign in** with ChatGPT Pro / Claude Max via OAuth, or paste an `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` into the unified settings panel (`Cmd+.`). Everything else is optional.

See [Signing in](#signing-in-read-this-first) above for the full breakdown and optional supporting keys.

### Build for Production

```bash
npm run build
```

## Project Structure

```
app/                  # Electron desktop application
├── src/main/         # Main process (IPC handlers, app lifecycle)
├── src/preload/      # Context bridge (renderer ↔ main)
└── src/renderer/     # React UI (components, Zustand stores)

lib/                  # Research agent logic (framework-independent)
├── agents/           # Coordinator agent + prompt registry
├── commands/         # Artifact CRUD, search, enrichment
├── mentions/         # @-mention parsing and resolution
├── memory-v2/        # Artifact storage and session summaries
├── skills/           # Skills system (loader + builtin skills)
└── tools/            # Research tools (web, literature, data, convert)

shared-electron/      # Reusable Electron IPC utilities
shared-ui/            # Shared React components and stores
```

## Adding Custom Skills

Create a Markdown file at `<your-workspace>/.pi/skills/<name>/SKILL.md`:

```markdown
---
id: my-skill
name: My Skill
shortDescription: Brief description of what this skill does
---

Summary loaded at startup.

## Procedures
Detailed guidance loaded on demand when the skill is activated.
```

Skills are auto-discovered from three locations (later overrides earlier):
1. `lib/skills/builtin/` — shipped with the app
2. `~/.research-pilot/skills/` — user-global
3. `<workspace>/.pi/skills/` — project-specific

## Configuration

Research Copilot stores its data in the workspace under `.research-pilot/`:

```
.research-pilot/
├── artifacts/          # Notes, papers, data, web content
│   ├── notes/
│   ├── papers/
│   ├── data/
│   └── web-content/
└── memory-v2/
    └── session-summaries/
```

## Community & Support

- **[Discussions](https://github.com/daidong/PiPilot/discussions)** — questions, ideas, usage tips, and general Q&A
- **[Issues](https://github.com/daidong/PiPilot/issues)** — bug reports and feature requests
- **[Wiki](https://github.com/daidong/PiPilot/wiki)** — setup walkthroughs, troubleshooting, and how-tos

## License

[MIT](LICENSE)
