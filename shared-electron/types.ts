/**
 * Shared types for Electron main-process IPC handlers.
 * Used by both personal-assistant and research-pilot-desktop.
 */

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  hasChildren?: boolean
  modifiedAt: number
}

export interface GitIgnoreRule {
  negated: boolean
  directoryOnly: boolean
  regex: RegExp
}

export interface ResolvedCoordinatorAuth {
  apiKey: string
  authMode: 'api-key' | 'none'
  isAnthropicModel: boolean
  billingSource: 'api-key' | 'none'
}
