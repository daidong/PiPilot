# Thin Core Example

Interactive REPL for the thin-core plugin runtime.

## Run

```bash
export OPENAI_API_KEY=sk-...
npx tsx examples/thin-core/index.ts
```

Optional workspace path:

```bash
npx tsx examples/thin-core/index.ts ./my-project
```

## Commands

- `/install <path>` install dynamic plugin (activates next turn)
- `/reload <id>` reload a loaded plugin (activates next turn)
- `/test <path_or_id>` run plugin preflight or heartbeat
- `/invoke <id> <tool> <jsonArgs?>` direct tool smoke call
- `/quit` exit
