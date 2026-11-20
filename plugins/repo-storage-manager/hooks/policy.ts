// 純粋ロジック。プロセス実行・ファイル操作は行わない (register.ts が担当する)。

export type Config = { scanRoots: string[]; maxDepth: number; maxRepos: number; staleDays: number; topN: number }

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def
}

export const readConfig = (o: Record<string, unknown> | undefined): Config => ({
  scanRoots: String(o?.scanRoots ?? '').split(',').map(s => s.trim()).filter(s => s.startsWith('/')),
  maxDepth: clamp(o?.maxDepth, 3, 1, 8),
  maxRepos: clamp(o?.maxRepos, 200, 1, 2000),
  staleDays: clamp(o?.staleDays, 180, 1, 3650),
  topN: clamp(o?.topN, 20, 1, 200),
})

/** 外部コマンド出力に含まれる制御文字 (ANSI エスケープ含む) を無害化する。 */
export const sanitize = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')

export type Worktree = { path: string; branch: string; isMain: boolean; prunable: boolean; bare: boolean }

/** `git worktree list --porcelain` の解析。 */
export const parseWorktrees = (out: string): Worktree[] =>
  out.trim().split('\n\n').filter(Boolean).map((block, i) => {
    const lines = block.split('\n')
    const field = (k: string) => lines.find(l => l === k || l.startsWith(`${k} `))?.slice(k.length + 1)
    const branch = field('branch')
    return {
      path: field('worktree') ?? '',
      branch: branch ? branch.replace('refs/heads/', '') : '(detached)',
      isMain: i === 0,
      prunable: lines.some(l => l.startsWith('prunable')),
      bare: lines.includes('bare'),
    }
  })

export type GitStatus = { dirty: number; untracked: number; ahead: number; behind: number; hasUpstream: boolean; detached: boolean }

/** `git status --porcelain=v2 --branch` の解析。 */
export const parseStatus = (out: string): GitStatus => {
  const r: GitStatus = { dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: false, detached: false }
  for (const l of out.split('\n')) {
    if (l === '# branch.head (detached)') r.detached = true
    else if (l.startsWith('# branch.upstream ')) r.hasUpstream = true
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l)
      if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]) }
    } else if (l.startsWith('? ')) r.untracked++
    else if (/^[12u] /.test(l)) r.dirty++
  }
  return r
}

export type LocalBranches = { noUpstream: string[]; ahead: string[] }

/** `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track) refs/heads` の解析。 */
export const parseBranches = (out: string): LocalBranches => {
  const r: LocalBranches = { noUpstream: [], ahead: [] }
  for (const l of out.split('\n').filter(Boolean)) {
    const [name = '', upstream = '', track = ''] = l.split('\t')
    if (upstream === '') r.noUpstream.push(name)
    else if (/ahead/.test(track)) r.ahead.push(name)
  }
  return r
}

/**
 * ncdu 互換 JSON (gdu -o) から見かけサイズと使用量を集計する。壊れた入力は undefined。
 * 新しい gdu はディレクトリの合計を gdu_asize / gdu_dsize に持ち、asize / dsize はそのエントリ自身の値になる。
 * 古い gdu と ncdu はディレクトリの asize / dsize が配下を含む合計なので、二重計上を避けファイルだけを足す。
 */
export const parseNcdu = (text: string): { apparent: number; usage: number } | undefined => {
  try {
    const doc = JSON.parse(text)
    if (!Array.isArray(doc) || doc.length < 4 || !Array.isArray(doc[3])) return undefined
    const isDir = (n: unknown): n is unknown[] => Array.isArray(n)
    const head = (n: unknown[]) => (n[0] ?? {}) as Record<string, unknown>
    let newFormat = false
    let incomplete = false
    const scan = (dir: unknown[]): void => {
      if ('gdu_dsize' in head(dir) || 'gdu_asize' in head(dir)) newFormat = true
      if (head(dir).read_error === true) incomplete = true
      dir.slice(1).forEach(c => { if (isDir(c)) scan(c) })
    }
    scan(doc[3])
    let apparent = 0
    let usage = 0
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const walk = (dir: unknown[]): void => {
      if (newFormat) { apparent += num(head(dir).asize); usage += num(head(dir).dsize) }
      for (const c of dir.slice(1)) {
        if (isDir(c)) walk(c)
        else if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>
          if (o.read_error === true) incomplete = true
          apparent += num(o.asize)
          usage += num(o.dsize)
        }
      }
    }
    walk(doc[3])
    // 読めなかったディレクトリがあれば部分的な測定なので、成功扱いにせず呼び出し側で du に切り替えさせる
    return incomplete ? undefined : { apparent, usage }
  } catch {
    return undefined
  }
}

/** `du -sk` 系の出力 (`<KiB>\t<path>`) を bytes にする。 */
export const parseDu = (out: string): number | undefined => {
  const m = /^(\d+)\t/.exec(out.trim())
  return m ? Number(m[1]) * 1024 : undefined
}

/** 再生成できる可能性のある生成物のディレクトリ名。名前だけでは安全と断定しない。 */
export const CACHE_NAMES = ['node_modules', 'target', '.next', 'dist', 'build', '.venv', '__pycache__', '.gradle'] as const

export type Category = 'PROTECTED' | 'DIRTY' | 'UNKNOWN' | 'CANDIDATE'
export type Reason =
  | 'CURRENT_DIR' | 'EXTRA_WORKTREE' | 'ACTIVE_WORKTREE' | 'BARE_REPO' | 'SUBMODULE'
  | 'UNCOMMITTED' | 'UNTRACKED' | 'UNPUSHED' | 'NO_UPSTREAM' | 'STASH' | 'DETACHED_HEAD'
  | 'GIT_FAILED' | 'NO_COMMITS' | 'REMOTE_UNVERIFIED' | 'STALE' | 'RECENT'

export type Observation = {
  path: string
  currentDir: boolean
  /** 保護対象のパス (稼働中セッションの作業ディレクトリ等) 配下かどうか */
  activeWorktree: boolean
  failed: boolean
  bare: boolean
  hasSubmodules: boolean
  extraWorktrees: number
  status: GitStatus | undefined
  branches: LocalBranches | undefined
  stash: number | undefined
  lastCommitEpoch: number | undefined
}

export type Verdict = { category: Category; reasons: Reason[] }

/** 保守的な統合判定。不明・失敗は安全側 (UNKNOWN) に倒し、CANDIDATE も削除許可ではない。 */
export const classify = (o: Observation, nowEpoch: number, staleDays: number): Verdict => {
  const protectedR: Reason[] = []
  if (o.currentDir) protectedR.push('CURRENT_DIR')
  if (o.activeWorktree) protectedR.push('ACTIVE_WORKTREE')
  if (o.bare) protectedR.push('BARE_REPO')
  if (o.hasSubmodules) protectedR.push('SUBMODULE')
  if (o.extraWorktrees > 0) protectedR.push('EXTRA_WORKTREE')
  if (protectedR.length > 0) return { category: 'PROTECTED', reasons: protectedR }

  if (o.failed || !o.status || !o.branches || o.stash === undefined) return { category: 'UNKNOWN', reasons: ['GIT_FAILED'] }

  const dirty: Reason[] = []
  if (o.status.dirty > 0) dirty.push('UNCOMMITTED')
  if (o.status.untracked > 0) dirty.push('UNTRACKED')
  if (o.status.ahead > 0 || o.branches.ahead.length > 0) dirty.push('UNPUSHED')
  if (o.branches.noUpstream.length > 0) dirty.push('NO_UPSTREAM')
  if (o.stash > 0) dirty.push('STASH')
  // detached HEAD のコミットは、どのブランチの ahead にも数えられないため保護側に倒す
  if (o.status.detached) dirty.push('DETACHED_HEAD')
  if (dirty.length > 0) return { category: 'DIRTY', reasons: dirty }

  if (o.lastCommitEpoch === undefined) return { category: 'UNKNOWN', reasons: ['NO_COMMITS'] }

  const stale = nowEpoch - o.lastCommitEpoch >= staleDays * 86400
  return stale
    ? { category: 'CANDIDATE', reasons: ['STALE', 'REMOTE_UNVERIFIED'] }
    : { category: 'PROTECTED', reasons: ['RECENT'] }
}

/** パスを正規化して重複を除く。親が既に含まれる子 (nested) は別リポジトリとして残すが、親を示す。 */
export const dedupePaths = (paths: string[]): string[] => [...new Set(paths.map(p => p.replace(/\/+$/, '')).filter(Boolean))]

export const parentOf = (path: string, all: string[]): string | undefined =>
  all.filter(p => p !== path && path.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0]

export type CacheDir = { name: string; path: string; bytes: number | undefined; ignored: boolean | undefined }

export type RepoReport = {
  path: string
  source: 'ghq' | 'scan-root'
  verdict: Verdict
  usageBytes: number | undefined
  apparentBytes: number | undefined
  sizeSource: 'gdu' | 'du' | 'unavailable'
  lastCommit: string | undefined
  branchesNoUpstream: number
  stash: number | undefined
  extraWorktrees: number
  nestedIn: string | undefined
  caches: CacheDir[]
}

export type Report = {
  schema: 'repo-storage-report-1'
  readOnly: true
  generatedAt: string
  degraded: string[]
  totalDiscovered: number
  analyzed: number
  skipped: number
  counts: Record<Category, number>
  repos: RepoReport[]
}

export const humanBytes = (n: number | undefined): string => {
  if (n === undefined) return '不明'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`
}

export const sortRepos = (repos: RepoReport[], by: 'size' | 'activity' | 'risk'): RepoReport[] => {
  const rank: Record<Category, number> = { PROTECTED: 0, UNKNOWN: 1, DIRTY: 2, CANDIDATE: 3 }
  const copy = [...repos]
  if (by === 'activity') return copy.sort((a, b) => (a.lastCommit ?? '').localeCompare(b.lastCommit ?? ''))
  if (by === 'risk') return copy.sort((a, b) => rank[a.verdict.category] - rank[b.verdict.category] || (b.usageBytes ?? -1) - (a.usageBytes ?? -1))
  return copy.sort((a, b) => (b.usageBytes ?? -1) - (a.usageBytes ?? -1))
}

/** 人が読む報告。回収可能量とは言わず、候補・保護・不明を分けて示す。 */
export const formatReport = (r: Report, topN: number, by: 'size' | 'activity' | 'risk' = 'size'): string => {
  const top = sortRepos(r.repos, by).slice(0, topN)
  const lines = [
    `# repo-storage レポート (読み取り専用・${r.schema})`,
    `発見 ${r.totalDiscovered} 件 / 解析 ${r.analyzed} 件 / 未解析 ${r.skipped} 件`,
    `分類: PROTECTED ${r.counts.PROTECTED} / DIRTY ${r.counts.DIRTY} / UNKNOWN ${r.counts.UNKNOWN} / CANDIDATE ${r.counts.CANDIDATE}`,
    'CANDIDATE は「ローカル検査を通った候補」であり削除許可ではない。リモートの到達性は検証していない。',
  ]
  if (r.degraded.length > 0) lines.push('', '縮退動作:', ...r.degraded.map(d => `- ${d}`))
  lines.push('', `## 上位 ${top.length} 件 (${by} 順)`)
  for (const x of top) {
    lines.push(
      `- ${sanitize(x.path)}`,
      `  [${x.verdict.category}] ${x.verdict.reasons.join(', ')} | 使用量 ${humanBytes(x.usageBytes)} (${x.sizeSource})` +
        `${x.apparentBytes === undefined ? '' : ` / 見かけ ${humanBytes(x.apparentBytes)}`} | 最終コミット ${x.lastCommit ?? '不明'}`,
    )
    if (x.nestedIn) lines.push(`  nested: ${sanitize(x.nestedIn)} 配下 (容量は親に含まれる可能性があり、合算しない)`)
    for (const c of x.caches) lines.push(`  生成物候補: ${c.name} ${humanBytes(c.bytes)}${c.ignored === false ? ' (gitignore されていない)' : c.ignored === undefined ? ' (ignore 判定不明)' : ''}`)
  }
  lines.push('', '容量は重複 (親子・hardlink・symlink) を除けていない可能性があるため、合計を「回収可能量」として扱わない。')
  return lines.join('\n')
}

export type ReportOptions = { sort?: 'size' | 'activity' | 'risk'; category?: Category; min_bytes?: number; stale_only?: boolean }

/** 絞り込み。絞った結果でも counts / totalDiscovered は元のまま、`filtered` に残件数を足す。 */
export const filterReport = (r: Report, o: ReportOptions): Report => {
  const min = typeof o.min_bytes === 'number' && Number.isFinite(o.min_bytes) ? o.min_bytes : undefined
  const repos = r.repos.filter(x =>
    (o.category === undefined || x.verdict.category === o.category) &&
    (min === undefined || x.usageBytes === undefined || x.usageBytes >= min) &&
    (o.stale_only !== true || x.verdict.reasons.includes('STALE')))
  return repos.length === r.repos.length ? r : { ...r, repos, degraded: [...r.degraded, `絞り込み後 ${repos.length} / ${r.repos.length} 件を表示`] }
}
