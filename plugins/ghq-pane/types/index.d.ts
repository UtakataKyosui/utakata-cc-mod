export type Worktree = {
  path: string
  branch: string
  isMain: boolean
  isPrunable: boolean
  dirty: number
}
export type Repo = { name: string; path: string; worktrees: Worktree[] }
export type Snapshot = { repos: Repo[]; error: string; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ghq-pane': { snapshot: Shaped<Snapshot> }
  }
}
