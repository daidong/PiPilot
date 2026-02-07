export type AnthropicAuthStatus = 'missing' | 'unknown' | 'valid' | 'invalid'

export type AnthropicResolvedMode = 'setup-token' | 'api-key' | 'none' | 'not-applicable'

export interface AnthropicAuthState {
  provider: 'anthropic'
  mode: 'setup-token'
  status: AnthropicAuthStatus
  setupToken?: string
  lastError?: string | null
  lastValidatedAt?: string
  updatedAt: string
}

export interface AnthropicAuthStatusView {
  authMode: AnthropicResolvedMode
  authStatus: AnthropicAuthStatus
  hasSetupToken: boolean
  hasApiKeyFallback: boolean
  lastError?: string | null
  updatedAt?: string
  lastValidatedAt?: string
}

export interface AnthropicResolvedCredential {
  mode: AnthropicResolvedMode
  apiKey?: string
  reason?: string
}

export interface AnthropicAuthFailureClassification {
  isAuthInvalid: boolean
  reasonCode: string
  retryableWithApiKey: boolean
}

