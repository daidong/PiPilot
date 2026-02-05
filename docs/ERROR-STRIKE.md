# Error Strike Protocol

The error strike protocol prevents the agent from repeatedly making the exact same failing tool call.
It does **not** disable tools globally. It only blocks the **same tool + same parameters + same error category**
after repeated failures within a single run.

## Behavior (default)

1. First failure: normal error feedback.
2. Second failure (same signature): guidance says "do not retry the same parameters, change approach."
3. Third failure (same signature): the exact call is blocked for this run and returns a policy_denied error.

## What counts as a strike

Strikes are recorded per signature:

```
signature = toolName + normalizedArgs + errorCategory
```

The following error categories are **excluded** and do not count as strikes:

- timeout
- rate_limit
- server_overload
- transient_network

## Reset

If the tool call succeeds, the strike count for that tool+args is cleared.

## Configuration

You can override the thresholds via `errorStrikePolicy`:

```ts
createAgent({
  errorStrikePolicy: {
    warnAfter: 2,
    disableAfter: 3
  }
})
```

Notes:
- `disableAfter` blocks only the **same signature** (not the tool).
- If `disableAfter < warnAfter`, it is clamped to `warnAfter`.
