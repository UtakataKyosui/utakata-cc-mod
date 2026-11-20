import { test, expect } from 'claude-code/testing'
import {
  type Observation, classify, formatReport, parseBranches, parseDu, parseNcdu, parseStatus, parentOf, parseWorktrees, readConfig, sanitize,
} from './policy'

const NOW = 1_800_000_000
const clean: Observation = {
  path: '/r/a', currentDir: false, activeWorktree: false, failed: false, bare: false, linkedWorktree: false, hasSubmodules: false, extraWorktrees: 0,
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
  expect(wt.map(w => [w.path, w.branch, w.isMain, w.isPrunable])).toEqual([['/a b/日本語', 'main', true, false], ['/w', '(detached)', false, true]])
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
    repos: [{ path: '/r/a', source: 'ghq', verdict: classify(clean, NOW, 180), usageBytes: 2048, apparentBytes: undefined, sizeSource: 'du', lastCommit: '2025-01-01', branchesNoUpstream: 0, stash: 0, extraWorktrees: 0, nestedIn: undefined, caches: [{ name: 'node_modules', path: '/r/a/node_modules', bytes: 1024, ignored: false, tracked: false, class: 'UNKNOWN_REGEN', regen: undefined, evidence: ['gitignore されていない (固有のデータの可能性)'] }] }],
  }, 5)
  expect(text).toContain('削除許可ではない')
  expect(text).toContain('gitignore されていない')
  expect(text).toContain('UNKNOWN_REGEN')
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
  clock: { now: async () => 1_000_000 },
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
  'git log': (a: string[]) => ({ exitCode: 0, stdout: a.includes('-g') ? '1500000000\n' : '1500000000\n' }),
  'git ls-files': () => ({ exitCode: 0, stdout: '' }),
  'git rev-parse': (a: string[]) => ({ exitCode: 0, stdout: a.includes('--show-superproject-working-tree') ? '' : `false\n${a[2]}/.git\n${a[2]}/.git\n` }),
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

import { CACHE_NAMES, classifyCache } from './policy'

test('生成物の分類: 追跡対象・未 ignore・根拠なしは再生成可能扱いにしない (#36)', () => {
  expect(classifyCache('node_modules', ['package.json'], true, false)).toMatchObject({ class: 'REGENERABLE_LIKELY' })
  expect(classifyCache('node_modules', ['package.json'], true, true).class).toBe('PROTECTED_DATA')
  expect(classifyCache('node_modules', ['package.json'], false, false).class).toBe('UNKNOWN_REGEN')
  expect(classifyCache('node_modules', [], true, false).class).toBe('UNKNOWN_REGEN')
  expect(classifyCache('dist', ['package.json'], true, false).class).toBe('UNKNOWN_REGEN')
  expect(classifyCache('build', [], true, false).regen).toBeUndefined()
  expect(classifyCache('target', ['Cargo.toml'], undefined, false).class).toBe('UNKNOWN_REGEN')
  expect(classifyCache('target', ['Cargo.toml'], true, undefined).class).toBe('UNKNOWN_REGEN')
  expect(classifyCache('__pycache__', [], true, false).class).toBe('REGENERABLE_LIKELY')
  expect(CACHE_NAMES).toContain('dist')
})

test('scan: linked worktree は保護し、同一 common-dir の二重登録 (symlink 経由) は 1 件にまとめる (#32)', async () => {
  const $ = fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/main/.git\0/w/link-to-main/.git\0/w/wt/.git\0' }),
    'git rev-parse': (a: string[]) => {
      const p = a[2]!
      if (a.includes('--show-superproject-working-tree')) return { exitCode: 0, stdout: '' }
      if (p === '/w/wt') return { exitCode: 0, stdout: 'false\n/w/main/.git/worktrees/wt\n/w/main/.git\n' }
      return { exitCode: 0, stdout: 'false\n/w/main/.git\n/w/main/.git\n' }
    },
  })
  const r = await scan($, readConfig({ scanRoots: ['/w'] }))
  expect(r.repos.map(x => x.path)).toEqual(['/w/main', '/w/wt'])
  expect(r.repos[1]!.verdict).toEqual({ category: 'PROTECTED', reasons: ['LINKED_WORKTREE'] })
  expect(r.degraded.join('\n')).toContain('重複を除外: /w/link-to-main')
})

test('scan: rev-parse が古い git などで 3 行返さないときは UNKNOWN', async () => {
  const $ = fake({ ...GIT_OK, find: () => ({ exitCode: 0, stdout: '/w/a/.git\0' }), 'git rev-parse': (a: string[]) => ({ exitCode: 0, stdout: a.includes('--show-superproject-working-tree') ? '' : 'false\n' }) })
  expect((await scan($, readConfig({ scanRoots: ['/w'] }))).repos[0]!.verdict.category).toBe('UNKNOWN')
})

import { type Destination, formatPlan, planOne } from './plan'
import { plan } from './register'

const repoReport = (over: Partial<import('./policy').RepoReport> = {}) => ({
  ...structuredClone(sample.repos[0]) as any, path: '/r/old', ...over,
}) as import('./policy').RepoReport
const dest = (over: Partial<Destination> = {}): Destination => ({ path: '/backup', exists: true, writable: true, fs: { mount: '/mnt/b' }, ...over })
const cache = (class_: any, bytes = 100) => ({ name: 'node_modules', path: '/r/old/node_modules', bytes, ignored: true, tracked: false, class: class_, regen: 'npm install', evidence: [] })

test('保全計画: 同一ファイルシステムへの退避は容量を回収しないと示し、別FSなら推定値を出す (#38)', () => {
  const same = planOne(repoReport(), 'archive', dest({ fs: { mount: '/' } }), '/')
  expect(same.status).toBe('PLANNED')
  expect(same.estimatedReclaimBytes).toBe(0)
  expect(same.reclaimNote).toContain('空き容量は増えない')
  const other = planOne(repoReport({ usageBytes: 5000 }), 'relocate', dest(), '/')
  expect(other.estimatedReclaimBytes).toBe(5000)
  expect(other.reclaimNote).toContain('この計画では削除しない')
  expect(planOne(repoReport(), 'archive', dest({ fs: { mount: undefined } }), '/').estimatedReclaimBytes).toBeUndefined()
})

test('保全計画: 復元検証できない退避先・CANDIDATE 以外・状態不明は除外し、手順は実行しない', () => {
  expect(planOne(repoReport(), 'archive', dest({ exists: false, writable: false }), '/').excluded).toEqual(expect.arrayContaining(['DESTINATION_UNUSABLE', 'RESTORE_UNCHECKABLE']))
  expect(planOne(repoReport(), 'archive', undefined, '/').excluded).toContain('NO_DESTINATION')
  const dirty = repoReport({ verdict: { category: 'DIRTY', reasons: ['STASH'] } })
  expect(planOne(dirty, 'relocate', dest(), '/').excluded).toContain('NOT_CANDIDATE')
  const unk = repoReport({ verdict: { category: 'UNKNOWN', reasons: ['GIT_FAILED'] } })
  expect(planOne(unk, 'cache-only', undefined, '/').excluded).toContain('STATE_UNKNOWN')
  const cur = repoReport({ verdict: { category: 'PROTECTED', reasons: ['CURRENT_DIR'] }, caches: [cache('REGENERABLE_LIKELY') as any] })
  expect(planOne(cur, 'cache-only', undefined, '/').excluded).toContain('CURRENT_DIR')
  const item = planOne(repoReport(), 'archive', dest(), '/')
  expect(item.steps[0]![0]).toContain('dry-run')
  expect(item.restoreRehearsal.join('\n')).toContain('元を残し、操作を拒否')
  expect(item.requiresBeforeExecution.join('')).toContain('明示承認')
})

test('保全計画: cache-only は再生成できそうな生成物だけを対象にする', () => {
  const r = repoReport({ caches: [cache('REGENERABLE_LIKELY', 300) as any, cache('UNKNOWN_REGEN', 900) as any, cache('PROTECTED_DATA', 50) as any] })
  const i = planOne(r, 'cache-only', undefined, '/')
  expect(i.status).toBe('PLANNED')
  expect(i.estimatedReclaimBytes).toBe(300)
  expect(planOne(repoReport({ caches: [cache('UNKNOWN_REGEN') as any] }), 'cache-only', undefined, '/').excluded).toContain('NO_REGENERABLE_CACHE')
  expect(formatPlan({ schema: 'repo-preservation-plan-draft-1', planId: 'RSM-0123456789', dryRun: true, items: [i], degraded: [] })).toContain('実行許可ではない')
})

test('plan: 計画の作成で読み取り系以外のコマンドを実行しない', async () => {
  const seen: string[][] = []
  const $ = fake({
    ...GIT_OK,
    df: () => ({ exitCode: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 1 99 1% /mnt/x\n' }),
    test: () => ({ exitCode: 0, stdout: '' }),
  })
  const orig = $.process.run
  $.process.run = async (argv: string[]) => { seen.push(argv); return orig(argv) }
  const p = await plan($, readConfig(undefined), { paths: ['/w/日本語 repo'], operation: 'archive', destination: '/backup' })
  expect(p.dryRun).toBe(true)
  expect(p.items[0]!.sameFilesystem).toBe(true)
  const allowed = new Set(['git', 'find', 'du', 'pwd', 'df', 'test', 'ghq', 'gdu', 'reposcan'])
  for (const argv of seen) expect(allowed.has(argv[0]!)).toBe(true)
  expect(seen.some(a => a[0] === 'git' && ['bundle', 'clone', 'fetch', 'push'].includes(a[3] ?? ''))).toBe(false)
})

import { applySignal, byPath, parseReposcan, signalOf } from './reposcan'

const RS = (over: object = {}) => JSON.stringify({
  version: 1, totalScannedRepos: 1, generatedAt: '2026-11-20T00:00:00Z', warnings: [],
  repoStates: [{ id: 'x', path: '/w/日本語 repo', repo: 'r', vcsType: 'git', branch: 'main', uncommitedFiles: [], remoteStatus: [{ remote: 'origin', ahead: 0, behind: 2 }], stashes: [], ...over }],
})

test('reposcan: 公開型の JSON を検証して取り込み、壊れた・形の違う出力は使わない (#34)', () => {
  expect(parseReposcan(RS())?.repoStates[0]!.remoteStatus[0]!.behind).toBe(2)
  // Go の nil slice は null で出る
  expect(parseReposcan(RS({ uncommitedFiles: null, stashes: null, remoteStatus: null }))?.repoStates[0]).toMatchObject({ uncommitedFiles: [], stashes: [], remoteStatus: [] })
  // 初回の通知文が前後に混ざっていても取り出せる
  expect(parseReposcan(`telemetry notice...\n${RS()}\n`)?.version).toBe(1)
  expect(parseReposcan('{broken')).toBeUndefined()
  expect(parseReposcan('no json')).toBeUndefined()
  expect(parseReposcan(JSON.stringify({ version: 'x', repoStates: [] }))).toBeUndefined()
  expect(parseReposcan(RS({ path: 'relative' }))).toBeUndefined()
  expect(parseReposcan(RS({ remoteStatus: [{ ahead: -1, behind: 0 }] }))).toBeUndefined()
  expect(byPath(parseReposcan(RS())!).has('/w/日本語 repo')).toBe(true)
})

test('reposcan: 信号は判定を保守側にしか動かさない', () => {
  const cand = { category: 'CANDIDATE' as const, reasons: ['STALE' as const, 'REMOTE_UNVERIFIED' as const] }
  const sig = (over: object) => signalOf({ ...parseReposcan(RS())!.repoStates[0]!, ...over } as any)
  expect(applySignal(cand, sig({}))).toBe(cand) // behind は無視
  expect(applySignal(cand, sig({ uncommitedFiles: ['a'] }))).toEqual({ category: 'DIRTY', reasons: ['SIGNAL_CONFLICT'] })
  expect(applySignal(cand, sig({ remoteStatus: [{ ahead: 1, behind: 0 }] })).category).toBe('DIRTY')
  expect(applySignal(cand, sig({ stashes: ['s'] })).category).toBe('DIRTY')
  expect(applySignal(cand, undefined)).toBe(cand)
  const dirty = { category: 'DIRTY' as const, reasons: ['STASH' as const] }
  expect(applySignal(dirty, sig({}))).toBe(dirty) // 信号が「きれい」でも DIRTY は変えない
  const prot = { category: 'PROTECTED' as const, reasons: ['RECENT' as const] }
  expect(applySignal(prot, sig({ uncommitedFiles: ['a'] }))).toBe(prot)
})

test('scan: reposcan を --no-telemetry 付きで呼び、git がきれいでも reposcan が dirty と言えば CANDIDATE にしない。失敗時は判定を変えず縮退を報告する', async () => {
  const seen: string[][] = []
  const mk = (rs: () => { exitCode: number; stdout: string }) => fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/a/.git\0' }),
    reposcan: (a: string[]) => { seen.push(a); return a.includes('--version') ? { exitCode: 0, stdout: 'reposcan 1.0.0' } : rs() },
  })
  const dirtyJson = JSON.stringify({ version: 1, warnings: [], repoStates: [{ path: '/w/a', vcsType: 'git', uncommitedFiles: ['x'], remoteStatus: [], stashes: [] }] })
  const r = await scan(mk(() => ({ exitCode: 0, stdout: dirtyJson })), readConfig({ scanRoots: ['/w'] }))
  expect(r.repos[0]!.verdict).toEqual({ category: 'DIRTY', reasons: ['SIGNAL_CONFLICT'] })
  expect(r.repos[0]!.signals).toMatchObject({ uncommitted: 1 })
  const call = seen.find(a => a.includes('-o'))!
  expect(call).toEqual(['reposcan', '-r', '/w', '-f', 'all', '-o', 'json', '--no-telemetry'])
  const bad = await scan(mk(() => ({ exitCode: 0, stdout: '{broken' })), readConfig({ scanRoots: ['/w'] }))
  expect(bad.repos[0]!.verdict.category).toBe('CANDIDATE')
  expect(bad.degraded.join('\n')).toContain('JSON の形が想定と違う')
  const failed = await scan(mk(() => ({ exitCode: 2, stdout: '' })), readConfig({ scanRoots: ['/w'] }))
  expect(failed.repos[0]!.verdict.category).toBe('CANDIDATE')
  const none = await scan(fake({ ...GIT_OK, find: () => ({ exitCode: 0, stdout: '/w/a/.git\0' }) }), readConfig({ scanRoots: ['/w'] }))
  expect(none.degraded.join('\n')).toContain('reposcan 未導入')
})

import { activityOf, lastActivityOf } from './policy'

test('活動日時: コミットと reflog の新しいほう。最近 checkout したリポジトリは古いとみなさない (#35)', () => {
  expect(lastActivityOf({ lastCommitEpoch: 100, lastReflogEpoch: 200 })).toEqual({ epoch: 200, source: 'reflog' })
  expect(lastActivityOf({ lastCommitEpoch: 300, lastReflogEpoch: 200 })).toEqual({ epoch: 300, source: 'commit' })
  expect(lastActivityOf({ lastCommitEpoch: 100, lastReflogEpoch: undefined })).toEqual({ epoch: 100, source: 'commit' })
  expect(lastActivityOf({ lastCommitEpoch: undefined, lastReflogEpoch: 50 })).toEqual({ epoch: 50, source: 'reflog' })
  expect(lastActivityOf({ lastCommitEpoch: undefined, lastReflogEpoch: undefined })).toEqual({ epoch: undefined, source: undefined })
  // コミットは古いが、先週 pull / checkout した
  const used = { ...clean, lastCommitEpoch: NOW - 400 * 86400, lastReflogEpoch: NOW - 7 * 86400 }
  expect(classify(used, NOW, 180)).toEqual({ category: 'PROTECTED', reasons: ['RECENT'] })
  // reflog も古ければ CANDIDATE のまま
  expect(classify({ ...used, lastReflogEpoch: NOW - 300 * 86400 }, NOW, 180).category).toBe('CANDIDATE')
  // reflog が取れなくても、コミット日時だけで従来どおり判定する
  expect(classify({ ...clean, lastReflogEpoch: undefined }, NOW, 180).category).toBe('CANDIDATE')
})

test('活動の区分と表示 (表示用で、削除許可ではない)', () => {
  expect(activityOf(NOW - 5 * 86400, NOW, 180)).toBe('ACTIVE')
  expect(activityOf(NOW - 100 * 86400, NOW, 180)).toBe('RECENT')
  expect(activityOf(NOW - 200 * 86400, NOW, 180)).toBe('STALE')
  expect(activityOf(undefined, NOW, 180)).toBe('UNKNOWN')
})

test('scan: reflog が新しければ、コミットが古くても CANDIDATE にせず、最終活動と出所を報告する', async () => {
  const $ = fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/a/.git\0/w/b/.git\0' }),
    'git log': (a: string[]) => ({ exitCode: 0, stdout: a.includes('-g') ? (a[2] === '/w/a' ? `HEAD@{${Math.floor(Date.now() / 1000) - 86400}}\n` : '') : '1500000000\n' }),
  })
  const r = await scan($, readConfig({ scanRoots: ['/w'] }))
  const by = Object.fromEntries(r.repos.map(x => [x.path, x]))
  expect(by['/w/a']!.verdict).toEqual({ category: 'PROTECTED', reasons: ['RECENT'] })
  expect(by['/w/a']!.activitySource).toBe('reflog')
  expect(by['/w/a']!.activity).toBe('ACTIVE')
  expect(by['/w/b']!.verdict.category).toBe('CANDIDATE')
  expect(by['/w/b']!.activitySource).toBe('commit')
  expect(by['/w/b']!.activity).toBe('STALE')
  const text = formatReport(r, 10, 'activity')
  expect(text).toContain('最終活動')
  expect(text.indexOf('/w/b')).toBeLessThan(text.indexOf('/w/a'))
})

import { REFLOG_ARGS, parseReflogEpoch } from './policy'

test('reflog の時刻は %gd (HEAD@{epoch}) から取る。%ct はコミットの日時なので使わない', () => {
  expect([...REFLOG_ARGS]).toEqual(['log', '-g', '-1', '--date=unix', '--format=%gd', 'HEAD'])
  expect(REFLOG_ARGS.join(' ')).not.toContain('%ct')
  expect(parseReflogEpoch('HEAD@{1795193345}\n')).toBe(1795193345)
  expect(parseReflogEpoch('')).toBeUndefined()
  expect(parseReflogEpoch('1500000000')).toBeUndefined()
  expect(parseReflogEpoch('HEAD@{2}')).toBeUndefined()
})

import { isAffirmative } from './exec'

test('レビュー指摘: 否定・曖昧な回答は承認にならない。肯定は明示した形の完全一致だけ', () => {
  for (const ok of ['はい', 'はい、実行する', 'はい、削除する', '実行する', '承認する', '承認', 'yes', 'Yes', 'approve', ' はい。 ']) expect(isAffirmative(ok)).toBe(true)
  for (const ng of ['いいえ', '実行しません', '承認できません', 'do not approve', 'don\'t approve', '削除しない', '実行はまだ', 'Other: はい、でも待って', 'いいえ、実行しない', '', 'no', 'not yes'])
    expect(isAffirmative(ng)).toBe(false)
})

test('レビュー指摘: submodule として checkout されたリポジトリは PROTECTED にする', async () => {
  const $ = fake({
    ...GIT_OK,
    find: () => ({ exitCode: 0, stdout: '/w/super/child/.git\0' }),
    'git rev-parse': (a: string[]) => ({ exitCode: 0, stdout: a.includes('--show-superproject-working-tree') ? '/w/super\n' : `false\n${a[2]}/.git\n${a[2]}/.git\n` }),
  })
  const r = await scan($, readConfig({ scanRoots: ['/w'] }))
  expect(r.repos[0]!.verdict).toEqual({ category: 'PROTECTED', reasons: ['SUBMODULE_CHECKOUT'] })
  // 確認に失敗したら UNKNOWN
  const bad = fake({ ...GIT_OK, find: () => ({ exitCode: 0, stdout: '/w/a/.git\0' }), 'git rev-parse': (a: string[]) => (a.includes('--show-superproject-working-tree') ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `false\n${a[2]}/.git\n${a[2]}/.git\n` }) })
  expect((await scan(bad, readConfig({ scanRoots: ['/w'] }))).repos[0]!.verdict.category).toBe('UNKNOWN')
})
