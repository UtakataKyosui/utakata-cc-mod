// repo-storage-report-1 の公開型。policy.ts の型と一致させる (契約テストで検査する)。
export type { Category, Reason, Report, RepoReport, CacheDir, Verdict } from './policy'

export const SCHEMA_VERSION = 'repo-storage-report-1' as const
export const CATEGORIES = ['PROTECTED', 'DIRTY', 'UNKNOWN', 'CANDIDATE'] as const
export const REASONS = [
  'CURRENT_DIR', 'LINKED_WORKTREE', 'EXTRA_WORKTREE', 'ACTIVE_WORKTREE', 'BARE_REPO', 'SUBMODULE', 'RECENT',
  'UNCOMMITTED', 'UNTRACKED', 'UNPUSHED', 'NO_UPSTREAM', 'STASH', 'DETACHED_HEAD',
  'GIT_FAILED', 'NO_COMMITS', 'STALE', 'REMOTE_UNVERIFIED', 'SIGNAL_CONFLICT',
] as const
