This guide walks you from install to your first successful chat. If you hit a snag, check the [FAQ](FAQ) or open a [Discussion](https://github.com/daidong/PiPilot/discussions).

## 1. Install

### Option A — npm (recommended)

```bash
npm install -g research-copilot
research-copilot
```

### Option B — from source

```bash
git clone https://github.com/daidong/PiPilot.git
cd PiPilot
npm install
npm run dev
```

Requires **Node.js ≥ 18** and **npm ≥ 9**. Python 3 is optional but needed for data analysis and figure generation.

## 2. Sign in

Research Copilot picks the cheapest working auth method it finds, in this order:

**ChatGPT subscription → Claude subscription → OpenAI API key → Anthropic API key**

### Easiest: use a subscription (no API key, no metered billing)

1. Open the model selector at the top of the chat pane.
2. Pick a `GPT-5.4 (sub)` entry (ChatGPT Pro / Plus) **or** a `Claude … (sub)` entry (Claude Pro / Max).
3. Complete the OAuth flow in your browser.

Credentials are stored in the OS keychain and refreshed automatically.

### Alternative: paste an API key

1. Open the unified settings panel with **Cmd + .** (or click the gear icon).
2. Go to the **API Keys** tab.
3. Paste your key into `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
4. Click **Save & Continue**.

Keys are written to `~/.research-copilot/config.json`.

> **Tip:** at least one of Anthropic / OpenAI (API key or ChatGPT subscription) is required. The rest are optional.

### Optional supporting keys

| Key | What it enables | Without it |
|---|---|---|
| `BRAVE_API_KEY` | General web search via Brave | Falls back to arXiv-only academic search |
| `OPENROUTER_API_KEY` | AI-generated scientific diagrams (`scientific-schematics` skill) | Other skills still work |

Semantic Scholar, arXiv, OpenAlex, and DBLP work without any key.

## 3. Your first chat

1. Pick or create a workspace folder. Research Copilot stores artifacts and memory under `<workspace>/.research-pilot/`.
2. Type a request in the chat pane. A few starting points:
   - *"Find recent papers on quantum error correction and save the top 5 as notes."*
   - *"Load this CSV and plot a correlation heatmap."* (attach a file via the paperclip)
   - *"Draft the introduction for a NeurIPS-style paper on <topic>."*
3. The agent will use tools — literature search, web fetch, Python analysis, file edits — as needed. Tool calls appear in the chat so you can watch what it's doing.

## 4. Turn on Paper Wiki (optional but recommended)

Paper Wiki is a background agent that indexes every paper you touch into a **cross-project** knowledge base.

- Open settings (**Cmd + .**) → **Paper Wiki** tab.
- Pick a model you're comfortable paying for (subscription-backed is cheapest; "Auto" follows the system priority).
- Pick a speed preset.

Expect roughly 8K–25K input / 2K–4K output tokens per paper. It's disabled by default.

## 5. Add custom skills (optional)

Drop a Markdown file at `<workspace>/.pi/skills/<name>/SKILL.md`:

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
1. Shipped builtin skills
2. `~/.research-pilot/skills/` — user-global
3. `<workspace>/.pi/skills/` — project-specific

## Next steps

- Browse the [FAQ](FAQ) for common issues.
- See the [README Features section](https://github.com/daidong/PiPilot/blob/main/README.md#features) for a tour of literature search, data analysis, attachments, and more.
- Questions? Open a [Discussion](https://github.com/daidong/PiPilot/discussions).
