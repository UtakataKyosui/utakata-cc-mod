import { test, expect } from 'claude-code/testing'
import * as git from './git'
import type { Io, RunResult } from './git'
import { canTransition, destructiveGit, evaluate, inScope, isDone, overlaps, parsePorcelain, readConfig, type Task } from './policy'

test('担当範囲の判定: ディレクトリ配下・ファイル・glob', () => {
  expect(inScope('src/a/b.ts', ['src'])).toBe(true)
  expect(inScope('src2/b.ts', ['src'])).toBe(false)
  expect(inScope('docs/a.md', ['./docs/'])).toBe(true)
  expect(inScope('src/x/y.test.ts', ['src/**/*.test.ts'])).toBe(true)
  expect(inScope('src/y.ts', ['src/*.test.ts'])).toBe(false)
  expect(inScope('README.md', [])).toBe(false)
})

test('範囲外・重なり・ユーザー変更・競合を blocker にする', () => {
  expect(evaluate({ files: ['src/a.ts'], scope: ['src'], others: {}, userDirty: [], applyError: undefined })).toEqual([])
  const kinds = evaluate({
    files: ['src/a.ts', 'README.md'],
    scope: ['src'],
    others: { t2: ['src/a.ts'] },
    userDirty: ['src/a.ts'],
    applyError: 'patch failed',
  }).map(b => b.kind)
  expect(kinds).toEqual(['out-of-scope', 'overlap', 'user-change', 'conflict'])
  expect(overlaps(['a'], { x: ['b'] })).toEqual({})
})

test('状態遷移: 未統合から直接 verified にならない', () => {
  expect(canTransition('working', 'verified')).toBe(false)
  expect(canTransition('ready', 'integrated')).toBe(true)
  expect(canTransition('blocked', 'integrated')).toBe(false)
  expect(canTransition('integrated', 'verified')).toBe(true)
  expect(isDone({ state: 'integrated' } as Task)).toBe(false)
})

test('破壊的な git 操作の検出', () => {
  expect(destructiveGit('git reset --hard HEAD~1')).toBe('git reset --hard')
  expect(destructiveGit('cd x && git -C y clean -fd')).toBe('git clean -f')
  expect(destructiveGit('git push origin main --force')).toBe('git push --force')
  expect(destructiveGit('git push -f')).toBe('git push --force')
  expect(destructiveGit('git worktree remove --force ../w')).toBe('git worktree remove --force')
  expect(destructiveGit('git status && git reset --soft HEAD~1')).toBeUndefined()
  expect(destructiveGit('git push --force-with-lease')).toBeUndefined()
  expect(destructiveGit('echo git reset --hard')).toBeUndefined()
})

test('porcelain の解析と設定', () => {
  expect(parsePorcelain(' M a.ts\0?? b.ts\0R  new.ts\0old.ts\0')).toEqual(['a.ts', 'b.ts', 'new.ts', 'old.ts'])
  expect(readConfig(undefined)).toEqual({ verifyCommand: '', worktreeRoot: '', guardDestructive: true, autoCollect: true })
})

const cfg = { verifyCommand: 'true', worktreeRoot: '', guardDestructive: true, autoCollect: true }

// git を呼ぶ層を、argv に応じて答える偽の Io で確かめる (実 git での通し検証は tests/git.itest.ts)。
type World = {
  dirty: string[]
  changes: Record<string, string[]>
  applyCheck: number
  verify: number
}

const fakeIo = (w: World) => {
  const calls: { argv: string[]; cwd?: string }[] = []
  const files = new Map<string, string>()
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
  const io: Io = {
    run: async (argv, init) => {
      calls.push({ argv, ...(init?.cwd === undefined ? {} : { cwd: init.cwd }) })
      const cwd = init?.cwd ?? '/r'
      const [cmd, sub, ...rest] = argv
      if (cmd === 'sh') return { exitCode: w.verify, stdout: '', stderr: 'verify output' }
      if (sub === 'rev-parse') {
        if (rest.includes('--show-toplevel')) return ok(`${cwd}\n`)
        if (rest.includes('--path-format=absolute')) return ok('/r/.git\n')
        return ok('basesha000000000\n')
      }
      if (sub === 'status') return ok(w.dirty.map(f => ` M ${f}\0`).join(''))
      if (sub === 'diff') {
        const names = w.changes[cwd] ?? []
        return rest.includes('--name-only') ? ok(names.map(n => `${n}\n`).join('')) : ok(names.length > 0 ? `PATCH:${cwd}\n` : '')
      }
      if (sub === 'apply') {
        const check = rest.includes('--check')
        if (check && w.applyCheck !== 0) return { exitCode: w.applyCheck, stdout: '', stderr: 'error: patch does not apply' }
        return ok()
      }
      return ok()
    },
    read: async p => files.get(p) ?? '',
    write: async (p, t) => void files.set(p, t),
    exists: async p => files.has(p),
  }
  return { io, calls, files }
}

const world = (over: Partial<World> = {}): World => ({ dirty: [], changes: {}, applyCheck: 0, verify: 0, ...over })
const realApplies = (calls: { argv: string[] }[]) => calls.filter(c => c.argv[1] === 'apply' && !c.argv.includes('--check'))
const FORBIDDEN = ['--hard', 'clean', '--force', '-f', '-D', 'prune', 'stash', 'remove']

test('担当範囲外の変更がある差分は統合しない', async () => {
  const w = world()
  const { io, calls } = fakeIo(w)
  expect((await git.assign(io, cfg, { id: 't1', scope: ['src'] })).ok).toBe(true)
  w.changes['/r/../r-workspaces/t1'] = ['src/a.ts', 'docs/d.md']
  const r = await git.integrate(io, 't1')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('out-of-scope')
  expect(r.text).toContain('docs/d.md')
  expect(realApplies(calls)).toEqual([])
})

test('競合時は適用せず、強制する操作も呼ばない', async () => {
  const w = world({ applyCheck: 1 })
  const { io, calls } = fakeIo(w)
  await git.assign(io, cfg, { id: 't2', scope: ['src'] })
  w.changes['/r/../r-workspaces/t2'] = ['src/a.ts']
  const r = await git.integrate(io, 't2')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('conflict')
  expect(realApplies(calls)).toEqual([])
  expect(calls.flatMap(c => c.argv).filter(a => ['--3way', '--reject', '--force', '--hard'].includes(a))).toEqual([])
  expect((await git.status(io)).text).toContain('統合不可')
})

test('ユーザー既存変更と重なる差分は統合せず、開始前の変更を記録する', async () => {
  const w = world({ dirty: ['src/a.ts'] })
  const { io, calls } = fakeIo(w)
  const a = await git.assign(io, cfg, { id: 't3', scope: ['src'] })
  expect(a.text).toContain('元の作業ツリーにそのまま残る')
  w.changes['/r/../r-workspaces/t3'] = ['src/a.ts']
  const r = await git.integrate(io, 't3')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('user-change')
  expect(realApplies(calls)).toEqual([])
})

test('統合しただけでは完了にならず、検証に成功して初めて完了する', async () => {
  const w = world()
  const { io, calls } = fakeIo(w)
  await git.assign(io, cfg, { id: 't4', scope: ['src'] })
  w.changes['/r/../r-workspaces/t4'] = ['src/a.ts']
  expect((await git.verify(io, cfg, 't4')).ok).toBe(false)
  expect((await git.integrate(io, 't4')).ok).toBe(true)
  expect(realApplies(calls).length).toBe(1)
  expect((await git.status(io)).text).toContain('統合済み・未検証')
  expect(await git.pendingSummary(io)).toContain('統合済み・未検証')
  w.verify = 1
  expect((await git.verify(io, cfg, 't4')).ok).toBe(false)
  expect((await git.status(io)).text).not.toContain('完了 (')
  w.verify = 0
  expect((await git.verify(io, cfg, 't4')).text).toContain('完了')
  expect(await git.pendingSummary(io)).toBeUndefined()
})

test('同じファイルを触る別タスクを検出し、読み取りタスクは worktree を作らない', async () => {
  const w = world()
  const { io, calls } = fakeIo(w)
  await git.assign(io, cfg, { id: 'a', scope: ['src'] })
  await git.assign(io, cfg, { id: 'b', scope: ['src'] })
  expect((await git.assign(io, cfg, { id: 'r', mode: 'read' })).ok).toBe(true)
  expect((await git.assign(io, cfg, { id: 'x', scope: [] })).ok).toBe(false)
  w.changes['/r/../r-workspaces/a'] = ['src/a.ts']
  w.changes['/r/../r-workspaces/b'] = ['src/a.ts']
  expect((await git.check(io, 'a')).text).toContain('overlap')
  expect(calls.filter(c => c.argv[1] === 'worktree').length).toBe(2)
})

test('回収は差分を保存するだけで、worktree・ブランチ・変更を消さない', async () => {
  const w = world()
  const { io, calls, files } = fakeIo(w)
  await git.assign(io, cfg, { id: 'c', scope: ['src'] })
  w.changes['/r/../r-workspaces/c'] = ['src/new.ts']
  const r = await git.collect(io, undefined)
  expect(r.ok).toBe(true)
  expect([...files.keys()].some(k => k.endsWith('.patch'))).toBe(true)
  expect(calls.flatMap(c => c.argv).filter(a => FORBIDDEN.includes(a))).toEqual([])
  expect(calls.filter(c => c.argv[1] === 'worktree' && c.argv[2] !== 'add')).toEqual([])
})
