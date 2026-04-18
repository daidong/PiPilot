Common questions and fixes. If yours isn't here, try [Discussions](https://github.com/daidong/PiPilot/discussions) or [Issues](https://github.com/daidong/PiPilot/issues).

## Authentication

### Which auth method does Research Copilot use?

It automatically prefers the cheapest working one, in this order:

1. ChatGPT subscription
2. Claude subscription
3. OpenAI API key
4. Anthropic API key

You can override the pick any time from the model selector.

### My API keys disappear when I switch tabs or close the Settings dialog

This was a bug ([#6](https://github.com/daidong/PiPilot/issues/6)) fixed in a recent release. After you paste a key, click the **Save & Continue** button at the bottom of the API Keys tab before switching tabs. If you're on an older build, update to the latest version.

### Where are my API keys stored?

In `~/.research-copilot/config.json`. Subscription OAuth tokens are stored in the OS keychain.

### Sign-in with ChatGPT / Claude failed

- Make sure your default browser can reach the provider.
- Try again — OAuth tokens occasionally time out on the first attempt.
- As a fallback, paste an API key in the **API Keys** tab.

## Features

### Why can't the agent read my PDF?

PDF and DOCX attachments are converted to text via the `markitdown` CLI, with a `pypdf` fallback for PDF. Install one of:

```bash
pip install 'markitdown[all]'   # preferred — handles PDF, DOCX, PPTX, XLSX
pip install pypdf               # PDF-only fallback
```

Text-based formats (CSV, MD, TXT, JSON, XML, HTML) work with no extra dependencies. Images are sent directly as vision content.

### What does the Paper Wiki cost?

Roughly **8K–25K input / 2K–4K output tokens per paper**. It's disabled by default — turn it on from Settings → Paper Wiki and pick a model you're comfortable with. Subscription-backed models are recommended; the "Auto" option follows the system-wide priority.

### Web search isn't finding anything general

General web search needs a `BRAVE_API_KEY`. Without it, search falls back to arXiv-only academic search. Add a key in Settings → API Keys (the free Brave tier is usually enough).

### AI-generated diagrams don't work

The `scientific-schematics` skill needs `OPENROUTER_API_KEY`. All other skills work without it.

### How do I add my own skill?

Drop a file at `<workspace>/.pi/skills/<name>/SKILL.md`. See [Getting Started → Add custom skills](Getting-Started#5-add-custom-skills-optional).

## Data and privacy

### Where does Research Copilot store my data?

Per-workspace, under `<workspace>/.research-pilot/`:

```
.research-pilot/
├── artifacts/          # notes, papers, data, web-content, tool-output
└── memory-v2/
    └── session-summaries/
```

Global config (API keys, OAuth tokens) lives in `~/.research-copilot/`.

### Does Paper Wiki share data across my projects?

Yes — that's the point. The wiki is indexed once globally and reachable from any workspace via the `wiki_search` / `wiki_get` / `wiki_coverage` tools. It runs offline against your local files.

## Troubleshooting

### App won't launch after install

- Confirm Node.js ≥ 18 and npm ≥ 9.
- Try a clean install:
  ```bash
  npm uninstall -g research-copilot
  npm install -g research-copilot
  ```
- On Apple Silicon, make sure you're running the arm64 build.

### Build warnings about dynamic imports

Expected and benign — they come from the three-target build (main / preload / renderer) and don't affect runtime.

### "No model available" or the model selector is empty

Usually means no auth succeeded. Open Settings → API Keys and either paste a key or sign in with a subscription. Restart the app if the selector doesn't refresh.

### Something else is broken

Open an [Issue](https://github.com/daidong/PiPilot/issues) with:
- OS + version
- Research Copilot version (in About / `package.json`)
- A minimal reproduction
- Relevant logs (open DevTools with **Cmd + Option + I**)
