import { test, expect } from 'claude-code/testing'
import {
  type Observation, classify, formatReport, parseBranches, parseDu, parseNcdu, parseStatus, parentOf, parseWorktrees, readConfig, sanitize,
} from './policy'

const NOW = 1_800_000_000
const clean: Observation = {
  path: '/r/a', currentDir: false, activeWorktree: false, failed: false, bare: false, hasSubmodules: false, extraWorktrees: 0,
  status: { dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: true },
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
  expect(parseStatus('# branch.upstream o/m\n# branch.ab +2 -1\n1 .M x\n? y\n? z').valueOf()).toEqual({ dirty: 1, untracked: 2, ahead: 2, behind: 1, hasUpstream: true })
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
