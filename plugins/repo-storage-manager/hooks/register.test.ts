import { test, expect } from 'claude-code/testing'
import {
  type Observation, classify, formatReport, parseBranches, parseDu, parseNcdu, parseStatus, parentOf, parseWorktrees, readConfig, sanitize,
} from './policy'

const NOW = 1_800_000_000
const clean: Observation = {
  path: '/r/a', currentDir: false, activeWorktree: false, failed: false, bare: false, hasSubmodules: false, extraWorktrees: 0,
  status: { dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: true, detached: false },
  branches: { noUpstream: [], ahead: [] }, stash: 0, lastCommitEpoch: NOW - 400 * 86400,
}

test('古くてクリーンでも CANDIDATE 止まり、リモート未検証を理由に残す', () => {
  expect(classify(clean, NOW, 180)).toEqual({ category: 'CANDIDATE', reasons: ['STALE', 'REMOTE_UNVERIFIED'] })
  expect(classify({ ...clean, lastCommitEpoch: NOW - 86400 }, NOW, 180).category).toBe('PROTECTED')
})

test('保護・dirty・unknown は安全側に倒す', () => {
  expect(classify({ ...clean, currentDir: true }, NOW, 180).reasons).toContain('CURRENT_DIR')
  expect(classify({ ...clean, extraWorktrees: 1 }, NOW, 180).category).toBe('PROTECTED')
  expect(classify({ ...clean, bare: true }, NOW, 180).category).toBe('PROTECTED')
  expect(classify({ ...clean, hasSubmodules: true }, NOW, 180).category).toBe('PROTECTED')
  expect(classify({ ...clean, failed: true }, NOW, 180).category).toBe('UNKNOWN')
  expect(classify({ ...clean, stash: undefined }, NOW, 180).category).toBe('UNKNOWN')
  expect(classify({ ...clean, lastCommitEpoch: undefined }, NOW, 180).reasons).toEqual(['NO_COMMITS'])
  expect(classify({ ...clean, stash: 2 }, NOW, 180)).toEqual({ category: 'DIRTY', reasons: ['STASH'] })
  expect(classify({ ...clean, branches: { noUpstream: ['x'], ahead: [] } }, NOW, 180).reasons).toContain('NO_UPSTREAM')
  expect(classify({ ...clean, status: { ...clean.status!, ahead: 1 } }, NOW, 180).reasons).toContain('UNPUSHED')
  expect(classify({ ...clean, status: { ...clean.status!, dirty: 1, untracked: 1 } }, NOW, 180).reasons).toEqual(['UNCOMMITTED', 'UNTRACKED'])
})

test('git 出力の解析', () => {
  expect(parseStatus('# branch.upstream o/m\n# branch.ab +2 -1\n1 .M x\n? y\n? z').valueOf()).toEqual({ dirty: 1, untracked: 2, ahead: 2, behind: 1, hasUpstream: true, detached: false })
  expect(parseBranches('main\torigin/main\t\nfeat\t\t\nfix\torigin/fix\t[ahead 1]')).toEqual({ noUpstream: ['feat'], ahead: ['fix'] })
  const wt = parseWorktrees('worktree /a b/日本語\nbranch refs/heads/main\n\nworktree /w\ndetached\nprunable gone')
  expect(wt.map(w => [w.path, w.branch, w.isMain, w.prunable])).toEqual([['/a b/日本語', 'main', true, false], ['/w', '(detached)', false, true]])
})

test('サイズの解析: ncdu JSON と du、壊れた入力は undefined', () => {
  const doc = [1, 2, { progname: 'gdu' }, [{ name: '/r' }, { name: 'a', asize: 10, dsize: 4096 }, [{ name: 'd' }, { name: 'b', asize: 5, dsize: 4096 }]]]
  expect(parseNcdu(JSON.stringify(doc))).toEqual({ apparent: 15, usage: 8192 })
  expect(parseNcdu('{broken')).toBeUndefined()
  expect(parseNcdu('[1,2]')).toBeUndefined()
  expect(parseDu('12\t/r/日本語 x')).toBe(12288)
  expect(parseDu('')).toBeUndefined()
})

test('設定・ネスト・無害化・報告', () => {
  expect(readConfig({ scanRoots: '/a, rel, /b', maxDepth: 99 })).toMatchObject({ scanRoots: ['/a', '/b'], maxDepth: 8, staleDays: 180 })
  expect(readConfig({ scanRoots: ['/x', 'rel', '/y\0z', 5] }).scanRoots).toEqual(['/x'])
  expect(readConfig({ staleDays: 'abc', topN: 0 })).toMatchObject({ staleDays: 180, topN: 1 })
  expect(parentOf('/r/a/sub', ['/r/a', '/r/a/sub', '/r/b'])).toBe('/r/a')
  expect(sanitize('a\x1b[31mb\x07c')).toBe('ab?c')
  const text = formatReport({
    schema: 'repo-storage-report-1', readOnly: true, generatedAt: '', degraded: ['gdu 未導入'], totalDiscovered: 1, analyzed: 1, skipped: 0,
    counts: { PROTECTED: 0, DIRTY: 0, UNKNOWN: 0, CANDIDATE: 1 },
    repos: [{ path: '/r/a', source: 'ghq', verdict: classify(clean, NOW, 180), usageBytes: 2048, apparentBytes: undefined, sizeSource: 'du', lastCommit: '2025-01-01', branchesNoUpstream: 0, stash: 0, extraWorktrees: 0, nestedIn: undefined, caches: [{ name: 'node_modules', path: '/r/a/node_modules', bytes: 1024, ignored: false }] }],
  }, 5)
  expect(text).toContain('削除許可ではない')
  expect(text).toContain('gitignore されていない')
  expect(text).toContain('回収可能量')
})

import { gduExportNew as gduNew } from '../fixtures/gdu-export-new'
import { gduExportOld as gduOld } from '../fixtures/gdu-export-old'
import { reportSample as sample } from '../fixtures/report-sample'
import { EXIT, compareVersions, createRun, parseJson, parseVersion, probe, validArgv } from './runner'
import { CATEGORIES, REASONS, SCHEMA_VERSION } from './types'
import { filterReport } from './policy'


test('ncdu: 新旧どちらの gdu 形式でも二重計上しない', () => {
  expect(parseNcdu(JSON.stringify(gduNew))).toEqual({ apparent: 4096 + 10 + 4096 + 4, usage: 4096 + 4096 + 4096 + 0 })
  expect(parseNcdu(JSON.stringify(gduOld))).toEqual({ apparent: 14, usage: 8192 })
})

test('runner: 不正な argv・例外・出力上限・終了コードは fail-closed', async () => {
  expect(validArgv(['git', 'status'])).toBe(true)
  expect(validArgv([])).toBe(false)
  expect(validArgv(['a\0b'])).toBe(false)
  expect(validArgv('git status')).toBe(false)
  const ok = createRun(async () => ({ exitCode: 0, stdout: 'x', stderr: '' }))
  expect((await ok(['git'])).stdout).toBe('x')
  expect((await ok(['a\0'])).exitCode).toBe(EXIT.INVALID_ARGV)
  const boom = createRun(async () => { throw new Error('ENOENT') })
  expect((await boom(['nope'])).exitCode).toBe(EXIT.SPAWN_FAILED)
  const big = createRun(async () => ({ exitCode: 0, stdout: 'x'.repeat(11), stderr: '' }), 10)
  expect(await big(['git'])).toMatchObject({ exitCode: EXIT.OUTPUT_TOO_LARGE, stdout: '' })
  const failing = createRun(async () => ({ exitCode: 2, stdout: 'partial', stderr: 'e' }))
  expect((await failing(['git'])).exitCode).toBe(2)
})

test('runner: JSON の検証とバージョン検査', async () => {
  const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
  expect(parseJson('[1]', isArr)).toEqual([1])
  expect(parseJson('{"a":1}', isArr)).toBeUndefined()
  expect(parseJson('{broken', isArr)).toBeUndefined()
  expect(parseVersion('gdu version v5.31.0 built')).toEqual([5, 31, 0])
  expect(parseVersion('no digits')).toBeUndefined()
  expect(compareVersions([1, 2, 0], [1, 10, 0])).toBeLessThan(0)
  const run = (r: { exitCode: number; stdout: string }) => createRun(async () => ({ ...r, stderr: '' }))
  expect(await probe(run({ exitCode: 0, stdout: 'v1.2.3' }), ['x', '--version'], [1, 0, 0])).toEqual({ state: 'ok', version: [1, 2, 3] })
  expect((await probe(run({ exitCode: 0, stdout: 'v0.9.0' }), ['x'], [1, 0, 0])).state).toBe('too-old')
  expect((await probe(run({ exitCode: 0, stdout: 'hello' }), ['x'])).state).toBe('unparseable')
  expect((await probe(run({ exitCode: 1, stdout: '' }), ['x'])).state).toBe('failed')
  expect((await probe(run({ exitCode: 127, stdout: '' }), ['x'])).state).toBe('missing')
  expect((await probe(createRun(async () => { throw new Error('x') }), ['x'])).state).toBe('missing')
})

test('スキーマ契約: サンプル JSON が型の語彙と一致し、削除許可を示す語を持たない', () => {
  const s = structuredClone(sample) as any
  expect(s.schema).toBe(SCHEMA_VERSION)
  expect(s.readOnly).toBe(true)
  for (const r of s.repos) {
    expect(CATEGORIES).toContain(r.verdict.category)
    r.verdict.reasons.forEach((x: string) => expect(REASONS).toContain(x))
  }
  expect(Object.keys(s.counts).sort()).toEqual([...CATEGORIES].sort())
  expect(JSON.stringify(s)).not.toMatch(/deletable|safeToDelete|reclaimable/i)
})

test('絞り込み: 分類・サイズ・古さ。使用量不明は落とさない', () => {
  const base = structuredClone(sample) as any
  const mk = (path: string, category: string, reasons: string[], usageBytes?: number) => ({ ...base.repos[0], path, verdict: { category, reasons }, usageBytes })
  const r = { ...base, repos: [mk('/a', 'DIRTY', ['STASH'], 10), mk('/b', 'CANDIDATE', ['STALE'], 100), mk('/c', 'UNKNOWN', ['GIT_FAILED'], undefined)] }
  expect(filterReport(r, { category: 'DIRTY' }).repos.map((x: { path: string }) => x.path)).toEqual(['/a'])
  expect(filterReport(r, { min_bytes: 50 }).repos.map((x: { path: string }) => x.path)).toEqual(['/b', '/c'])
  expect(filterReport(r, { stale_only: true }).repos.map((x: { path: string }) => x.path)).toEqual(['/b'])
  expect(filterReport(r, {})).toBe(r)
})

import { scan } from './register'

/** コマンドの先頭語ごとに応答を返す偽の $.process.run。実機の CLI なしで scan を検証する。 */
const fake = (handlers: Record<string, (argv: string[]) => { exitCode: number; stdout: string; stderr?: string }>) => ({
  process: {
    run: async (argv: string[]) => {
      const key = argv[0] === 'git' ? `git ${argv[3] ?? ''}` : argv[0]!
      const h = handlers[key] ?? handlers[argv[0]!]
      if (!h) throw new Error(`ENOENT ${key}`)
      const r = h(argv)
      return { stderr: '', ...r }
    },
  },
})

const GIT_OK = {
  'git worktree': () => ({ exitCode: 0, stdout: 'worktree /w/日本語 repo\nbranch refs/heads/main\n' }),
  'git status': () => ({ exitCode: 0, stdout: '# branch.upstream o/m\n# branch.ab +0 -0\n' }),
  'git for-each-ref': () => ({ exitCode: 0, stdout: 'main\to/m\t\n' }),
  'git stash': () => ({ exitCode: 0, stdout: '' }),
  'git log': () => ({ exitCode: 0, stdout: '1500000000\n' }),
  'git ls-files': () => ({ exitCode: 0, stdout: '' }),
  'git rev-parse': () => ({ exitCode: 0, stdout: 'false\n' }),
  'git check-ignore': () => ({ exitCode: 0, stdout: '' }),
  find: (a: string[]) => ({ exitCode: 0, stdout: a.includes('-print0') && a.includes('--') ? '' : '' }),
  du: () => ({ exitCode: 0, stdout: '8\t/w\n' }),
  pwd: () => ({ exitCode: 0, stdout: '/elsewhere\n' }),
}

test('scan: ghq も gdu も無いとき scanRoots にフォールバックし、縮退を報告する', async () => {
  const $ = fake({ ...GIT_OK, find: () => ({ exitCode: 0, stdout: '/w/日本語 repo/.git\0' }) })
  const r = await scan($, readConfig({ scanRoots: '/w' }))
  expect(r.readOnly).toBe(true)
  expect(r.repos.map(x => x.path)).toEqual(['/w/日本語 repo'])
  expect(r.repos[0]!.verdict.category).toBe('CANDIDATE')
  expect(r.repos[0]!.sizeSource).toBe('du')
  expect(r.degraded.join('\n')).toContain('ghq 未導入')
  expect(r.degraded.join('\n')).toContain('gdu 未導入')
})

test('scan: git が失敗・タイムアウトしたリポジトリは UNKNOWN、他は継続する', async () => {
  const $ = fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/a/.git\0/w/b/.git\0' }),
    'git status': (a: string[]) => (a[2] === '/w/a' ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: '# branch.upstream o/m\n' }),
  })
  const r = await scan($, readConfig({ scanRoots: '/w' }))
  const by = Object.fromEntries(r.repos.map(x => [x.path, x.verdict]))
  expect(by['/w/a']).toEqual({ category: 'UNKNOWN', reasons: ['GIT_FAILED'] })
  expect(by['/w/b']!.category).toBe('CANDIDATE')
})

test('scan: 現在の作業ディレクトリ・追加 worktree・nested は保護または親を示し、読み取り以外のコマンドを実行しない', async () => {
  const seen: string[][] = []
  const $ = fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/p/.git\0/w/p/inner/.git\0' }),
    pwd: () => ({ exitCode: 0, stdout: '/w/p/inner/src\n' }),
    'git worktree': () => ({ exitCode: 0, stdout: 'worktree /w/p\nbranch refs/heads/main\n\nworktree /w/wt\nbranch refs/heads/x\n' }),
  })
  const orig = $.process.run
  $.process.run = async (argv: string[]) => { seen.push(argv); return orig(argv) }
  const r = await scan($, readConfig({ scanRoots: '/w' }))
  const inner = r.repos.find(x => x.path === '/w/p/inner')!
  expect(inner.verdict.reasons).toContain('CURRENT_DIR')
  expect(inner.nestedIn).toBe('/w/p')
  expect(r.repos.find(x => x.path === '/w/p')!.verdict.reasons).toContain('EXTRA_WORKTREE')
  const banned = /^(rm|mv|cp|ln|chmod|chown)$|^(fetch|push|pull|clean|gc|prune|reset|checkout|worktree-remove)$/
  for (const argv of seen) {
    expect(argv[0]).not.toMatch(banned)
    if (argv[0] === 'git') expect(argv[3]).not.toMatch(banned)
    if (argv[0] === 'git' && argv[3] === 'worktree') expect(argv[4]).toBe('list')
  }
})

test('レビュー指摘: submodule 確認の失敗・detached HEAD・読み取りエラーのある ncdu は安全側に倒す', async () => {
  expect(parseStatus('# branch.head (detached)\n').detached).toBe(true)
  expect(classify({ ...clean, status: { ...clean.status!, detached: true } }, NOW, 180)).toEqual({ category: 'DIRTY', reasons: ['DETACHED_HEAD'] })
  expect(parseNcdu('[1,2,{},[{"name":"r","read_error":true}]]')).toBeUndefined()
  expect(parseNcdu('[1,2,{},[{"name":"r"},[{"name":"d","read_error":true},{"name":"f","asize":1,"dsize":1}]]]')).toBeUndefined()
  const $ = fake({ ...GIT_OK, find: () => ({ exitCode: 0, stdout: '/w/a/.git\0' }), 'git ls-files': () => ({ exitCode: 128, stdout: '' }) })
  const r = await scan($, readConfig({ scanRoots: '/w' }))
  expect(r.repos[0]!.verdict).toEqual({ category: 'UNKNOWN', reasons: ['GIT_FAILED'] })
})
