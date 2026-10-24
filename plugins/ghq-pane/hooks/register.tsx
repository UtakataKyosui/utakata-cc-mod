import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Repo, Snapshot, Worktree } from '../types'

const PANE = 'ghq'
const snapshot = atom(
  { plugin: 'ghq-pane', key: 'snapshot' } as const,
  { repos: [], error: '', isLoading: false } as Snapshot,
  { shape: 'snapshot-1' },
)

function parseWorktrees(out: string): Omit<Worktree, 'dirty'>[] {
  return out
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block, i) => {
      const lines = block.split('\n')
      const field = (key: string) =>
        lines.find(l => l === key || l.startsWith(`${key} `))?.slice(key.length + 1)
      const branch = field('branch')
      return {
        path: field('worktree') ?? '',
        branch: branch ? branch.replace('refs/heads/', '') : '(detached)',
        isMain: i === 0,
        isPrunable: lines.some(l => l.startsWith('prunable')),
      }
    })
}

let generation = 0

function repoName(path: string, roots: string[]) {
  const root = roots.find(r => path.startsWith(`${r}/`))
  return root ? path.slice(root.length + 1) : path
}

async function load($: EngineInterface) {
  const current = ++generation
  await update($, snapshot, s => ({ ...s, isLoading: true }))
  try {
    const listed = await $.process.run(['ghq', 'list', '-p'])
    if (listed.exitCode !== 0) throw new Error(listed.stderr.trim() || 'ghq list failed')
    const roots = (await $.process.run(['ghq', 'root', '--all'])).stdout.split('\n').filter(Boolean)
    const paths = listed.stdout.split('\n').filter(Boolean)
    const repos: Repo[] = await Promise.all(
      paths.map(async path => {
        const wt = await $.process.run(['git', '-C', path, 'worktree', 'list', '--porcelain'])
        const worktrees = await Promise.all(
          parseWorktrees(wt.stdout).map(async w => {
            if (w.isPrunable) return { ...w, dirty: 0 }
            const st = await $.process.run(['git', '-C', w.path, 'status', '--porcelain'])
            return { ...w, dirty: st.stdout.split('\n').filter(Boolean).length }
          }),
        )
        return { name: repoName(path, roots), path, worktrees }
      }),
    )
    if (current !== generation) return
    await update($, snapshot, () => ({ repos, error: '', isLoading: false }))
  } catch (err) {
    if (current !== generation) return
    await update($, snapshot, s => ({ ...s, error: String(err), isLoading: false }))
  }
}

async function ensureCommand($: EngineInterface) {
  const known = await $.command.list()
  if (known.some(c => c.name === 'ghq')) return
  await $.command.register({ name: 'ghq', description: 'Show ghq repositories and worktrees in a pane' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensureCommand($)
    void load($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureCommand($)
    return next(e)
  })

  on('command.run', { command: 'ghq' }, async $ => {
    await $.ui.open({ id: PANE, title: 'ghq' })
    void load($)
    return { text: 'ghq pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" onPress={() => void load($)}>
            <Text bold>{s.isLoading ? 'Loading…' : 'Refresh'}</Text>
          </Button>
          <Text dimColor> {s.repos.length} repos</Text>
        </Box>
        {s.error !== '' && <Text color="red">{s.error}</Text>}
        {s.repos.map(repo => (
          <Box key={repo.path} flexDirection="column" marginTop={1}>
            <Text bold>{repo.name}</Text>
            {repo.worktrees.map(w => (
              <Button
                key={w.path}
                onPress={press => {
                  void $.ui.copy({ text: w.path, surface: press.surface })
                  void $.ui.toast(`Copied ${w.path}`)
                }}
              >
                <Text dimColor={w.isPrunable}>
                  {w.isMain ? '●' : '○'} {w.branch}
                  {w.dirty > 0 ? ` ±${w.dirty}` : ''}
                  {w.isPrunable ? ' (prunable)' : ''}
                  {w.isMain ? '' : `  ${w.path}`}
                </Text>
              </Button>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
