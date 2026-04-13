// Types
export type { FileTreeNode, GitIgnoreRule, ResolvedCoordinatorAuth } from './types'
export type { SharedHandlerContext, AppSettings } from './ipc-base'

// File tree utilities
export {
  TREE_MAX_ENTRIES,
  toPosixPath,
  isWithinRoot,
  readGitIgnoreRules,
  isHiddenPath,
  isIgnored,
  hasVisibleChildren,
  listTreeChildren,
  searchTree
} from './file-tree'

// IPC handler utilities and registrations
export {
  getFileName,
  inferMimeType,
  safeSend,
  isValidProjectDirectory,
  loadOrCreateSessionId,
  resolveCoordinatorAuth,
  loadCodexCredentials,
  saveCodexCredentials,
  clearCodexCredentials,
  loadAnthropicSubCredentials,
  saveAnthropicSubCredentials,
  clearAnthropicSubCredentials,
  registerFileHandlers,
  registerSessionHandlers,
  registerPrefsHandlers,
  registerUsageHandlers,
  registerAuthHandlers,
  registerFolderOpenHandler,
  registerConfigHandlers,
  registerSettingsHandlers,
  loadApiKeysFromConfig,
  loadSettingsFromConfig,
  hasLlmAuth
} from './ipc-base'

// Recent projects persistence (FolderGate welcome screen)
export {
  listRecentProjects,
  addRecentProject,
  removeRecentProject,
  setRecentProjectPinned,
  type RecentProjectEntry
} from './recent-projects'
