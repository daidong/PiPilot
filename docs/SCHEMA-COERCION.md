# Schema Coercion for OpenAI Responses API

## Background

OpenAI's Responses API (used by GPT-5.x, o3, o4 models) requires strict JSON Schema compliance. Specifically, when using `additionalProperties` for dynamic object types, it must have an explicit `type` key.

This creates a conflict with our internal design where some tools accept dynamic parameters (e.g., `ctx-get.params` can have values of any type).

## The Problem

```typescript
// Our internal tool definition (type-safe)
params: {
  type: 'object',
  description: 'Parameters for the source'
}

// OpenAI Responses API requires:
params: {
  type: 'object',
  additionalProperties: { type: 'string' }  // Must have explicit type
}
```

Without `additionalProperties`, OpenAI returns:
```
Invalid schema for function 'ctx-get': In context=('properties', 'params', 'additionalProperties'), schema must have a 'type' key.
```

### Issue 2: Optional Fields Must Be in Required Array

OpenAI's Responses API uses "strict mode" where ALL properties must be listed in the `required` array:

```typescript
// Our internal tool definition (optional field)
encoding: {
  type: 'string',
  required: false,
  default: 'utf-8'
}

// OpenAI Responses API requires ALL fields in required array
// Optional fields must use nullable type instead
encoding: {
  type: ['string', 'null']  // Nullable, but still in required array
}
```

Without this, OpenAI returns:
```
Invalid schema for function 'read': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'encoding'.
```

## Solution Architecture

We use a **three-layer approach** that maintains internal type safety while satisfying external API requirements:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Tool Definition (Internal)                             │
│ - Uses proper types: type: 'object', type: 'array'              │
│ - No additionalProperties needed                                │
│ - Full TypeScript type safety                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: Schema Generation (src/core/tool-registry.ts)          │
│ - Transforms tool definitions to LLM-compatible schemas         │
│ - Adds additionalProperties: { type: 'string' } for objects     │
│ - Adds items: { type: 'string' } for arrays without items       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: Runtime Coercion (src/utils/schema-coercion.ts)        │
│ - Converts string values back to intended types at runtime      │
│ - parseValue("5") → 5                                           │
│ - parseValue("true") → true                                     │
│ - parseValue('{"a":1}') → {a: 1}                                │
└─────────────────────────────────────────────────────────────────┘
```

## Affected Components

### Zod Schema Conversion (`src/llm/stream.ts`)

The `jsonSchemaToZod` function converts JSON Schema to Zod for Vercel AI SDK.
This is where the schema transformation happens for OpenAI compatibility:

```typescript
// Before (causes OpenAI error)
case 'object':
  zodProp = z.record(z.unknown())  // produces additionalProperties: {}

// After (works with OpenAI)
case 'object':
  zodProp = z.record(z.string())   // produces additionalProperties: { type: 'string' }

case 'array':
  zodProp = z.array(z.string())    // produces items: { type: 'string' }

// Optional fields (strict mode requires ALL properties in 'required')
// Before (causes OpenAI error - missing fields from required array)
if (!required.includes(key)) {
  zodProp = zodProp.optional()     // removes from required array
}

// After (works with OpenAI)
if (!required.includes(key)) {
  zodProp = zodProp.nullable()     // keeps in required, allows null
}
```

**Note**: The schema transformation happens in `jsonSchemaToZod`, not in `tool-registry.ts`.
Tool definitions remain simple and type-safe; the Zod conversion layer handles OpenAI compatibility.

### Tools Requiring Coercion

| Tool | Parameter | Coercion Function |
|------|-----------|-------------------|
| `ctx-get` | `params` | `coerceObjectValues()` |
| `memory-put` | `value` | `coerceDeep()` |
| `memory-update` | `value` | `coerceDeep()` |

### Tools NOT Requiring Coercion

| Tool | Parameter | Reason |
|------|-----------|--------|
| `fetch` | `headers` | HTTP headers are always string:string |
| `fact-remember` | `topics` | Always string array |
| `memory-put` | `tags` | Always string array |
| `memory-update` | `tags` | Always string array |
| `glob` | `ignore` | Has explicit `items: { type: 'string' }` |
| `llm-filter` | `items` | Has explicit object schema with properties |

## Coercion Utilities

### `parseValue(value: unknown): unknown`

Converts a single string value to its intended type:

```typescript
parseValue("5")           // → 5 (number)
parseValue("3.14")        // → 3.14 (number)
parseValue("true")        // → true (boolean)
parseValue("false")       // → false (boolean)
parseValue("null")        // → null
parseValue('{"a":1}')     // → {a: 1} (object)
parseValue('["a","b"]')   // → ["a", "b"] (array)
parseValue("hello")       // → "hello" (string, unchanged)
```

### `coerceObjectValues(obj: Record<string, unknown>): Record<string, unknown>`

Coerces all values in an object (shallow):

```typescript
coerceObjectValues({ query: "test", k: "5", verbose: "true" })
// → { query: "test", k: 5, verbose: true }
```

### `coerceDeep(value: unknown): unknown`

Recursively coerces all string values in nested structures:

```typescript
coerceDeep({ user: { age: "25", scores: ["90", "85"] } })
// → { user: { age: 25, scores: [90, 85] } }
```

## Trade-offs

### Advantages

1. **Internal type safety preserved** - Tool definitions remain type-correct
2. **Transparent to LLM** - LLM sends string values, tool receives correct types
3. **Backward compatible** - Works with both Chat API and Responses API
4. **Centralized logic** - Coercion utilities are reusable

### Limitations

1. **Ambiguous strings** - A string like `"123"` is always converted to number `123`
   - If you actually want the string `"123"`, this is a limitation
   - Workaround: Use explicit typing in tool parameters where possible

2. **Performance overhead** - Runtime parsing adds minimal overhead
   - For most use cases, this is negligible

3. **LLM schema hints reduced** - LLM only knows values are strings
   - Mitigated by good parameter descriptions

## Adding New Tools with Dynamic Parameters

When adding a new tool with `type: 'object'` parameters:

1. **Define the tool normally** with proper types
2. **Import coercion utilities**:
   ```typescript
   import { coerceObjectValues, coerceDeep } from '../utils/schema-coercion.js'
   ```
3. **Apply coercion in execute function**:
   ```typescript
   execute: async (input, { runtime }) => {
     const params = coerceObjectValues(input.params)  // or coerceDeep()
     // ... rest of implementation
   }
   ```

## Testing

The coercion utilities should handle edge cases:

```typescript
// Numbers
parseValue("0")       // → 0
parseValue("-5")      // → -5
parseValue("1e10")    // → 10000000000

// Booleans
parseValue("true")    // → true
parseValue("TRUE")    // → "TRUE" (case-sensitive, keeps as string)

// JSON
parseValue("{}")      // → {}
parseValue("[]")      // → []
parseValue("{invalid}") // → "{invalid}" (invalid JSON, keeps as string)

// Edge cases
parseValue("")        // → "" (empty string stays as string)
parseValue("   ")     // → "   " (whitespace stays as string)
parseValue(123)       // → 123 (non-string passes through)
parseValue(null)      // → null (null passes through)
```

## Related Files

- `src/utils/schema-coercion.ts` - Coercion utility functions
- `src/llm/stream.ts` - Zod schema conversion (`jsonSchemaToZod`)
- `src/core/tool-registry.ts` - Schema generation with additionalProperties
- `src/tools/ctx-get.ts` - Example tool using coercion
- `src/tools/memory-put.ts` - Example tool using deep coercion
- `src/tools/memory-update.ts` - Example tool using deep coercion
