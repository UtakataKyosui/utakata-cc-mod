// 実際の git で、repo-storage-manager が reflog の時刻を正しく取れるかを確かめる。
// モックでは「%ct はコミット日時で、reflog の時刻ではない」という誤りを検出できないため、実 git で検証する。
//   bun test ./tests/integration/repo-storage-reflog.itest.ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REFLOG_ARGS, lastActivityOf, parseReflogEpoch } from '../../plugins/repo-storage-manager/hooks/policy'

const OLD = 1_500_000_000
let dir = ''

/** 古い日付を与えるのはコミットを作るときだけ。checkout など他の操作の reflog は現在時刻で書かれる。 */
const run = (env: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env } })
  return { code: r.exitCode, out: r.stdout.toString() }
}
const git = (...args: string[]) => run({}, ...args)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsm-reflog-'))
  git('init', '-q')
  run({ GIT_COMMITTER_DATE: `@${OLD}`, GIT_AUTHOR_DATE: `@${OLD}` }, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'old')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('古いコミットのリポジトリを今 checkout したら、reflog の時刻は現在に近く、コミット日時ではない', () => {
  const now = Math.floor(Date.now() / 1000)
  expect(git('checkout', '-q', '-b', 'recent').code).toBe(0)
  const commit = Number(git('log', '-1', '--format=%ct').out.trim())
  expect(commit).toBe(OLD)
  // 従来の %ct は -g を付けてもコミットの日時を返す (指摘された誤り)
  expect(Number(git('log', '-g', '-1', '--format=%ct', 'HEAD').out.trim())).toBe(OLD)
  const r = git(...REFLOG_ARGS)
  expect(r.code).toBe(0)
  const reflog = parseReflogEpoch(r.out)!
  expect(reflog).toBeGreaterThanOrEqual(now - 5)
  expect(reflog).toBeLessThanOrEqual(now + 60)
  // 活動はコミットではなく reflog になり、古いとみなされない
  expect(lastActivityOf({ lastCommitEpoch: commit, lastReflogEpoch: reflog })).toEqual({ epoch: reflog, source: 'reflog' })
})

test('reflog が無いリポジトリでは失敗せず、undefined (コミット日時だけで判断する)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'rsm-noreflog-'))
  try {
    Bun.spawnSync(['git', '-C', empty, 'init', '-q'])
    const r = Bun.spawnSync(['git', '-C', empty, ...REFLOG_ARGS])
    expect(parseReflogEpoch(r.stdout.toString())).toBeUndefined()
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
