# AgentFoundry API Server Example

A simple Express server that exposes an AgentFoundry agent as a REST API.

## Setup

```bash
# From the AgentFoundry root directory
export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GOOGLE_API_KEY
npx tsx examples/api-server/index.ts
```

The server starts on port 3000 by default.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GOOGLE_API_KEY` | Google API key |
| `PORT` | Server port (default: `3000`) |

## API Endpoints

### `GET /api/health`

Health check.

```bash
curl http://localhost:3000/api/health
```

Response:

```json
{ "status": "ok", "agentId": "agent-m2abc12-x9f3k2q" }
```

### `POST /api/chat`

Send a prompt and receive a complete response.

**Request body:**

```json
{
  "prompt": "What is the capital of France?",
  "model": "gpt-4o"
}
```

The `model` field is optional. If omitted, the default model for your API key is used.

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the capital of France?"}'
```

**Response:**

```json
{
  "response": "The capital of France is Paris.",
  "steps": 1,
  "success": true,
  "durationMs": 1234,
  "usage": {
    "totalTokens": 42,
    "promptTokens": 20,
    "completionTokens": 22
  }
}
```

### `POST /api/chat/stream`

Send a prompt and receive a Server-Sent Events (SSE) stream.

```bash
curl -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing in 3 sentences."}'
```

**Event types:**

| Event type | Description | Fields |
|---|---|---|
| `delta` | Text chunk from the LLM | `content` |
| `tool_call` | Agent is invoking a tool | `tool`, `input` |
| `tool_result` | Tool execution result | `tool`, `result` |
| `done` | Run complete | `response`, `steps`, `success`, `durationMs`, `usage` |
| `error` | An error occurred | `error` |

Each event is a JSON object on a `data:` line:

```
data: {"type":"delta","content":"Quantum"}
data: {"type":"delta","content":" computing"}
data: {"type":"done","response":"Quantum computing...","steps":1,"success":true,"durationMs":800,"usage":null}
```

## CORS

All origins are allowed by default. Adjust the CORS middleware in `index.ts` for production use.
