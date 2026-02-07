import type { AnthropicAuthFailureClassification } from './anthropic-auth-types'

function safeMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function classifyAnthropicAuthFailure(error: unknown): AnthropicAuthFailureClassification {
  const message = safeMessage(error).toLowerCase()

  const nonAuthMarkers = [
    '429',
    'rate limit',
    'timeout',
    'timed out',
    'network',
    'econnreset',
    'enotfound',
    '503',
    '502',
    '500',
    'service unavailable'
  ]

  if (nonAuthMarkers.some(marker => message.includes(marker))) {
    return {
      isAuthInvalid: false,
      reasonCode: 'non-auth-transient',
      retryableWithApiKey: false
    }
  }

  const authMarkers = [
    '401',
    '403',
    'unauthorized',
    'forbidden',
    'invalid token',
    'invalid api key',
    'authentication failed',
    'auth failed',
    'x-api-key',
    'api key not valid'
  ]

  if (authMarkers.some(marker => message.includes(marker))) {
    return {
      isAuthInvalid: true,
      reasonCode: 'provider-auth-invalid',
      retryableWithApiKey: true
    }
  }

  return {
    isAuthInvalid: false,
    reasonCode: 'unknown',
    retryableWithApiKey: false
  }
}

