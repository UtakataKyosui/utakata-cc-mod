// 実際の git で、submodule として checkout されたリポジトリを検出できるかを確かめる。
// submodule 自身では `.gitmodules` が追跡されず、git-dir と common-dir も一致するため、
// 既存の検査 (hasSubmodules・linkedWorktree) では保護できない。モックでは見えない差なので実 git で検証する。
//   bun test ./tests/integration/repo-storage-submodule.itest.ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root = ''
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' }
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'protocol.file.allow=always', ...args], { env })
  return { code: r.exitCode, out: r.stdout.toString().trim() }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rsm-sub-'))
  git(root, 'init', '-q', 'child')
  git(join(root, 'child'), 'commit', '-q', '--allow-empty', '-m', 'c')
  git(root, 'init', '-q', 'super')
  expect(git(join(root, 'super'), 'submodule', 'add', '-q', join(root, 'child'), 'child').code).toBe(0)
  git(join(root, 'super'), 'commit', '-q', '-m', 's')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('submodule の checkout は superproject を返し、従来の 2 つの検査では見えない', () => {
  const sub = join(root, 'super', 'child')
  // 新しい検査: 親のパスが取れる
  const sp = git(sub, 'rev-parse', '--show-superproject-working-tree')
  expect(sp.code).toBe(0)
  expect(sp.out.endsWith('/super')).toBe(true)
  // 従来の検査をすり抜けることの確認 (指摘された状況)
  expect(git(sub, 'ls-files', '--', '.gitmodules').out).toBe('')
  const dirs = git(sub, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').out.split('\n')
  expect(dirs[0]).toBe(dirs[1])
})

test('通常のリポジトリや superproject 自身では、親は空', () => {
  expect(git(join(root, 'super'), 'rev-parse', '--show-superproject-working-tree').out).toBe('')
  expect(git(join(root, 'child'), 'rev-parse', '--show-superproject-working-tree').out).toBe('')
})
