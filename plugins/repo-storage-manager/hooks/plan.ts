// 保全計画 (Dry Run)。計画を組み立てて表示するだけで、何も実行しない。実行は #39 の別 PR で、実行直前の再検査を前提にする。
import { type CacheDir, type RepoReport, humanBytes, sanitize } from './policy'

export type Operation = 'cache-only' | 'archive' | 'relocate'

export type FsInfo = {
  /** `df -P` の Mounted on。同一かどうかで容量が回収できるかを判断する */
  mount: string | undefined
}

export type Destination = { path: string; exists: boolean; writable: boolean; fs: FsInfo }

export type ExcludeReason =
  | 'NOT_CANDIDATE' | 'STATE_UNKNOWN' | 'CURRENT_DIR' | 'NO_REGENERABLE_CACHE' | 'NO_DESTINATION'
  | 'DESTINATION_UNUSABLE' | 'RESTORE_UNCHECKABLE'

export type Manifest = {
  schema: 'repo-preservation-manifest-draft-1'
  source: string
  head?: string
  note: string
  contents: string[]
  hashes: 'sha256 を作成時に記録する (未計算)'
}

export type PlanItem = {
  path: string
  operation: Operation
  status: 'PLANNED' | 'EXCLUDED'
  excluded: ExcludeReason[]
  /** 対象。cache-only は削除ではなく「候補」。実行時に再検査する */
  targets: string[]
  /** 推定。実測ではない */
  estimatedReclaimBytes: number | undefined
  reclaimNote: string
  sameFilesystem: boolean | undefined
  /** 実行はしない。表示用の手順 (argv を空白で連結しない表現) */
  steps: string[][]
  restoreRehearsal: string[]
  manifest: Manifest | undefined
  unconfirmed: string[]
  requiresBeforeExecution: string[]
}

export type Plan = { schema: 'repo-preservation-plan-draft-1'; dryRun: true; items: PlanItem[]; degraded: string[] }

const PRE = ['対象ごとのユーザーの明示承認', '実行直前のパス正規化・symlink・git/worktree 状態の再検査', 'ロック・稼働中セッションの確認']

const regenerable = (r: RepoReport): CacheDir[] => r.caches.filter(c => c.class === 'REGENERABLE_LIKELY')

export const planOne = (r: RepoReport, op: Operation, dest: Destination | undefined, srcMount: string | undefined): PlanItem => {
  const excluded: ExcludeReason[] = []
  const base = {
    path: r.path, operation: op, estimatedReclaimBytes: undefined as number | undefined, reclaimNote: '', sameFilesystem: undefined as boolean | undefined,
    steps: [] as string[][], restoreRehearsal: [] as string[], manifest: undefined as Manifest | undefined, targets: [] as string[],
    unconfirmed: ['リモートの到達性は未検証', 'ward の出力・復元手順は実機で未確認 (docs/cli-survey.md)'], requiresBeforeExecution: PRE,
  }
  const done = (): PlanItem => ({ ...base, excluded, status: excluded.length > 0 ? 'EXCLUDED' : 'PLANNED' })

  if (r.verdict.category === 'UNKNOWN') excluded.push('STATE_UNKNOWN')
  if (r.verdict.reasons.includes('CURRENT_DIR')) excluded.push('CURRENT_DIR')

  if (op === 'cache-only') {
    const caches = regenerable(r)
    if (caches.length === 0) excluded.push('NO_REGENERABLE_CACHE')
    base.targets = caches.map(c => c.path)
    const sum = caches.reduce((a, c) => a + (c.bytes ?? 0), 0)
    const unknownSize = caches.some(c => c.bytes === undefined)
    base.estimatedReclaimBytes = excluded.length > 0 ? undefined : sum
    base.reclaimNote = `推定 ${humanBytes(sum)}${unknownSize ? ' 以上 (サイズ不明あり)' : ''}。再生成すれば再び使われる。リポジトリの使用量に含まれるため他の候補と合算しない`
    base.steps = caches.map(c => ['(dry-run) 削除候補', c.path, `再生成: ${c.regen ?? '不明'}`])
    return done()
  }

  // archive / relocate はリポジトリ全体を扱うため、保守的に CANDIDATE のみ
  if (r.verdict.category !== 'CANDIDATE') excluded.push('NOT_CANDIDATE')
  if (!dest) excluded.push('NO_DESTINATION')
  else if (!dest.exists || !dest.writable) excluded.push('DESTINATION_UNUSABLE', 'RESTORE_UNCHECKABLE')
  base.targets = [r.path]
  const same = dest && srcMount !== undefined && dest.fs.mount !== undefined ? dest.fs.mount === srcMount : undefined
  base.sameFilesystem = same
  if (same === false && excluded.length === 0) {
    base.estimatedReclaimBytes = r.usageBytes
    base.reclaimNote = `元の削除後に推定 ${humanBytes(r.usageBytes)} (圧縮率・追加ファイルは未考慮)。この計画では削除しない`
  } else if (same === true) {
    base.estimatedReclaimBytes = 0
    base.reclaimNote = '退避先が同じファイルシステムのため、退避しても空き容量は増えない'
  } else {
    base.estimatedReclaimBytes = undefined
    base.reclaimNote = 'ファイルシステムの同一性を判定できないため、回収量は不明'
  }
  if (dest) {
    const name = r.path.slice(r.path.lastIndexOf('/') + 1)
    const bundle = `${dest.path}/${name}.bundle`
    base.steps = [
      ['(dry-run) git', '-C', r.path, 'bundle', 'create', bundle, '--all'],
      ['(dry-run) 追加で保全するもの: stash・hooks・.git/config・未追跡ファイルの一覧を manifest に記録'],
    ]
    base.restoreRehearsal = [
      `git bundle verify ${bundle}`,
      '一時ディレクトリへ clone し、ref 一覧と HEAD を元のリポジトリと比較する',
      'manifest の sha256 とバンドルの再計算値が一致することを確認する',
      '一致しない・実行できない場合は元を残し、操作を拒否する',
    ]
    base.manifest = {
      schema: 'repo-preservation-manifest-draft-1', source: r.path,
      note: op === 'relocate' ? '退避後の元の削除は別操作・別承認' : 'アーカイブの作成のみ。元は残る',
      contents: ['git bundle (--all)', 'stash の一覧', 'hooks / .git/config', '未追跡ファイルの一覧'],
      hashes: 'sha256 を作成時に記録する (未計算)',
    }
  }
  return done()
}

export const formatPlan = (p: Plan): string => {
  const lines = ['# 保全計画 (Dry Run・何も実行していない)', 'schema: ' + p.schema]
  if (p.degraded.length > 0) lines.push('', ...p.degraded.map(d => `- ${d}`))
  for (const i of p.items) {
    lines.push('', `## ${sanitize(i.path)} — ${i.operation} [${i.status}]`)
    if (i.excluded.length > 0) lines.push(`除外理由: ${i.excluded.join(', ')}`)
    lines.push(`対象: ${i.targets.map(sanitize).join(', ') || 'なし'}`, `回収量: ${i.reclaimNote || '該当なし'}`)
    if (i.steps.length > 0) lines.push('実行予定 (まだ実行しない):', ...i.steps.map(s => `  - ${s.map(sanitize).join(' ')}`))
    if (i.restoreRehearsal.length > 0) lines.push('復元リハーサル:', ...i.restoreRehearsal.map(s => `  - ${sanitize(s)}`))
    if (i.manifest) lines.push(`manifest 案: ${i.manifest.contents.join(' / ')} (${i.manifest.note})`)
    lines.push('実行前に必要: ' + i.requiresBeforeExecution.join(' / '), '未確認: ' + i.unconfirmed.join(' / '))
  }
  lines.push('', 'この計画は実行許可ではない。キャッシュのみ削除・アーカイブ・リポジトリ退避は別の操作として扱い、実行は明示承認後の別機能で行う。')
  return lines.join('\n')
}
