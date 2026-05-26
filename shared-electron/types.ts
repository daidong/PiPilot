/**
 * Shared types for Electron main-process IPC handlers.
 * Used by research-pilot-desktop (the app/ workspace).
 */

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  hasChildren?: boolean
  modifiedAt: number
}

export interface ResolvedCoordinatorAuth {
  apiKey: string
  authMode: 'api-key' | 'subscription' | 'none'
  isAnthropicModel: boolean
  billingSource: 'api-key' | 'subscription' | 'none'
  /** For subscription mode: provider string passed to pi-ai (e.g. 'openai-codex') */
  piProvider?: string
}
