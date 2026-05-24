/**
 * RFC-013 sharing — public surface for the main process (IPC handlers).
 */

export { checkSharingPreflight, type SharingPreflight } from './preflight.js'
export {
  ensureSharingGitignore,
  ensureSharingGitattributes,
  ensureSharingGitFiles,
} from './workspace-git.js'
export {
  getLocalIdentity,
  ensureLocalIdentity,
  hasLocalIdentity,
  slugifyDisplayName,
} from './identity.js'
export type { RepoInvitation } from './gh.js'
export {
  getSharingStatus,
  shareProject,
  syncProject,
  pollRemote,
  inviteMember,
  removeMember,
  promoteMember,
  acceptInvite,
  listInvitations,
  DEFAULT_LFS_THRESHOLD,
  type SharingStatus,
  type SyncState,
  type ShareOptions,
  type ShareResult,
  type SyncResult,
  type PollResult,
  type MemberOpResult,
  type AcceptInviteOptions,
  type AcceptInviteResult,
} from './share.js'
