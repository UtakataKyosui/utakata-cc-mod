import type { Register } from 'claude-code'
import {
  CACHE_MARKERS, CACHE_NAMES, type CacheDir, classifyCache, type ReportOptions, filterReport, type Config, type Observation, type Report, type RepoReport, classify, dedupePaths, formatReport,
  parseBranches, parseDu, parseNcdu, parseStatus, parseWorktrees, parentOf, readConfig, sanitize,
} from './policy'
import { type Run, createRun, probe } from './runner'
import { type Destination, type Operation, type Plan, formatPlan, planOne } from './plan'

const TOOL = 'mcp__repo-storage-manager__scan_repos'
const PLAN_TOOL = 'mcp__repo-storage-manager__plan_preservation'

/** 読み取り専用のコマンドだけを argv 配列で実行する (runner.ts: 出力上限・例外の吸収・argv 検証)。 */
const makeRun = ($: any): Run => createRun((argv, o) => $.process.run(argv, { timeoutMs: o.timeoutMs }))

const has = async (run: Run, name: string) => (await probe(run, [name, '--version'])).state !== 'missing'

async function discover(run: Run, cfg: Config, degraded: string[]): Promise<{ path: string; source: 'ghq' | 'scan-root' }[]> {
  const found: { path: string; source: 'ghq' | 'scan-root' }[] = []
  if (await has(run, 'ghq')) {
    const r = await run(['ghq', 'list', '-p'])
    if (r.exitCode === 0) r.stdout.split('\n').filter(Boolean).forEach(path => found.push({ path, source: 'ghq' }))
    else degraded.push(`ghq list に失敗: ${sanitize(r.stderr.trim()).slice(0, 200)}`)
  } else degraded.push('ghq 未導入: scan_roots のみを探索')
  for (const root of cfg.scanRoots) {
    const r = await run(['find', root, '-maxdepth', String(cfg.maxDepth + 1), '-name', '.git', '-prune', '-print0'])
    if (r.exitCode !== 0) { degraded.push(`scan_roots を探索できない: ${sanitize(root)}`); continue }
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
  const markerNames = CACHE_MARKERS.flatMap((n, i) => (i === 0 ? ['-name', n] : ['-o', '-name', n]))
  const m = await run(['find', path, '-maxdepth', '1', '-type', 'f', '(', ...markerNames, ')', '-print0'])
  const markers = m.exitCode === 0 ? m.stdout.split('\0').filter(Boolean).map(f => f.slice(f.lastIndexOf('/') + 1)) : []
  return Promise.all(r.stdout.split('\0').filter(Boolean).map(async dir => {
    const name = dir.slice(dir.lastIndexOf('/') + 1)
    const du = await run(['du', '-sk', '-x', dir], 120_000)
    const ig = await run(['git', '-C', path, 'check-ignore', '-q', '--', name])
    const tr = await run(['git', '-C', path, 'ls-files', '--', name])
    const ignored = ig.exitCode === 0 ? true : ig.exitCode === 1 ? false : undefined
    const tracked = tr.exitCode === 0 ? tr.stdout.trim() !== '' : undefined
    const c = classifyCache(name, markers, ignored, tracked)
    return { name, path: dir, bytes: du.exitCode === 0 ? parseDu(du.stdout) : undefined, ignored, tracked, class: c.class, regen: c.regen, evidence: c.evidence }
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
    git('rev-parse', '--path-format=absolute', '--is-bare-repository', '--git-dir', '--git-common-dir'),
  ])
  const rp = bare.stdout.trim().split('\n')
  const worktrees = wt.exitCode === 0 ? parseWorktrees(wt.stdout) : []
  const obs: Observation = {
    path,
    currentDir: cwd === path || cwd.startsWith(`${path}/`),
    activeWorktree: false,
    failed: [wt, st, br, stash, bare, sub].some(r => r.exitCode !== 0) || rp.length < 3,
    bare: rp[0] === 'true',
    linkedWorktree: rp[1] !== undefined && rp[2] !== undefined && rp[1] !== rp[2],
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
    path, source, verdict, commonDir: rp[2],
    usageBytes: size.usage, apparentBytes: size.apparent, sizeSource: size.source,
    lastCommit: obs.lastCommitEpoch === undefined ? undefined : new Date(obs.lastCommitEpoch * 1000).toISOString().slice(0, 10),
    branchesNoUpstream: obs.branches?.noUpstream.length ?? 0,
    stash: obs.stash,
    extraWorktrees: obs.extraWorktrees,
    nestedIn: parentOf(path, all),
    caches: await cachesOf(run, path),
  }
}

export async function scan($: any, cfg: Config, only?: string[]): Promise<Report> {
  const run = makeRun($)
  const degraded: string[] = []
  const cwd = (await run(['pwd', '-P'])).stdout.trim()
  const found = only
    ? only.filter(p => p.startsWith('/')).map(path => ({ path: path.replace(/\/+$/, ''), source: 'scan-root' as const }))
    : await discover(run, cfg, degraded)
  const gdu = await has(run, 'gdu')
  if (!gdu) degraded.push('gdu 未導入: du -sk による使用量のみ (見かけサイズは不明)')
  degraded.push('reposcan / gst / ward は MVP では呼び出さない。判定は git の一次確認のみ')
  const all = found.map(f => f.path)
  const targets = found.slice(0, cfg.maxRepos)
  const now = Math.floor(Date.now() / 1000)
  const repos: RepoReport[] = []
  for (const t of targets) repos.push(await analyze(run, t.path, t.source, cwd, all, cfg, gdu, now))
  // 同じ common-dir を指すもの (symlink 経由・二重登録) は 1 件にまとめ、まとめた分を縮退として報告する
  const seen = new Set<string>()
  const unique = repos.filter(r => {
    if (r.commonDir === undefined || r.verdict.reasons.includes('LINKED_WORKTREE')) return true
    if (seen.has(r.commonDir)) { degraded.push(`同一リポジトリの重複を除外: ${sanitize(r.path)}`); return false }
    seen.add(r.commonDir)
    return true
  })
  repos.length = 0
  repos.push(...unique)
  const counts = { PROTECTED: 0, DIRTY: 0, UNKNOWN: 0, CANDIDATE: 0 }
  repos.forEach(r => counts[r.verdict.category]++)
  return {
    schema: 'repo-storage-report-1', readOnly: true, generatedAt: new Date(now * 1000).toISOString(),
    degraded, totalDiscovered: found.length, analyzed: repos.length, skipped: found.length - targets.length, counts, repos,
  }
}

const mountOf = async (run: Run, path: string): Promise<string | undefined> => {
  const r = await run(['df', '-Pk', path])
  const line = r.exitCode === 0 ? r.stdout.trim().split('\n')[1] : undefined
  return line ? line.split(/\s+/).slice(5).join(' ') || undefined : undefined
}

/** 保全の計画だけを作る。書き込み・削除・移動はしない。 */
export async function plan($: any, cfg: Config, input: { paths: string[]; operation: Operation; destination?: string }): Promise<Plan> {
  const run = makeRun($)
  const report = await scan($, cfg, input.paths)
  let dest: Destination | undefined
  if (input.destination !== undefined && input.destination.startsWith('/') && !input.destination.includes('\0')) {
    const exists = (await run(['test', '-d', input.destination])).exitCode === 0
    const writable = exists && (await run(['test', '-w', input.destination])).exitCode === 0
    dest = { path: input.destination.replace(/\/+$/, ''), exists, writable, fs: { mount: exists ? await mountOf(run, input.destination) : undefined } }
  }
  const items = []
  for (const r of report.repos) items.push(planOne(r, input.operation, dest, await mountOf(run, r.path)))
  return { schema: 'repo-preservation-plan-draft-1', dryRun: true, items, degraded: report.degraded }
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'scan_repos',
      description:
        'ローカルの Git リポジトリを読み取り専用で解析し、容量・最終コミット・保全リスク (PROTECTED/DIRTY/UNKNOWN/CANDIDATE)・生成物候補を返す。削除・移動・fetch は一切しない。CANDIDATE は削除許可ではない。',
      inputSchema: {
        type: 'object',
        properties: {
          scan_roots: { type: 'array', items: { type: 'string' }, description: 'ghq の管理外で探索する絶対パス。ghq が無いときの代替にもなる' },
          max_depth: { type: 'number', description: 'scan_roots 配下で .git を探す深さ (1〜8、既定 3)' },
          max_repos: { type: 'number', description: '解析するリポジトリ数の上限 (1〜2000、既定 200)' },
          stale_days: { type: 'number', description: '古いとみなす日数 (既定 180)。候補抽出の条件にすぎず、削除してよい条件ではない' },
          top_n: { type: 'number', description: 'レポートに載せる件数 (1〜200、既定 20)' },
          sort: { type: 'string', enum: ['size', 'activity', 'risk'], description: '並び順 (既定 size)' },
          format: { type: 'string', enum: ['text', 'json'], description: '出力形式 (既定 text)' },
          category: { type: 'string', enum: ['PROTECTED', 'DIRTY', 'UNKNOWN', 'CANDIDATE'], description: '分類で絞り込む' },
          min_bytes: { type: 'number', description: '使用量がこの bytes 以上のリポジトリだけ (使用量不明は除外しない)' },
          stale_only: { type: 'boolean', description: 'true なら STALE の理由を持つものだけ' },
        },
      },
    })
    await $.tool.register({
      name: 'plan_preservation',
      description:
        '指定したリポジトリの整理・退避の計画を作る (Dry Run)。何も実行・変更しない。operation: cache-only (再生成できそうな生成物のみ) / archive (git bundle の作成のみ) / relocate (退避。元の削除は別操作)。同じファイルシステムへの退避では容量が増えないことも示す。',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '対象リポジトリの絶対パス' },
          operation: { type: 'string', enum: ['cache-only', 'archive', 'relocate'] },
          destination: { type: 'string', description: 'archive / relocate の退避先 (絶対パス、既存のディレクトリ)' },
          format: { type: 'string', enum: ['text', 'json'] },
        },
        required: ['paths', 'operation'],
      },
    })
    const known = await $.command.list()
    if (!known.some((c: { name: string }) => c.name === 'repo-storage'))
      await $.command.register({ name: 'repo-storage', description: 'ローカルリポジトリの容量と保全リスクを読み取り専用で解析する' })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ReportOptions & { format?: 'text' | 'json'; scan_roots?: unknown; max_depth?: unknown; max_repos?: unknown; stale_days?: unknown; top_n?: unknown }
    const cfg = readConfig({ scanRoots: input.scan_roots, maxDepth: input.max_depth, maxRepos: input.max_repos, staleDays: input.stale_days, topN: input.top_n })
    const report = filterReport(await scan($, cfg), input)
    return { result: input.format === 'json' ? JSON.stringify(report) : formatReport(report, cfg.topN, input.sort ?? 'size') }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const i = e as unknown as { paths?: unknown; operation?: unknown; destination?: unknown; format?: 'text' | 'json' }
    if (!Array.isArray(i.paths) || i.paths.length === 0 || !i.paths.every(p => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')))
      return { deny: 'paths must be a non-empty array of absolute paths' }
    if (i.operation !== 'cache-only' && i.operation !== 'archive' && i.operation !== 'relocate') return { deny: 'invalid operation' }
    const p = await plan($, readConfig(undefined), {
      paths: i.paths.slice(0, 50), operation: i.operation, ...(typeof i.destination === 'string' ? { destination: i.destination } : {}),
    })
    return { result: i.format === 'json' ? JSON.stringify(p) : formatPlan(p) }
  })

  on('command.run', { command: 'repo-storage' }, async $ => {
    const cfg = readConfig(undefined)
    return { text: formatReport(await scan($, cfg), cfg.topN) }
  })
}
