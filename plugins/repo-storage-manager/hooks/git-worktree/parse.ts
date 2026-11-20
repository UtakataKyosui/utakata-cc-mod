// `git worktree list --porcelain` の解析。ghq-pane と repo-storage-manager で共有する (正本はここ)。
// 各 plugin へは scripts/sync-git-worktree.ts で hooks/git-worktree/ にコピーする。

export type ParsedWorktree = {
  path: string
  /** `refs/heads/` を除いたブランチ名。detached は '(detached)' */
  branch: string
  /** 先頭のブロックが本体 */
  isMain: boolean
  isPrunable: boolean
  bare: boolean
}

export const parseWorktrees = (out: string): ParsedWorktree[] =>
  out
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block, i) => {
      const lines = block.split('\n')
      const field = (key: string) => lines.find(l => l === key || l.startsWith(`${key} `))?.slice(key.length + 1)
      const branch = field('branch')
      return {
        path: field('worktree') ?? '',
        branch: branch ? branch.replace('refs/heads/', '') : '(detached)',
        isMain: i === 0,
        isPrunable: lines.some(l => l.startsWith('prunable')),
        bare: lines.includes('bare'),
      }
    })
