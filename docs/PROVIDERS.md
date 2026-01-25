# Providers (Pack Plugins)

Providers let you load external tool packs with a manifest + entry module.
This keeps the core framework stable while allowing community packs to evolve.

> **Note**: For MCP (Model Context Protocol) integration, see [MCP-GUIDE.md](./MCP-GUIDE.md).
> Key principle: Use existing MCP servers for common capabilities, write local tools for your business logic.

## Manifest (agentfoundry.provider.json)

```json
{
  "id": "acme.weather",
  "name": "Acme Weather Tools",
  "version": "1.0.0",
  "description": "Weather tools powered by Acme API",
  "entry": "./dist/provider.js",
  "packs": [
    {
      "id": "acme.weather.pack",
      "description": "Weather tools and policies",
      "tools": ["get_weather"],
      "permissions": {
        "network": { "allow": ["https://api.acme.com"] }
      },
      "budgets": { "timeoutMs": 5000, "maxOutputBytes": 200000 }
    }
  ],
  "permissions": {
    "network": { "allow": ["https://api.acme.com"] }
  },
  "engines": { "agentFoundry": "^0.4.0" }
}
```

## Provider entry

```ts
import { defineProvider, defineTool, definePack } from 'agent-foundry'

export default defineProvider({
  manifest: {
    id: 'acme.weather',
    name: 'Acme Weather Tools',
    version: '1.0.0'
  },
  createPacks: () => {
    const getWeather = defineTool({
      name: 'get_weather',
      description: 'Fetch weather by city',
      parameters: {
        city: { type: 'string', required: true }
      },
      execute: async () => ({ success: true, data: { ok: true } })
    })

    return [
      definePack({
        id: 'acme.weather.pack',
        description: 'Weather tools',
        tools: [getWeather]
      })
    ]
  }
})
```

## Loading providers

```ts
import { ProviderRegistry, createAgent } from 'agent-foundry'

const registry = new ProviderRegistry()
await registry.loadFromFile({ manifestPath: '/path/to/agentfoundry.provider.json' })

const packs = await registry.collectPacks()
const agent = createAgent({ packs })
```

## Notes

- Permissions and budgets in the manifest are metadata for policy/audit.
  Enforce them by attaching your own policies or guard layers.
- Prefer loading providers from a trusted directory or verified packages.
