/**
 * OpenAI image generation backend (gpt-image-2).
 *
 * Supports:
 *   - text-to-image via /v1/images/generations
 *   - image-to-image editing via /v1/images/edits (multipart form)
 *
 * Note on `response_format`: gpt-image-1 and gpt-image-2 always return
 * b64_json and reject the `response_format` parameter as unknown. Only
 * dall-e-2 / dall-e-3 accept it. We therefore omit it from every request.
 *
 * Reads OPENAI_API_KEY from process.env (or accepts an explicit apiKey)
 * matching the pattern used by web-tools.ts for Brave. A ChatGPT /
 * Codex subscription access token will NOT work here — subscription
 * auth is scoped to the Codex endpoint and is rejected by the Images
 * API; users need a real sk-... API key for image generation.
 */

import { Blob } from 'node:buffer'
import type { ImageCapability, ImageGenOptions, ImageProvider, Quality } from './types.js'

const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations'
const EDITS_URL = 'https://api.openai.com/v1/images/edits'
const DEFAULT_MODEL = 'gpt-image-2'
// 'auto' lets the model pick between the three canonical aspects (square,
// landscape, portrait) based on prompt content. The previous default
// '1024x1024' forced every diagram into a square frame regardless of what
// was being drawn — horizontal architecture diagrams got squished, portrait
// flowcharts got padded with whitespace.
const DEFAULT_SIZE = 'auto'
const REQUEST_TIMEOUT_MS = 300_000

interface OpenAIImageChoice {
  b64_json?: string
  url?: string
}

interface OpenAIImageResponse {
  data?: OpenAIImageChoice[]
  error?: { message?: string; type?: string }
}

function extractBytes(response: OpenAIImageResponse): Buffer {
  const choice = response.data?.[0]
  if (!choice) throw new Error('OpenAI image response had no choices')
  if (choice.b64_json) {
    return Buffer.from(choice.b64_json, 'base64')
  }
  if (choice.url) {
    // Should not happen for gpt-image-* (always base64), but guard anyway.
    throw new Error(
      'OpenAI returned an image URL instead of base64 bytes. The selected model may be dall-e-*; this backend targets gpt-image-2 which returns b64_json by default.'
    )
  }
  throw new Error('OpenAI image response did not contain image data')
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<OpenAIImageResponse> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const json = (await res.json()) as OpenAIImageResponse
    if (!res.ok) {
      const msg = json.error?.message || `HTTP ${res.status}`
      throw new Error(`OpenAI image API error: ${msg}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function postMultipart(
  url: string,
  apiKey: string,
  fields: Record<string, string>,
  files: Record<string, { data: Buffer; filename: string; contentType: string }>
): Promise<OpenAIImageResponse> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v)
  }
  for (const [k, f] of Object.entries(files)) {
    const view = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength)
    form.append(k, new Blob([view], { type: f.contentType }) as unknown as globalThis.Blob, f.filename)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form as unknown as ReadableStream,
      signal: ctl.signal,
    })
    const json = (await res.json()) as OpenAIImageResponse
    if (!res.ok) {
      const msg = json.error?.message || `HTTP ${res.status}`
      throw new Error(`OpenAI image edit API error: ${msg}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

export interface OpenAIImageProviderOptions {
  apiKey?: string
  model?: string
  size?: string
  /** Default quality tier; per-call options can override. Defaults to 'auto'. */
  quality?: Quality
}

export function createOpenAIImageProvider(
  opts: OpenAIImageProviderOptions = {}
): ImageProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required for diagram generation. ' +
      'Add it under Settings → API Keys, or set OPENAI_API_KEY in your shell.'
    )
  }
  const model = opts.model || DEFAULT_MODEL
  const size = opts.size || DEFAULT_SIZE
  const defaultQuality: Quality = opts.quality || 'auto'

  const capabilities = new Set<ImageCapability>(['text_to_image', 'image_to_image'])

  const effectiveQuality = (callOpts?: ImageGenOptions): Quality => callOpts?.quality ?? defaultQuality
  const effectiveSize = (callOpts?: ImageGenOptions): string => callOpts?.size?.trim() || size

  return {
    id: `openai:${model}`,
    label: `OpenAI ${model}`,
    capabilities,

    async textToImage(prompt: string, options?: ImageGenOptions): Promise<Buffer> {
      // gpt-image-* reject `response_format`; they always return b64_json.
      const body = {
        model,
        prompt,
        size: effectiveSize(options),
        n: 1,
        quality: effectiveQuality(options),
      }
      const response = await postJson(GENERATIONS_URL, apiKey, body)
      return extractBytes(response)
    },

    async imageToImage(prompt: string, image: Buffer, options?: ImageGenOptions): Promise<Buffer> {
      const response = await postMultipart(
        EDITS_URL,
        apiKey,
        { model, prompt, size: effectiveSize(options), n: '1', quality: effectiveQuality(options) },
        { image: { data: image, filename: 'image.png', contentType: 'image/png' } }
      )
      return extractBytes(response)
    },
  }
}
