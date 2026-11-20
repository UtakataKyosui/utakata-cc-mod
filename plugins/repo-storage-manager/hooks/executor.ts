// 承認済みの操作を実行する層。実行前に必ず再検査し、変更はジャーナルに残す。
// rm -rf は使わない: 削除は、検証済みの退避ディレクトリ (.rsm-trash-*) に対する `rm -r -- <path>` だけ。
import type { Run } from './runner'
import {
  type Journal, OP_ID, PLAN_ID, basename, cwdFromLsof, claudePids, digest, dirname, isAbsolutePath, isCacheTarget,
  isQuarantineRoot, mountFromDf, parseJournal, quarantineRoot, trimSlash, within,
} from './exec'
import type { PlanItem, Plan } from './plan'
import { type RepoReport, sanitize } from './policy'

export type FsLike = { read(p: string): Promise<string>; write(p: string, t: string): Promise<unknown> }
export type Ctx = { run: Run; fs: FsLike; now: () => Promise<number>; rescan: (path: string) => Promise<RepoReport | undefined> }

export type Outcome = { path: string; ok: boolean; opId?: string; steps: string[]; problems: string[]; measuredBytes?: number }

const ok = async (run: Run, argv: string[]) => (await run(argv)).exitCode === 0
const out = async (run: Run, argv: string[]) => {
  const r = await run(argv)
  return r.exitCode === 0 ? r.stdout : undefined
}
const mountOf = async (run: Run, p: string) => mountFromDf((await out(run, ['df', '-Pk', p])) ?? '')

/** HEAD・status・refs・stash から、計画後に状態が変わったかを検出するダイジェストを作る。 */
export const fingerprintOf = async (run: Run, path: string): Promise<string | undefined> => {
  const parts = await Promise.all([
    out(run, ['git', '-C', path, 'rev-parse', 'HEAD']),
    out(run, ['git', '-C', path, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    out(run, ['git', '-C', path, 'for-each-ref', '--format=%(refname) %(objectname)']),
    out(run, ['git', '-C', path, 'stash', 'list']),
  ])
  // HEAD はコミットが無いリポジトリで失敗するが、その場合は UNKNOWN で計画に入らない
  return parts.some(p => p === undefined) ? undefined : digest(parts.join('\u0000'))
}

/** 稼働中の claude プロセスの cwd。取得できなければ undefined (呼び出し側は実行を拒否する)。 */
export const activeCwds = async (run: Run): Promise<string[] | undefined> => {
  const ps = await out(run, ['ps', '-eo', 'pid,args'])
  if (ps === undefined) return undefined
  const cwds: string[] = []
  for (const pid of claudePids(ps)) {
    const r = await run(['lsof', '-p', String(pid), '-a', '-d', 'cwd', '-Fn'])
    if (r.exitCode !== 0) return undefined
    const cwd = cwdFromLsof(r.stdout)
    if (cwd) cwds.push(cwd)
  }
  return cwds
}

const stateOf = (r: RepoReport) => `${r.verdict.category}:${r.verdict.reasons.join(',')}`

/** 計画時と実行直前で同じ式で計算するダイジェスト。判定か git の状態が変われば一致しない。 */
export const stateDigestOf = async (run: Run, r: RepoReport): Promise<string | undefined> => {
  const fp = await fingerprintOf(run, r.path)
  return fp === undefined ? undefined : digest(`${stateOf(r)}|${fp}`)
}

/** 実行直前の再検査 (TOCTOU 対策)。問題の一覧を返し、空なら実行してよい。 */
export const revalidate = async (ctx: Ctx, plan: Plan, item: PlanItem): Promise<string[]> => {
  const { run } = ctx
  const problems: string[] = []
  const repo = item.path
  if (!isAbsolutePath(repo)) return ['PATH_INVALID']
  if (item.status !== 'PLANNED') return ['PLAN_ITEM_EXCLUDED']

  const top = (await out(run, ['git', '-C', repo, 'rev-parse', '--show-toplevel']))?.trim()
  if (top !== trimSlash(repo)) problems.push('PATH_NOT_CANONICAL (symlink 経由・リポジトリのルートでない)')
  const isDir = (await out(run, ['find', repo, '-maxdepth', '0', '-type', 'd']))?.trim()
  if (isDir !== repo) problems.push('REPO_IS_SYMLINK_OR_MISSING')

  const now = await ctx.rescan(repo)
  if (!now) problems.push('RESCAN_FAILED')
  else if (item.stateDigest === undefined || (await stateDigestOf(run, now)) !== item.stateDigest) problems.push('STATE_CHANGED (計画後に git の状態か判定が変わった)')
  else if (now.verdict.category === 'UNKNOWN') problems.push('STATE_UNKNOWN')

  const cwds = await activeCwds(run)
  if (cwds === undefined) problems.push('ACTIVE_SESSION_UNCHECKABLE (ps / lsof で稼働中セッションを確認できない)')
  else if (cwds.some(c => within(c, repo))) problems.push('ACTIVE_SESSION (稼働中の Claude セッションがこのリポジトリにいる)')

  if (item.operation === 'cache-only') {
    for (const t of item.targets) {
      if (!isCacheTarget(repo, t)) { problems.push(`TARGET_NOT_ALLOWED ${sanitize(t)}`); continue }
      if ((await out(run, ['find', t, '-maxdepth', '0', '-type', 'd']))?.trim() !== t) problems.push(`TARGET_NOT_DIR_OR_SYMLINK ${sanitize(t)}`)
      const tracked = await run(['git', '-C', repo, 'ls-files', '--', basename(t)])
      if (tracked.exitCode !== 0 || tracked.stdout.trim() !== '') problems.push(`TARGET_TRACKED ${sanitize(t)}`)
      if (!(await ok(run, ['git', '-C', repo, 'check-ignore', '-q', '--', basename(t)]))) problems.push(`TARGET_NOT_IGNORED ${sanitize(t)}`)
    }
  } else {
    if (item.destination === undefined || !isAbsolutePath(item.destination)) problems.push('DESTINATION_INVALID')
    else if (!(await ok(run, ['test', '-d', item.destination])) || !(await ok(run, ['test', '-w', item.destination]))) problems.push('DESTINATION_UNUSABLE')
    if (within(item.destination ?? '/\0', repo)) problems.push('DESTINATION_INSIDE_REPO')
  }
  void plan
  return problems
}

const writeJournal = (ctx: Ctx, root: string, j: Journal) => ctx.fs.write(`${root}/journal.json`, JSON.stringify(j, null, 2))

/** 退避: 同一 FS 上の rename だけ。コピーになる移動 (別 FS) は拒否する。 */
const stage = async (ctx: Ctx, repo: string, root: string, entries: Journal['entries'], steps: string[]): Promise<string | undefined> => {
  const { run } = ctx
  if (!(await ok(run, ['mkdir', '--', root]))) return `退避ディレクトリを作れない: ${sanitize(root)} (既にある場合も拒否)`
  const rootMount = await mountOf(run, root)
  for (const e of entries) {
    const srcMount = await mountOf(run, e.from)
    if (srcMount === undefined || rootMount === undefined || srcMount !== rootMount) return `別ファイルシステムのため退避しない (コピーになる): ${sanitize(e.from)}`
  }
  void repo
  for (const e of entries) {
    if (await ok(run, ['test', '-e', e.to])) return `退避先が既に存在する: ${sanitize(e.to)}`
    const r = await run(['mv', '-n', '--', e.from, e.to])
    if (r.exitCode !== 0) return `mv に失敗: ${sanitize(e.from)} ${sanitize(r.stderr).slice(0, 200)}`
    steps.push(`退避: ${e.from} -> ${e.to}`)
  }
  return undefined
}

const sha256Of = async (run: Run, file: string): Promise<string | undefined> => {
  for (const argv of [['sha256sum', '--', file], ['shasum', '-a', '256', '--', file]]) {
    const r = await run(argv)
    const m = r.exitCode === 0 ? /^([0-9a-f]{64})\b/.exec(r.stdout.trim()) : null
    if (m) return m[1]
  }
  return undefined
}

const refsOf = async (run: Run, repo: string) =>
  (await out(run, ['git', '-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']))?.trim().split('\n').sort().join('\n')

/** git bundle の作成・検証・復元リハーサル・manifest。失敗したら作ったファイルだけを片付け、元は触らない。 */
const archive = async (ctx: Ctx, plan: Plan, item: PlanItem, opId: string, steps: string[]): Promise<{ archive?: Journal['archive']; problem?: string }> => {
  const { run } = ctx
  const repo = item.path
  const dest = trimSlash(item.destination!)
  const bundle = `${dest}/${basename(repo)}-${opId}.bundle`
  const manifest = `${dest}/${basename(repo)}-${opId}.manifest.json`
  const rehearsal = `${dest}/.rsm-rehearsal-${opId.slice(4)}`
  const created: string[] = []
  const fail = async (problem: string) => {
    for (const f of created) if (f.startsWith(`${dest}/`)) await run(['rm', '--', f])
    if (await ok(run, ['test', '-d', rehearsal])) await run(['rm', '-r', '--', rehearsal])
    return { problem }
  }
  if (await ok(run, ['test', '-e', bundle]) || await ok(run, ['test', '-e', manifest])) return fail('退避先に同名のファイルがある')
  const before = await refsOf(run, repo)
  if (before === undefined) return fail('refs を取得できない')
  const mk = await run(['git', '-C', repo, 'bundle', 'create', bundle, '--all'])
  if (mk.exitCode !== 0) return fail(`bundle の作成に失敗: ${sanitize(mk.stderr).slice(0, 200)}`)
  created.push(bundle)
  steps.push(`bundle 作成: ${bundle}`)
  if (!(await ok(run, ['git', '-C', repo, 'bundle', 'verify', bundle]))) return fail('bundle verify に失敗')
  const clone = await run(['git', 'clone', '--quiet', '--bare', '--', bundle, rehearsal])
  if (clone.exitCode !== 0) return fail(`復元リハーサル (clone) に失敗: ${sanitize(clone.stderr).slice(0, 200)}`)
  const after = await refsOf(run, rehearsal)
  const headSrc = (await out(run, ['git', '-C', repo, 'rev-parse', 'HEAD']))?.trim()
  const headDst = (await out(run, ['git', '-C', rehearsal, 'rev-parse', 'HEAD']))?.trim()
  if (await ok(run, ['test', '-d', rehearsal])) await run(['rm', '-r', '--', rehearsal])
  if (after !== before || !headSrc || headSrc !== headDst) return fail('復元リハーサルで ref か HEAD が元と一致しない')
  steps.push('復元リハーサル: ref 一覧と HEAD が一致')
  const sha256 = await sha256Of(run, bundle)
  if (!sha256) return fail('sha256 を計算できない (sha256sum / shasum が無い)')
  const body = {
    schema: 'repo-preservation-manifest-1', opId, planId: plan.planId, source: repo, head: headSrc, bundle, sha256,
    refs: before.split('\n'), verifiedAt: new Date(await ctx.now()).toISOString(),
    restore: `git clone -- ${bundle} <復元先>`, rehearsal: { refsMatch: true, headMatch: true },
  }
  try { await ctx.fs.write(manifest, JSON.stringify(body, null, 2)) } catch (e) { return fail(`manifest を書けない: ${String(e)}`) }
  created.push(manifest)
  return { archive: { bundle, manifest, sha256 } }
}

export const executeItem = async (ctx: Ctx, plan: Plan, item: PlanItem, index: number): Promise<Outcome> => {
  const steps: string[] = []
  const problems = await revalidate(ctx, plan, item)
  const opId = `${plan.planId}-${index}`
  if (problems.length > 0) return { path: item.path, ok: false, opId, steps, problems }
  if (!PLAN_ID.test(plan.planId) || !OP_ID.test(opId)) return { path: item.path, ok: false, steps, problems: ['ID_INVALID'] }
  const repo = item.path
  const root = quarantineRoot(repo, opId)
  const base = { schema: 'repo-preservation-journal-1' as const, opId, planId: plan.planId, operation: item.operation, repo, createdAt: new Date(await ctx.now()).toISOString() }

  let arch: Journal['archive'] | undefined
  if (item.operation !== 'cache-only') {
    const a = await archive(ctx, plan, item, opId, steps)
    if (a.problem) return { path: item.path, ok: false, opId, steps, problems: [a.problem] }
    arch = a.archive
    if (item.operation === 'archive') {
      steps.push('アーカイブのみ。元は残している')
      return { path: repo, ok: true, opId, steps, problems: [] }
    }
    // relocate: アーカイブに時間がかかった可能性があるため、退避の直前にもう一度再検査する
    const again = await revalidate(ctx, plan, item)
    if (again.length > 0) return { path: repo, ok: false, opId, steps, problems: ['アーカイブ後に状態が変わったため、元の退避をしなかった (アーカイブは残る)', ...again] }
  }

  const entries: Journal['entries'] = item.operation === 'relocate'
    ? [{ name: basename(repo), from: repo, to: `${root}/${basename(repo)}` }]
    : item.targets.map(t => ({ name: basename(t), from: t, to: `${root}/${basename(t)}` }))
  const measured = (await Promise.all(entries.map(async e => (await out(ctx.run, ['du', '-sk', '-x', e.from]))))).reduce((a, o) => a + (o ? Number(o.split('\t')[0]) * 1024 : 0), 0)
  const bad = await stage(ctx, repo, root, entries, steps)
  const journal: Journal = { ...base, status: bad ? 'failed' : 'staged', entries, ...(arch ? { archive: arch } : {}), measuredBytes: measured, ...(bad ? { note: bad } : {}) }
  try { await writeJournal(ctx, root, journal) } catch (e) { steps.push(`ジャーナルを書けない: ${String(e)}`) }
  if (bad) {
    // 部分失敗: 途中まで退避したものを元に戻す
    for (const e of entries) if (await ok(ctx.run, ['test', '-e', e.to]) && !(await ok(ctx.run, ['test', '-e', e.from]))) await ctx.run(['mv', '-n', '--', e.to, e.from])
    return { path: repo, ok: false, opId, steps, problems: [bad, '途中まで退避したものは元に戻した'] }
  }
  steps.push('退避のみ。容量は purge するまで回収されない')
  return { path: repo, ok: true, opId, steps, problems: [], measuredBytes: measured }
}

const loadJournal = async (ctx: Ctx, repo: string, opId: string): Promise<{ root: string; journal?: Journal; problem?: string }> => {
  if (!isAbsolutePath(repo) || !OP_ID.test(opId)) return { root: '', problem: 'repo か op_id が不正' }
  const root = quarantineRoot(repo, opId)
  if (!isQuarantineRoot(root, repo)) return { root, problem: '退避ディレクトリの形式が不正' }
  if ((await out(ctx.run, ['find', root, '-maxdepth', '0', '-type', 'd']))?.trim() !== root) return { root, problem: '退避ディレクトリが無い、または symlink' }
  let text: string
  try { text = await ctx.fs.read(`${root}/journal.json`) } catch { return { root, problem: 'ジャーナルを読めない' } }
  const journal = parseJournal(text)
  if (!journal || journal.opId !== opId || journal.repo !== trimSlash(repo)) return { root, problem: 'ジャーナルが不正、または op_id と一致しない' }
  return { root, journal }
}

/** 退避したものを元に戻す。元の場所に何かあれば拒否する。 */
export const restore = async (ctx: Ctx, repo: string, opId: string): Promise<Outcome> => {
  const steps: string[] = []
  const { root, journal, problem } = await loadJournal(ctx, repo, opId)
  if (!journal) return { path: repo, ok: false, opId, steps, problems: [problem ?? 'unknown'] }
  if (journal.status !== 'staged') return { path: repo, ok: false, opId, steps, problems: [`状態が staged ではない (${journal.status})`] }
  for (const e of journal.entries) if (await ok(ctx.run, ['test', '-e', e.from])) return { path: repo, ok: false, opId, steps, problems: [`元の場所に既に存在する: ${sanitize(e.from)}`] }
  for (const e of journal.entries) {
    const r = await ctx.run(['mv', '-n', '--', e.to, e.from])
    if (r.exitCode !== 0) return { path: repo, ok: false, opId, steps, problems: [`mv に失敗: ${sanitize(e.from)}`] }
    steps.push(`復元: ${e.to} -> ${e.from}`)
  }
  await writeJournal(ctx, root, { ...journal, status: 'restored' })
  return { path: repo, ok: true, opId, steps, problems: [] }
}

/** 退避済みのものを削除する。検証済みの退避ディレクトリに対する `rm -r -- <path>` だけを実行する。 */
export const purge = async (ctx: Ctx, repo: string, opId: string): Promise<Outcome & { freedBytes?: number }> => {
  const steps: string[] = []
  const { root, journal, problem } = await loadJournal(ctx, repo, opId)
  if (!journal) return { path: repo, ok: false, opId, steps, problems: [problem ?? 'unknown'] }
  if (journal.status !== 'staged') return { path: repo, ok: false, opId, steps, problems: [`状態が staged ではない (${journal.status})`] }
  if (journal.operation === 'relocate' && !journal.archive) return { path: repo, ok: false, opId, steps, problems: ['アーカイブの記録が無い relocate は削除しない (復元不能)'] }
  if (journal.operation === 'relocate' && !(await ok(ctx.run, ['test', '-f', journal.archive!.bundle]))) return { path: repo, ok: false, opId, steps, problems: ['アーカイブの bundle が見つからないため削除しない (復元不能)'] }
  if (journal.archive && (await sha256Of(ctx.run, journal.archive.bundle)) !== journal.archive.sha256) return { path: repo, ok: false, opId, steps, problems: ['bundle の sha256 が記録と一致しないため削除しない'] }
  const cwds = await activeCwds(ctx.run)
  if (cwds === undefined || cwds.some(c => within(c, root) || within(c, repo))) return { path: repo, ok: false, opId, steps, problems: ['稼働中セッションを確認できない、またはこの場所にいる'] }
  const sizeText = await out(ctx.run, ['du', '-sk', '-x', root])
  const bytes = sizeText ? Number(sizeText.split('\t')[0]) * 1024 : undefined
  const freeBefore = await out(ctx.run, ['df', '-Pk', dirname(root)])
  const r = await ctx.run(['rm', '-r', '--', root])
  if (r.exitCode !== 0) return { path: repo, ok: false, opId, steps, problems: [`rm に失敗: ${sanitize(r.stderr).slice(0, 200)}`, '一部だけ削除された可能性がある。状態を確認すること'] }
  steps.push(`削除: ${root}`)
  const freeAfter = await out(ctx.run, ['df', '-Pk', dirname(root)])
  const avail = (t: string | undefined) => (t ? Number(t.trim().split('\n')[1]?.split(/\s+/)[3]) * 1024 : NaN)
  const delta = avail(freeAfter) - avail(freeBefore)
  steps.push(`実測: 削除した退避データ ${bytes ?? '不明'} bytes (du)、空き容量の変化 ${Number.isFinite(delta) ? delta : '不明'} bytes (df。他のプロセスの影響を含む)`)
  return { path: repo, ok: true, opId, steps, problems: [], ...(bytes === undefined ? {} : { measuredBytes: bytes }), ...(Number.isFinite(delta) ? { freedBytes: delta } : {}) }
}
