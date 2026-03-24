# RFC-002: Intent Router API Key Mismatch

**Status:** Fixed (2026-03-24)
**Affects:** Any multi-model agent system that uses a cheap "router" model alongside a user-selected main model

## Problem

The LLM-based skill/intent router silently fails when its provider doesn't match the main model's provider, causing the entire skill matching system to be dead on arrival.

### Symptoms

- `matchedSkills: []` on every turn, even when rule-based intent detection correctly identifies relevant intents (e.g. `writing`, `grants`)
- Skills are never preloaded into the agent's context
- Agent relies on general knowledge instead of curated skill procedures
- No errors visible to the user — the failure is caught and swallowed

### Root Cause

The router model was selected from a hardcoded priority list:

```typescript
const routerModels = [
  ['anthropic', 'claude-haiku-4-5-20251001'],
  ['openai', 'gpt-4.1-nano'],
  ['google', 'gemini-2.0-flash-lite']
]
```

Two failure modes:

1. **Model initialization failure:** `getPiModel()` may fail for providers the user hasn't configured or for model IDs that don't exist in the current pi-mono version (e.g. `gpt-4.1-nano` was stale — should be `gpt-5.4-nano`). If all three fail, `intentRouterModel = null` and `matchSkillsWithLLM()` short-circuits with `return []`.

2. **API key mismatch:** Even if a router model initializes successfully, `completeSimple()` is called with the main model's `apiKey`. If the router is Anthropic Haiku but the user selected an OpenAI main model, the Anthropic API call fails with an auth error. The `catch` block swallows it and returns `[]`.

### Why It's Hard to Detect

- `matchSkillsWithLLM()` wraps everything in `try/catch` and returns `[]` on any failure — identical to "no skills matched"
- The explain snapshot records `matchedSkills: []` but doesn't distinguish "router failed" from "router ran but found nothing relevant"
- Rule-based intents are recorded correctly, creating a false sense that the system is working
- No console warnings unless `debug: true` is set

## Fix

**Principle: Router model must use the same provider as the main model.**

The user has already validated their API key by selecting a main model. A cheap model from the same provider is guaranteed to work with the same key.

```typescript
const routerByProvider: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.4-nano',
  google: 'gemini-2.0-flash-lite'
}

// Derive provider from main model ID
let mainProvider = modelId.startsWith('claude-') ? 'anthropic'
  : modelId.startsWith('gpt-') || modelId.startsWith('o3') || modelId.startsWith('o4') ? 'openai'
  : modelId.startsWith('gemini-') ? 'google'
  : null

// Try same-provider first, then fall back to others
const providerOrder = mainProvider
  ? [mainProvider, ...others]
  : allProviders
```

## Checklist for Other Projects

If your project has a similar pattern (cheap router model + user-selected main model), verify:

- [ ] Router model provider matches the main model's provider
- [ ] Router model ID exists in the current SDK version (model names evolve — `gpt-4.1-nano` → `gpt-5.4-nano`)
- [ ] API key passed to the router call is valid for the router's provider
- [ ] Router failures are logged (not silently swallowed) — at minimum, log a warning so you know the router is dead
- [ ] Explain/telemetry distinguishes "router didn't run" from "router ran, matched nothing"

## Broader Lesson

**Silent `catch` blocks on LLM calls are dangerous.** When a routing/classification LLM call fails, the system degrades to "no classification" which looks like normal behavior. Always log router failures at `warn` level, and consider adding a health check that verifies the router can make at least one successful call during initialization.
