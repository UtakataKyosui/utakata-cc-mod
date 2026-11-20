import type { Register } from 'claude-code'
import {
  CACHE_NAMES, type CacheDir, type ReportOptions, filterReport, type Config, type Observation, type Report, type RepoReport, classify, dedupePaths, formatReport,
  parseBranches, parseDu, parseNcdu, parseStatus, parseWorktrees, parentOf, readConfig, sanitize,
} from './policy'
import { type Run, createRun, probe } from './runner'

const TOOL = 'mcp__repo-storage-manager__scan_repos'

/** 読み取り専用のコマンドだけを argv 配列で実行する (runner.ts: 出力上限・例外の吸収・argv 検証)。 */
const makeRun = ($: any): Run => createRun((argv, o) => $.process.run(argv, { timeoutMs: o.timeoutMs }))

const has = async (run: Run, name: string) => (await probe(run, [name, '--version'])).state !== 'missing'

async function discover(run: Run, cfg: Config, degraded: string[]): Promise<{ path: string; source: 'ghq' | 'scan-root' }[]> {
  const found: { path: string; source: 'ghq' | 'scan-root' }[] = []
  if (await has(run, 'ghq')) {
    const r = await run(['ghq', 'list', '-p'])
    if (r.exitCode === 0) r.stdout.split('\n').filter(Boolean).forEach(path => found.push({ path, source: 'ghq' }))
    else degraded.push(`ghq list に失敗: ${sanitize(r.stderr.trim()).slice(0, 200)}`)
  } else degraded.push('ghq 未導入: scanRoots のみを探索')
  for (const root of cfg.scanRoots) {
    const r = await run(['find', root, '-maxdepth', String(cfg.maxDepth + 1), '-name', '.git', '-prune', '-print0'])
    if (r.exitCode !== 0) { degraded.push(`scanRoot を探索できない: ${sanitize(root)}`); continue }
    r.stdout.split('\0').filter(Boolean).forEach(g => found.push({ path: g.replace(/\/\.git$/, ''), source: 'scan-root' }))
  }
  const unique = new Set(dedupePaths(found.map(f => f.path)))
  return found.filter(f => unique.delete(f.path.replace(/\/+$/, '')))
}

async function sizeOf(run: Run, path: string, gdu: boolean): Promise<{ usage?: number; apparent?: number; source: RepoReport['sizeSource'] }> {
  if (gdu) {
    const r = await run(['gdu', '--non-interactive', '--no-progress', '-o', '-', path], 120_000)
    const n = r.exitCode === 0 ? parseNcdu(r.stdout) : undefined
    if (n) return { usage: n.usage, apparent: n.apparent, source: 'gdu' }
  }
  const r = await run(['du', '-sk', '-x', path], 120_000)
  const b = r.exitCode === 0 ? parseDu(r.stdout) : undefined
  return b === undefined ? { source: 'unavailable' } : { usage: b, source: 'du' }
}

async function cachesOf(run: Run, path: string): Promise<CacheDir[]> {
  // -type d は symlink を辿らない。トップレベルのみ。
  const names = CACHE_NAMES.flatMap((n, i) => (i === 0 ? ['-name', n] : ['-o', '-name', n]))
  const r = await run(['find', path, '-maxdepth', '1', '-type', 'd', '(', ...names, ')', '-print0'])
  if (r.exitCode !== 0) return []
  return Promise.all(r.stdout.split('\0').filter(Boolean).map(async dir => {
    const name = dir.slice(dir.lastIndexOf('/') + 1)
    const du = await run(['du', '-sk', '-x', dir], 120_000)
    const ig = await run(['git', '-C', path, 'check-ignore', '-q', '--', name])
    return { name, path: dir, bytes: du.exitCode === 0 ? parseDu(du.stdout) : undefined, ignored: ig.exitCode === 0 ? true : ig.exitCode === 1 ? false : undefined }
  }))
}

async function analyze(run: Run, path: string, source: 'ghq' | 'scan-root', cwd: string, all: string[], cfg: Config, gdu: boolean, now: number): Promise<RepoReport> {
  const git = (...a: string[]) => run(['git', '-C', path, ...a])
  const [wt, st, br, stash, log, sub, bare] = await Promise.all([
    git('worktree', 'list', '--porcelain'),
    git('status', '--porcelain=v2', '--branch', '--untracked-files=normal'),
    git('for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'),
    git('stash', 'list'),
    git('log', '-1', '--format=%ct'),
    git('ls-files', '--', '.gitmodules'),
    git('rev-parse', '--is-bare-repository'),
  ])
  const worktrees = wt.exitCode === 0 ? parseWorktrees(wt.stdout) : []
  const obs: Observation = {
    path,
    currentDir: cwd === path || cwd.startsWith(`${path}/`),
    activeWorktree: false,
    failed: [wt, st, br, stash, bare].some(r => r.exitCode !== 0),
    bare: bare.stdout.trim() === 'true',
    hasSubmodules: sub.stdout.trim() !== '',
    extraWorktrees: Math.max(0, worktrees.length - 1),
    status: st.exitCode === 0 ? parseStatus(st.stdout) : undefined,
    branches: br.exitCode === 0 ? parseBranches(br.stdout) : undefined,
    stash: stash.exitCode === 0 ? stash.stdout.split('\n').filter(Boolean).length : undefined,
    lastCommitEpoch: log.exitCode === 0 && /^\d+$/.test(log.stdout.trim()) ? Number(log.stdout.trim()) : undefined,
  }
  const verdict = classify(obs, now, cfg.staleDays)
  const size = await sizeOf(run, path, gdu)
  return {
    path, source, verdict,
    usageBytes: size.usage, apparentBytes: size.apparent, sizeSource: size.source,
    lastCommit: obs.lastCommitEpoch === undefined ? undefined : new Date(obs.lastCommitEpoch * 1000).toISOString().slice(0, 10),
    branchesNoUpstream: obs.branches?.noUpstream.length ?? 0,
    stash: obs.stash,
    extraWorktrees: obs.extraWorktrees,
    nestedIn: parentOf(path, all),
    caches: await cachesOf(run, path),
  }
}

export async function scan($: any, cfg: Config): Promise<Report> {
  const run = makeRun($)
  const degraded: string[] = []
  const cwd = (await run(['pwd', '-P'])).stdout.trim()
  const found = await discover(run, cfg, degraded)
  const gdu = await has(run, 'gdu')
  if (!gdu) degraded.push('gdu 未導入: du -sk による使用量のみ (見かけサイズは不明)')
  degraded.push('reposcan / gst / ward は MVP では呼び出さない。判定は git の一次確認のみ')
  const all = found.map(f => f.path)
  const targets = found.slice(0, cfg.maxRepos)
  const now = Math.floor(Date.now() / 1000)
  const repos: RepoReport[] = []
  for (const t of targets) repos.push(await analyze(run, t.path, t.source, cwd, all, cfg, gdu, now))
  const counts = { PROTECTED: 0, DIRTY: 0, UNKNOWN: 0, CANDIDATE: 0 }
  repos.forEach(r => counts[r.verdict.category]++)
  return {
    schema: 'repo-storage-report-1', readOnly: true, generatedAt: new Date(now * 1000).toISOString(),
    degraded, totalDiscovered: found.length, analyzed: repos.length, skipped: found.length - repos.length, counts, repos,
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'scan_repos',
      description:
        'ローカルの Git リポジトリを読み取り専用で解析し、容量・最終コミット・保全リスク (PROTECTED/DIRTY/UNKNOWN/CANDIDATE)・生成物候補を返す。削除・移動・fetch は一切しない。CANDIDATE は削除許可ではない。',
      inputSchema: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['size', 'activity', 'risk'], description: '並び順 (既定 size)' },
          format: { type: 'string', enum: ['text', 'json'], description: '出力形式 (既定 text)' },
          category: { type: 'string', enum: ['PROTECTED', 'DIRTY', 'UNKNOWN', 'CANDIDATE'], description: '分類で絞り込む' },
          min_bytes: { type: 'number', description: '使用量がこの bytes 以上のリポジトリだけ (使用量不明は除外しない)' },
          stale_only: { type: 'boolean', description: 'true なら STALE の理由を持つものだけ' },
        },
      },
    })
    const known = await $.command.list()
    if (!known.some((c: { name: string }) => c.name === 'repo-storage'))
      await $.command.register({ name: 'repo-storage', description: 'ローカルリポジトリの容量と保全リスクを読み取り専用で解析する' })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ReportOptions & { format?: 'text' | 'json' }
    const report = filterReport(await scan($, cfg), input)
    return { result: input.format === 'json' ? JSON.stringify(report) : formatReport(report, cfg.topN, input.sort ?? 'size') }
  })

  on('command.run', { command: 'repo-storage' }, async $ => ({ text: formatReport(await scan($, cfg), cfg.topN) }))
}
