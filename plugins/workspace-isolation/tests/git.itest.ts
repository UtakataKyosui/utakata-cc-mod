// 実 git の一時リポジトリでの通し検証。claude plugin test の環境にはプロセスがないため bun で実行する:
//   bun test ./plugins/workspace-isolation/tests/git.itest.ts
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as git from '../hooks/git'
import type { Io } from '../hooks/git'

const cfg = { verifyCommand: 'test "$(cat src/a.ts)" = two', worktreeRoot: '', guardDestructive: true, autoCollect: true }

const sh = (cwd: string, script: string): string => execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' })

const sandbox = () => {
  const base = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'ws-iso-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  sh(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && mkdir src docs')
  sh(repo, 'echo one > src/a.ts && echo doc > docs/d.md && echo other > other.txt && git add -A && git commit -q -m init')
  const io: Io = {
    run: async (argv, init) => {
      try {
        const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd: init?.cwd ?? repo, input: init?.stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        return { exitCode: 0, stdout, stderr: '' }
      } catch (e: any) {
        return { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
      }
    },
    read: async p => readFileSync(p, 'utf8'),
    write: async (p, t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    },
    exists: async p => existsSync(p),
  }
  return { io, repo, wt: (id: string) => join(base, 'repo-workspaces', id) }
}

test('割り当て・範囲外検出・ユーザー変更の保持・統合・検証', async () => {
  const { io, repo, wt } = sandbox()
  sh(repo, 'echo user-edit >> other.txt')
  expect((await git.assign(io, cfg, { id: 't1', scope: ['src'] })).ok).toBe(true)
  expect(sh(wt('t1'), 'git rev-parse --abbrev-ref HEAD').trim()).toBe('ws/t1')
  expect(sh(repo, 'cat other.txt')).toContain('user-edit')
  expect(sh(wt('t1'), 'cat other.txt')).not.toContain('user-edit')

  sh(wt('t1'), 'echo two > src/a.ts && echo oops > docs/d.md')
  const bad = await git.check(io, 't1')
  expect(bad.text).toContain('out-of-scope')
  expect((await git.integrate(io, 't1')).ok).toBe(false)
  expect(sh(repo, 'cat src/a.ts')).toBe('one\n')

  sh(wt('t1'), 'git checkout -q -- docs/d.md')
  expect((await git.verify(io, cfg, 't1')).ok).toBe(false)
  expect((await git.integrate(io, 't1')).ok).toBe(true)
  expect(sh(repo, 'cat src/a.ts')).toBe('two\n')
  expect(sh(repo, 'cat other.txt')).toContain('user-edit')
  expect(sh(repo, 'git log --oneline | wc -l').trim()).toBe('1')
  expect((await git.status(io)).text).toContain('統合済み・未検証')
  expect((await git.verify(io, cfg, 't1')).text).toContain('完了')
})

test('競合時は上書きせず、ユーザーの変更が残る', async () => {
  const { io, repo, wt } = sandbox()
  await git.assign(io, cfg, { id: 't2', scope: ['src'] })
  sh(wt('t2'), 'echo task > src/a.ts')
  sh(repo, 'echo user > src/a.ts')
  const r = await git.integrate(io, 't2')
  expect(r.ok).toBe(false)
  expect(sh(repo, 'cat src/a.ts')).toBe('user\n')
})

test('HEAD が進んで内容が食い違う場合も適用しない', async () => {
  const { io, repo, wt } = sandbox()
  await git.assign(io, cfg, { id: 't3', scope: ['src'] })
  sh(wt('t3'), 'echo task > src/a.ts')
  sh(repo, 'echo moved > src/a.ts && git commit -qam moved')
  const r = await git.integrate(io, 't3')
  expect(r.ok).toBe(false)
  expect(sh(repo, 'cat src/a.ts')).toBe('moved\n')
})

test('タスク間の重なりと新規ファイルの統合', async () => {
  const { io, repo, wt } = sandbox()
  await git.assign(io, cfg, { id: 'a', scope: ['src'] })
  await git.assign(io, cfg, { id: 'b', scope: ['src'] })
  sh(wt('a'), 'echo A > src/a.ts')
  sh(wt('b'), 'echo B > src/a.ts && echo n > src/new.ts')
  expect((await git.check(io, 'a')).text).toContain('overlap')
  sh(wt('b'), 'git checkout -q -- src/a.ts')
  expect((await git.integrate(io, 'b')).ok).toBe(true)
  expect(sh(repo, 'cat src/new.ts')).toBe('n\n')
})

test('回収は差分を保存し、worktree と未統合の変更を消さない', async () => {
  const { io, repo, wt } = sandbox()
  await git.assign(io, cfg, { id: 'c', scope: ['src'] })
  sh(wt('c'), 'echo kept > src/new.ts && echo changed > src/a.ts')
  const r = await git.collect(io, undefined)
  expect(r.ok).toBe(true)
  const patch = r.text.match(/(\S+\.patch)/)![1]!
  expect(readFileSync(patch, 'utf8')).toContain('src/new.ts')
  expect(sh(wt('c'), 'cat src/new.ts')).toBe('kept\n')
  expect(sh(wt('c'), 'cat src/a.ts')).toBe('changed\n')
  expect(sh(repo, 'git branch --list ws/c').trim()).toContain('ws/c')
})
