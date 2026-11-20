import { expect, test } from 'bun:test'
import { parseWorktrees } from './parse'

/** 共通化の前に ghq-pane が持っていた実装。出力が変わっていないことを、そのままの写しと比べて確かめる。 */
const legacy = (out: string) =>
  out.trim().split('\n\n').filter(Boolean).map((block, i) => {
    const lines = block.split('\n')
    const field = (key: string) => lines.find(l => l === key || l.startsWith(`${key} `))?.slice(key.length + 1)
    const branch = field('branch')
    return {
      path: field('worktree') ?? '',
      branch: branch ? branch.replace('refs/heads/', '') : '(detached)',
      isMain: i === 0,
      isPrunable: lines.some(l => l.startsWith('prunable')),
    }
  })

const SAMPLES = [
  '',
  'worktree /r/a\nHEAD abc\nbranch refs/heads/main\n',
  'worktree /r/a b/日本語\nHEAD abc\nbranch refs/heads/feat/x\n\nworktree /w/1\nHEAD def\ndetached\n\nworktree /w/gone\nHEAD 000\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n',
  'worktree /r/bare.git\nbare\n',
  'worktree /r/a\nHEAD abc\nbranch refs/heads/main\nlocked reason\n',
]

test('ghq-pane の従来の出力と一致する (bare を除く)', () => {
  for (const s of SAMPLES) expect(parseWorktrees(s).map(({ bare: _b, ...w }) => w)).toEqual(legacy(s))
})

test('bare・detached・prunable・日本語/空白のパス', () => {
  const [bare] = parseWorktrees(SAMPLES[3]!)
  expect(bare).toMatchObject({ path: '/r/bare.git', bare: true, isMain: true, branch: '(detached)' })
  const w = parseWorktrees(SAMPLES[2]!)
  expect(w.map(x => x.path)).toEqual(['/r/a b/日本語', '/w/1', '/w/gone'])
  expect(w.map(x => x.branch)).toEqual(['feat/x', '(detached)', 'old'])
  expect(w.map(x => x.isPrunable)).toEqual([false, false, true])
  expect(w.map(x => x.isMain)).toEqual([true, false, false])
  expect(w.every(x => !x.bare)).toBe(true)
})

test('空の出力・壊れた出力は空配列または空のパスにとどまり、例外を投げない', () => {
  expect(parseWorktrees('')).toEqual([])
  expect(parseWorktrees('\n\n')).toEqual([])
  expect(parseWorktrees('garbage')[0]?.path).toBe('')
})
