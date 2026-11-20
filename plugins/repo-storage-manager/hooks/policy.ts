// 純粋ロジック。プロセス実行・ファイル操作は行わない (register.ts が担当する)。

export type Config = { scanRoots: string[]; maxDepth: number; maxRepos: number; staleDays: number; topN: number }

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def
}

/** ツール引数を検証して Config にする。範囲外は丸め、絶対パスでない scanRoots は捨てる。 */
export const readConfig = (o: Record<string, unknown> | undefined): Config => ({
  scanRoots: (Array.isArray(o?.scanRoots) ? o.scanRoots : String(o?.scanRoots ?? '').split(','))
    .map(s => String(s).trim()).filter(s => s.startsWith('/') && !s.includes('\0')),
  maxDepth: clamp(o?.maxDepth, 3, 1, 8),
  maxRepos: clamp(o?.maxRepos, 200, 1, 2000),
  staleDays: clamp(o?.staleDays, 180, 1, 3650),
  topN: clamp(o?.topN, 20, 1, 200),
})

/** 外部コマンド出力に含まれる制御文字 (ANSI エスケープ含む) を無害化する。 */
export const sanitize = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')

// worktree の解析は ghq-pane と共有する (正本は shared/git-worktree。scripts/sync-git-worktree.ts で同梱)
export { parseWorktrees } from './git-worktree/parse'
export type { ParsedWorktree as Worktree } from './git-worktree/parse'

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

/** 生成物ごとの、再生成の根拠になるプロジェクト設定ファイルと再生成方法。dist / build は根拠を持たない。 */
export const CACHE_RULES: Record<string, { markers: string[]; regen: string } | undefined> = {
  node_modules: { markers: ['package.json'], regen: 'パッケージマネージャの install (lockfile の有無を確認)' },
  target: { markers: ['Cargo.toml', 'pom.xml'], regen: 'cargo build / mvn compile' },
  '.next': { markers: ['package.json'], regen: 'next build' },
  '.venv': { markers: ['pyproject.toml', 'requirements.txt'], regen: '仮想環境の再作成と依存の再インストール' },
  '.gradle': { markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle'], regen: 'gradle の再実行' },
  __pycache__: { markers: [], regen: 'Python が自動生成' },
}
export const CACHE_MARKERS = [...new Set(Object.values(CACHE_RULES).flatMap(r => r?.markers ?? []))]

export type CacheClass = 'REGENERABLE_LIKELY' | 'UNKNOWN_REGEN' | 'PROTECTED_DATA'

/**
 * 生成物候補の分類。git の追跡対象は PROTECTED_DATA。gitignore 済みで、設定ファイルという根拠があるときだけ
 * REGENERABLE_LIKELY (「再生成できそう」であって削除許可ではない)。それ以外・判定不能は UNKNOWN_REGEN。
 */
export const classifyCache = (
  name: string, markersPresent: string[], ignored: boolean | undefined, tracked: boolean | undefined,
): { class: CacheClass; regen: string | undefined; evidence: string[] } => {
  const rule = CACHE_RULES[name]
  if (tracked === true) return { class: 'PROTECTED_DATA', regen: undefined, evidence: ['git の追跡対象のファイルを含む'] }
  if (tracked === undefined || ignored === undefined) return { class: 'UNKNOWN_REGEN', regen: rule?.regen, evidence: ['git での追跡・ignore の判定に失敗'] }
  if (!ignored) return { class: 'UNKNOWN_REGEN', regen: rule?.regen, evidence: ['gitignore されていない (固有のデータの可能性)'] }
  if (!rule) return { class: 'UNKNOWN_REGEN', regen: undefined, evidence: [`${name} は名前だけでは再生成可能と判断できない`] }
  const found = rule.markers.filter(m => markersPresent.includes(m))
  if (rule.markers.length > 0 && found.length === 0) return { class: 'UNKNOWN_REGEN', regen: rule.regen, evidence: [`根拠となる設定ファイル (${rule.markers.join(' / ')}) が無い`] }
  return { class: 'REGENERABLE_LIKELY', regen: rule.regen, evidence: ['gitignore 済み', ...(found.length > 0 ? [`設定ファイル: ${found.join(', ')}`] : [])] }
}

export type Category = 'PROTECTED' | 'DIRTY' | 'UNKNOWN' | 'CANDIDATE'
export type Reason =
  | 'CURRENT_DIR' | 'LINKED_WORKTREE' | 'EXTRA_WORKTREE' | 'ACTIVE_WORKTREE' | 'BARE_REPO' | 'SUBMODULE'
  | 'UNCOMMITTED' | 'UNTRACKED' | 'UNPUSHED' | 'NO_UPSTREAM' | 'STASH' | 'DETACHED_HEAD'
  | 'GIT_FAILED' | 'NO_COMMITS' | 'REMOTE_UNVERIFIED' | 'STALE' | 'RECENT' | 'SIGNAL_CONFLICT'

export type Observation = {
  path: string
  currentDir: boolean
  /** 保護対象のパス (稼働中セッションの作業ディレクトリ等) 配下かどうか */
  activeWorktree: boolean
  failed: boolean
  bare: boolean
  /** git-dir が common-dir と異なる = 別リポジトリの linked worktree */
  linkedWorktree: boolean
  hasSubmodules: boolean
  extraWorktrees: number
  status: GitStatus | undefined
  branches: LocalBranches | undefined
  stash: number | undefined
  lastCommitEpoch: number | undefined
  /** HEAD の reflog の最新時刻 (checkout・pull など、コミット以外の利用)。取れなければ undefined */
  lastReflogEpoch?: number | undefined
}

export type Verdict = { category: Category; reasons: Reason[] }

/** 活動日時。コミットと reflog (checkout・pull など) の新しいほう。最近使っているリポジトリを古いとみなさないため。 */
export const lastActivityOf = (o: Pick<Observation, 'lastCommitEpoch' | 'lastReflogEpoch'>): { epoch: number | undefined; source: 'commit' | 'reflog' | undefined } => {
  const c = o.lastCommitEpoch
  const r = o.lastReflogEpoch
  if (c === undefined && r === undefined) return { epoch: undefined, source: undefined }
  if (r !== undefined && (c === undefined || r > c)) return { epoch: r, source: 'reflog' }
  return { epoch: c, source: 'commit' }
}

export type Activity = 'ACTIVE' | 'RECENT' | 'STALE' | 'UNKNOWN'

/** 活動の区分。30 日未満は ACTIVE、staleDays 未満は RECENT。表示用で、削除許可の条件ではない。 */
export const activityOf = (epoch: number | undefined, nowEpoch: number, staleDays: number): Activity =>
  epoch === undefined ? 'UNKNOWN' : nowEpoch - epoch >= staleDays * 86400 ? 'STALE' : nowEpoch - epoch < 30 * 86400 ? 'ACTIVE' : 'RECENT'

/** 保守的な統合判定。不明・失敗は安全側 (UNKNOWN) に倒し、CANDIDATE も削除許可ではない。 */
export const classify = (o: Observation, nowEpoch: number, staleDays: number): Verdict => {
  const protectedR: Reason[] = []
  if (o.currentDir) protectedR.push('CURRENT_DIR')
  if (o.activeWorktree) protectedR.push('ACTIVE_WORKTREE')
  if (o.bare) protectedR.push('BARE_REPO')
  if (o.linkedWorktree) protectedR.push('LINKED_WORKTREE')
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

  const last = lastActivityOf(o).epoch ?? o.lastCommitEpoch
  const stale = nowEpoch - last >= staleDays * 86400
  return stale
    ? { category: 'CANDIDATE', reasons: ['STALE', 'REMOTE_UNVERIFIED'] }
    : { category: 'PROTECTED', reasons: ['RECENT'] }
}

/** パスを正規化して重複を除く。親が既に含まれる子 (nested) は別リポジトリとして残すが、親を示す。 */
export const dedupePaths = (paths: string[]): string[] => [...new Set(paths.map(p => p.replace(/\/+$/, '')).filter(Boolean))]

export const parentOf = (path: string, all: string[]): string | undefined =>
  all.filter(p => p !== path && path.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0]

export type CacheDir = {
  name: string; path: string; bytes: number | undefined; ignored: boolean | undefined
  tracked: boolean | undefined; class: CacheClass; regen: string | undefined; evidence: string[]
}

export type RepoReport = {
  path: string
  /** 実体パス (symlink 解決後)。重複排除に使う */
  commonDir?: string | undefined
  source: 'ghq' | 'scan-root'
  verdict: Verdict
  usageBytes: number | undefined
  apparentBytes: number | undefined
  sizeSource: 'gdu' | 'du' | 'unavailable'
  lastCommit: string | undefined
  /** コミットと reflog の新しいほう (YYYY-MM-DD) とその出所、区分 */
  lastActivity?: string | undefined
  activitySource?: 'commit' | 'reflog' | undefined
  activity?: Activity | undefined
  branchesNoUpstream: number
  stash: number | undefined
  extraWorktrees: number
  nestedIn: string | undefined
  caches: CacheDir[]
  /** 参考信号 (reposcan)。判定を保守側へ動かすことはあっても、CANDIDATE へ上げることはない */
  signals?: { source: 'reposcan'; uncommitted: number; ahead: number; behind: number; stashes: number } | undefined
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
  if (by === 'activity') return copy.sort((a, b) => (a.lastActivity ?? a.lastCommit ?? '').localeCompare(b.lastActivity ?? b.lastCommit ?? ''))
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
        `${x.apparentBytes === undefined ? '' : ` / 見かけ ${humanBytes(x.apparentBytes)}`} | 最終コミット ${x.lastCommit ?? '不明'}${x.lastActivity && x.lastActivity !== x.lastCommit ? ` / 最終活動 ${x.lastActivity} (${x.activitySource})` : ''} [${x.activity ?? 'UNKNOWN'}]`,
    )
    if (x.nestedIn) lines.push(`  nested: ${sanitize(x.nestedIn)} 配下 (容量は親に含まれる可能性があり、合算しない)`)
    for (const c of x.caches) lines.push(`  生成物候補: ${c.name} ${humanBytes(c.bytes)} [${c.class}] ${c.evidence.join('; ')}${c.regen ? ` | 再生成: ${c.regen}` : ''} (リポジトリの使用量に含まれる)`)
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
