# RFC-016: Browser Automation Integration Research

Status: Research / Reference
Author: AgentFoundry Team
Created: 2026-02-12
Updated: 2026-02-13

---

## 1. Motivation

AgentFoundry needs browser automation capability for scenarios where `fetch` and search APIs are insufficient:

- **Paywalled content**: Accessing papers behind IEEE/ACM/Springer login walls using the user's existing subscriptions
- **JavaScript-rendered pages**: SPAs and dynamic content that raw HTTP cannot retrieve
- **Interactive workflows**: Multi-step browser tasks (search → filter → download)
- **Anti-bot protected sites**: Google, Google Scholar, and other sites that block programmatic HTTP requests

---

## 2. Web Capability Pyramid

AgentFoundry's web capabilities form a cost-performance pyramid. An agent should escalate from low to high cost:

```
            +-------------------+
            |     browser       |  Slow (5-30s), heavy, but can do anything
            |  (automation)     |  JS rendering, login sessions, interaction
            +-------------------+
            |      fetch        |  Fast (~500ms), lightweight, limited
            |  (HTTP request)   |  No JS rendering, no login, no interaction
            +-------------------+
            |   brave_search    |  Fastest (~200ms), search only
            |  (Search API)     |  Returns snippets + URL lists
            +-------------------+
```

| Dimension         | brave_search           | fetch            | browser (new)                    |
|-------------------|------------------------|------------------|----------------------------------|
| Nature            | Search engine API      | HTTP client      | Real browser                     |
| Returns           | Title + snippet + URL  | Raw HTML/JSON    | Page content + interactive       |
| JS rendering      | N/A                    | No               | Yes                              |
| Login sessions    | No                     | No               | Yes (user's Chrome profile)      |
| Anti-bot          | API, no issue          | Often blocked    | Depends on approach (see below)  |
| Speed             | ~200ms                 | ~500ms           | 5-30s                            |
| Cost              | API quota              | Near zero        | LLM tokens + Chrome resources    |
| Best for          | Discovery, search      | APIs, direct URL | Login walls, JS pages, interaction |

---

## 3. Anti-Bot Detection Landscape

### 3.1 How Anti-Bot Systems Detect Automation

Modern anti-bot systems (Cloudflare Turnstile, DataDome, PerimeterX) use layered detection:

| Signal | Description | Severity |
|--------|-------------|----------|
| `Runtime.enable` CDP detection | When CDP connects, `Runtime.enable` triggers detectable serialization behavior. Only ~5 lines of JS needed. Used by Cloudflare, DataDome. | Critical |
| `navigator.webdriver` flag | Set to `true` when browser is CDP-controlled | Basic (easily spoofed) |
| Playwright globals | `window.__playwright__binding__`, `window.__pwInitScripts` | Medium |
| CDP mouse coordinate bug | Screen coordinates and page coordinates match exactly — impossible with real humans | Medium |
| Browser fingerprint inconsistencies | Missing plugins, blank languages, canvas anomalies | Medium |
| Behavioral analysis | Mouse movement patterns, typing cadence, scroll behavior | Advanced |

### 3.2 Automation Approaches Compared

| Approach | Detection Risk | User Session | External API | Representative Projects |
|----------|---------------|-------------|-------------|------------------------|
| Playwright / Puppeteer (CDP) | **Very High** | Yes (possible via non-default profile; operationally fragile) | Yes | Playwright MCP, browser-use (legacy path) |
| Raw CDP (no framework) | **High** | Yes (possible via non-default profile; still CDP-signaled) | Yes | browser-use v2 (cdp-use) |
| Patchright / stealth plugins | **Medium** | Yes (same profile constraints as CDP) | Yes | browser-use + patchright |
| Extension via `chrome.debugger` | **Medium** | Yes | Varies | Nanobrowser, OpenClaw |
| Extension via content scripts only | **Low-Medium** | Yes | Need custom | chrome_page_fetcher_extension |
| Screenshot + OS-level inputs | **Very Low** | Yes (VM/local desktop) | Yes | Claude Computer Use (CUA) |

Key insights:
- **`chrome.debugger` still uses CDP under the hood**, so extension projects that rely on it are not immune to CDP-linked detection.
- **Content-script-only is risk reduction, not immunity**. It removes some CDP signatures, but does not guarantee bypass against behavior/fingerprint-based systems.

---

## 4. Existing Projects Analysis

### 4.1 browser-use (Python)

- **Repo**: https://github.com/browser-use/browser-use
- **Language**: Python only (no official TypeScript local-execution version)
- **Architecture**: Was Playwright-based, recently migrated to raw CDP (`cdp-use` library)
- **User profile support**: Yes — `chrome_instance_path`, `user_data_dir`, `cdp_url` config options
- **Anti-detection**: Weak locally. Cloud version has stealth + CAPTCHA solving
- **Known issues**: Users report Google CAPTCHA blocking (Issues #360, #1695)
- **Chrome v136+ caveat**: CDP flags are ignored for the default profile. Must use a non-default `--user-data-dir` (copying profile is one common implementation).
- **TypeScript options**:
  - `browser-use-sdk` (npm) — Official Cloud API client only, not local execution
  - `browser-use-node` (npm, community) — Unofficial rewrite, NOT production-ready
- **License**: MIT

### 4.2 Nanobrowser (Chrome Extension)

- **Repo**: https://github.com/nanobrowser/nanobrowser (~12K stars)
- **Language**: TypeScript (pnpm monorepo, React, Vite)
- **Architecture**: Chrome MV3 Extension. Side panel UI → Background service worker → Puppeteer-core via `ExtensionTransport` → `chrome.debugger` → CDP
- **Critical finding (research snapshot)**: Content script was minimal in inspected code paths; main interaction path used Puppeteer/CDP via `chrome.debugger`. This remains susceptible to CDP-linked detection.
- **External integration status**: Core extension repo does not expose a stable local HTTP/WebSocket control API by default. However, the organization now has `nanobrowser-mcp-host`, indicating an external MCP integration direction.
- **Agent architecture** (valuable for reference):
  - Two-agent system: Planner (strategic) + Navigator (tactical)
  - Planner runs every N steps and validates Navigator's completion claims
  - Navigator outputs structured actions with element indices
  - `buildDomTree.js` (~700 lines) assigns numeric indices to interactive elements — LLM references by index number
  - 20+ action types defined with Zod schemas
  - Multi-provider LLM support via LangChain (OpenAI, Anthropic, Gemini, etc.)
- **Security**: `<nano_untrusted_content>` wrapping, prompt injection detection, credential-fill prevention
- **Open feature requests**: MCP client support discussions exist (Issue #123). External-host maturity must be validated in PoC before adoption.
- **License**: Apache 2.0

### 4.3 OpenClaw (formerly Clawdbot)

- **Repo**: https://github.com/openclaw/openclaw (~68K stars)
- **Architecture**: Hub-and-spoke — WebSocket control plane on localhost, multiple client nodes
- **Browser control**: Two modes:
  1. Managed browser (CDP, standard automation)
  2. Chrome Extension relay — Extension uses `chrome.debugger` to attach to tabs, relays CDP messages through local HTTP bridge (`127.0.0.1:18792`)
- **Still uses CDP**: The extension's `chrome.debugger` bridges CDP messages. Not truly undetectable.
- **Security note**: Had a credential theft vulnerability via relay endpoint (patched)
- **License**: Apache 2.0

### 4.4 Claude for Chrome (Anthropic)

- **What**: Anthropic's official Chrome extension with browser control capabilities
- **How**: Runs in side panel, can see what user sees, click/fill/navigate
- **Architecture**: Uses Chrome Extension APIs (specific internals not publicly documented)
- **Availability**: Beta for paid plans (Pro, Max, Team, Enterprise)
- **Not open source**

### 4.5 Claude Computer Use (CUA)

- **Architecture**: Screenshot → Claude Vision analysis → OS-level mouse/keyboard commands (xdotool/AppleScript)
- **No CDP at all**: Interacts at OS level, not browser API level
- **Detection**: Extremely low — no browser automation artifacts. But runs in Docker/VM with its own fingerprint characteristics.
- **Speed**: Slow (screenshot + vision analysis per step)
- **Reference implementation**: Docker container with Xvfb + Mutter + Firefox/LibreOffice

### 4.6 Other Extension-Based Projects

| Project | Approach | Notes |
|---------|----------|-------|
| Puppeteer-Extension | Extension + HTTP controller | Wraps Puppeteer API in extension, no CDP debugging port |
| chrome_page_fetcher_extension | Extension + SSE commands | Content script only, designed for Cloudflare/Akamai bypass |
| On-Device Browser Agent (RunanywhereAI) | Extension + WebLLM | Fully local, no cloud, no API keys |
| HARPA AI | Extension + multiple LLMs | Commercial, 50+ features |
| Fellou AI | Standalone browser + anti-detect | Browser fingerprint spoofing, Eko 2.0 framework |

---

## 5. Integration Approaches for AgentFoundry

### 5.1 Approach A: MCP Bridge to browser-use (Python subprocess)

```
AgentFoundry (TS) → MCP Protocol → Python MCP Server → browser-use → Chrome
```

- Write a Python MCP Server wrapping browser-use
- AgentFoundry connects via `createStdioMCPProvider()`
- Follows existing `web` pack pattern (Brave Search MCP)
- **Pros**: Minimal framework changes, reuses browser-use's full capability
- **Cons**: Python dependency, CDP detection issues remain
- **Effort**: Low-Medium

### 5.2 Approach B: Chrome Extension + Local Bridge

```
AgentFoundry (TS) → HTTP/WebSocket (localhost) → Chrome Extension (content scripts) → DOM
```

- Build or fork a Chrome Extension that exposes a local API
- Prefer content-script-first interaction; avoid `chrome.debugger` where possible
- AgentFoundry controls it via local HTTP/WebSocket
- **Pros**: Lower detection surface than CDP-heavy approaches, user login sessions, clean architecture boundary
- **Cons**: Need extension distribution/updates, user install friction, content-script limitations (no cross-origin iframe, limited to DOM API)
- **Effort**: High

**Security baseline (mandatory for local bridge):**
- Bind control plane to loopback only (`127.0.0.1`), never LAN.
- Require per-session auth token with short TTL.
- Enforce strict origin allowlist for extension-to-host calls.
- Require user approval for high-risk actions (file download, form submit, external navigation).
- Record audited action log (who/when/which tab/which URL/which action).

### 5.3 Approach C: Playwright Native (TypeScript, skip browser-use)

```
AgentFoundry (TS) → Playwright (TS) → Chrome (CDP)
```

- Build browser tools directly with Playwright's TypeScript API
- Borrow Nanobrowser's patterns: `buildDomTree.js`, action schemas, Planner/Navigator architecture
- Package as a `browser()` pack with policies
- **Pros**: Pure TypeScript, no Python, good performance
- **Cons**: CDP detection, need to build LLM-driven page analysis
- **Effort**: Medium-High

### 5.4 Approach D: Computer Use (Screenshot + OS Input)

```
AgentFoundry (TS) → Screenshot capture → Claude Vision → xdotool/AppleScript → Chrome
```

- Use Claude's vision capabilities to analyze screenshots
- Drive browser via OS-level mouse/keyboard events
- **Pros**: Virtually undetectable, works with any application
- **Cons**: Very slow, high LLM cost (vision tokens), complex coordinate mapping
- **Effort**: Medium

### 5.5 Approach E: Hybrid (Recommended for future)

```
Tier 1: brave_search (discovery)
Tier 2: fetch (direct URL, APIs)
Tier 3: Browser backend selector
        - Extension-first for login/session-critical or anti-bot-sensitive flows
        - CDP backend for low-risk JS rendering / speed-sensitive tasks
Tier 4: Computer Use (heavily protected sites or repeated hard blocks)
```

- Agent learns to escalate through tiers based on failure signals
- Each tier is a separate tool/pack
- A `web-research` skill teaches the escalation strategy
- **Pros**: Optimal cost/performance, graceful degradation
- **Cons**: Most complex to implement
- **Effort**: High (but incremental)

---

## 6. Reusable Assets from Nanobrowser

Regardless of integration approach, these Nanobrowser components are directly valuable:

### 6.1 `buildDomTree.js` (~700 lines, pure JS)
- Recursive DOM traversal with Shadow DOM and iframe support
- Interactive element identification (tag-based, cursor-based, ARIA-based, event-listener-based)
- Numeric index assignment for LLM-friendly element references
- Viewport filtering, visibility checking, XPath generation
- Can be injected via Playwright's `page.evaluate()` or extension content scripts

### 6.2 Action Schema Design (Zod)
20+ browser actions with structured parameters:

```
done, search_google, go_to_url, go_back, click_element, input_text,
switch_tab, open_tab, close_tab, cache_content, scroll_to_percent,
scroll_to_top, scroll_to_bottom, previous_page, next_page,
scroll_to_text, send_keys, get_dropdown_options, select_dropdown_option, wait
```

### 6.3 Planner/Navigator Dual-Agent Pattern
- Planner: strategic planning, completion validation, non-web-task short-circuit
- Navigator: tactical browser interaction, multi-action chaining, DOM change detection
- Planning interval: configurable (default every 3 navigator steps)
- Navigator cannot unilaterally declare task complete — Planner validates

### 6.4 Prompt Templates
- Navigator system prompt (~4KB): 12 rule sections covering actions, element interaction, navigation, forms, scrolling, extraction, auth, plan following
- Planner system prompt: task decomposition, completion validation, web-task classification
- Security wrappers: `<nano_user_request>`, `<nano_untrusted_content>` with triple-repeated injection warnings

### 6.5 Security Guardrails
- Content wrapping with isolation tags
- Prompt injection pattern detection (task override, dangerous actions, fake tags)
- Credential protection rules (never auto-fill passwords, credit cards, SSNs)
- URL firewall (allow/deny lists)

---

## 7. Tool Design Considerations

### 7.1 Granularity Decision

| Option | Description | Tradeoff |
|--------|-------------|----------|
| Single high-level tool | `browser-task({ url, task, extract_format })` — browser-use's LLM handles all page interaction | Simple API, but two LLMs running (double cost, coordination overhead) |
| Granular atomic tools | `browser-click`, `browser-type`, `browser-scroll` etc. | Full agent control, but too many round-trips, token explosion |
| Hybrid | High-level task tool + a few utility tools (navigate, extract, screenshot) | Balanced |

### 7.2 Agent Strategy Skill

A `web-research` skill should teach the escalation principle:

```
1. Use brave_search FIRST for discovery
2. Use fetch for direct URL content retrieval
3. Only escalate to browser when:
   - fetch returns login/paywall page
   - Page requires JavaScript rendering
   - Interactive steps needed (click download, fill forms)
4. NEVER use browser for simple URL retrieval
```

### 7.3 Tool Description Guidance

The browser tool's `description` should explicitly state when NOT to use it:

> "Use only when fetch fails or when the page requires JavaScript rendering, user login sessions, or interactive operations. Do NOT use for simple URL retrieval — use fetch instead."

---

## 8. Pragmatic Assessment for Academic Research Use Case

For the specific scenario of Google Scholar + paper downloading:

| Site | Primary Barrier | CDP Issue? | Recommendation |
|------|----------------|------------|----------------|
| Google Scholar | Rate limiting + CAPTCHA | High on repeated automation | Use search API first; keep browser attempts sparse; escalate to extension or manual checkpoint on repeated CAPTCHA |
| arXiv | None (open access) | N/A | `fetch` is sufficient |
| IEEE Xplore | Login wall + dynamic pages | Medium (site-dependent) | Prefer extension/local-session path; CDP backend as optional fallback |
| ACM Digital Library | Login wall + dynamic pages | Medium (site-dependent) | Prefer extension/local-session path; CDP backend as optional fallback |
| Springer/Nature | Login wall + dynamic pages | Medium (site-dependent) | Prefer extension/local-session path; CDP backend as optional fallback |
| Sci-Hub | Cloudflare | Yes — aggressive bot detection | May need extension approach |

**Conclusion**: Academic workflows need **multi-backend routing**, not a CDP-only assumption. Login walls are authentication problems, but many target sites also include anti-bot/risk scoring. Design for failure-triggered escalation.

---

## 9. Recommended Path Forward

### Phase 1: Extension-First Browser Bridge (Approach B)
- Build or integrate a local Chrome-extension bridge for real-session control
- Implement mandatory security baseline (loopback, auth token, origin allowlist, approval gates, audit log)
- Expose backend-neutral tool contract (`browser.navigate`, `browser.act`, `browser.extract`)
- Create `web-research` skill with escalation policy and explicit "don't overuse browser" rules
- Target: logged-in academic workflows with minimal CDP exposure

### Phase 2: Add Optional CDP Backend (Approach C/A)
- Add Playwright/CDP backend as a fast-path for low-risk sites and generic JS rendering
- Keep CDP backend behind policy flags and failure telemetry
- Reuse Nanobrowser patterns (`buildDomTree.js`, action schemas, planner/navigator ideas)
- Target: performance optimization and broader compatibility

### Phase 3: Unified Adaptive Strategy
- Combine all tiers (search → fetch → browser-backend selection → computer-use fallback) under one skill
- Agent automatically selects the right tool based on task and failure signals
- Target: general-purpose web automation

---

## 10. References

- [browser-use GitHub](https://github.com/browser-use/browser-use)
- [browser-use Changelog (CDP migration)](https://browser-use.com/changelog/19-8-2025)
- [Nanobrowser GitHub](https://github.com/nanobrowser/nanobrowser)
- [Nanobrowser MCP Host](https://github.com/nanobrowser/nanobrowser-mcp-host)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Browser Tool Docs](https://docs.openclaw.ai/tools/browser)
- [OpenClaw Chrome Extension Docs](https://docs.openclaw.ai/tools/chrome-extension)
- [Claude Computer Use Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Claude for Chrome](https://claude.com/blog/claude-for-chrome)
- [Chrome Remote Debugging Port Security Change (Chrome 136)](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome Extensions `chrome.debugger` API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [CDP Detection (Rebrowser)](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
- [Anti-Detect Framework Evolution (Castle.io)](https://blog.castle.io/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/)
- [CDP Signal Impact on Bot Detection (DataDome)](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)
- [Nanobrowser MCP Feature Request (Issue #123)](https://github.com/nanobrowser/nanobrowser/issues/123)
- [browser-use CDP Detection Issue (#360)](https://github.com/browser-use/browser-use/issues/360)
- [browser-use CAPTCHA Discussion (#1695)](https://github.com/browser-use/browser-use/discussions/1695)
