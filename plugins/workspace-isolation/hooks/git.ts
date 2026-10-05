import {
  type Config,
  type Mode,
  type State,
  type Task,
  canTransition,
  evaluate,
  formatBlockers,
  isPending,
  isValidId,
  lines,
  parsePorcelain,
  summarize,
} from './policy'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Io = {
  run: (argv: string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }) => Promise<RunResult>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}
export type Outcome = { ok: boolean; text: string }

const fail = (text: string): Outcome => ({ ok: false, text })
const done = (text: string): Outcome => ({ ok: true, text })
const err = (r: RunResult): string => r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`

type Repo = { root: string; store: string }

const repoOf = async (io: Io): Promise<Repo | undefined> => {
  const top = await io.run(['git', 'rev-parse', '--show-toplevel'])
  const common = await io.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (top.exitCode !== 0 || common.exitCode !== 0) return undefined
  return { root: top.stdout.trim(), store: `${common.stdout.trim()}/workspace-isolation` }
}

const load = async (io: Io, repo: Repo): Promise<Task[]> => {
  const path = `${repo.store}/tasks.json`
  if (!(await io.exists(path))) return []
  try {
    const parsed: unknown = JSON.parse(await io.read(path))
    return Array.isArray(parsed) ? (parsed as Task[]) : []
  } catch {
    return []
  }
}

const save = (io: Io, repo: Repo, tasks: Task[]): Promise<void> =>
  io.write(`${repo.store}/tasks.json`, `${JSON.stringify(tasks, null, 2)}\n`)

const update = async (io: Io, repo: Repo, task: Task, state: State, extra: Partial<Task> = {}): Promise<string | undefined> => {
  if (!canTransition(task.state, state)) return `${task.id}: ${task.state} から ${state} へは遷移できない`
  const tasks = await load(io, repo)
  const i = tasks.findIndex(t => t.id === task.id)
  if (i < 0) return `${task.id} が見つからない`
  tasks[i] = { ...task, ...extra, state }
  await save(io, repo, tasks)
  return undefined
}

const dirtyFiles = async (io: Io, cwd: string): Promise<string[]> => {
  const r = await io.run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
  return r.exitCode === 0 ? parsePorcelain(r.stdout) : []
}

/** worktree の全変更 (コミット済み・未コミット・新規) をベースからの差分として取る。 */
const snapshot = async (io: Io, task: Task): Promise<{ files: string[]; patch: string } | string> => {
  if (task.path === undefined) return '読み取りタスクには差分がない'
  const cwd = task.path
  const intent = await io.run(['git', 'add', '--intent-to-add', '--all'], { cwd })
  if (intent.exitCode !== 0) return `git add -N が失敗: ${err(intent)}`
  const names = await io.run(['git', 'diff', '--no-renames', '--name-only', task.base], { cwd })
  const patch = await io.run(['git', 'diff', '--no-renames', '--binary', task.base], { cwd })
  if (names.exitCode !== 0 || patch.exitCode !== 0) return `git diff が失敗: ${err(names.exitCode !== 0 ? names : patch)}`
  return { files: lines(names.stdout), patch: patch.stdout }
}

const find = (tasks: Task[], id: unknown): Task | string =>
  isValidId(id) ? (tasks.find(t => t.id === id) ?? `タスク ${id} は登録されていない`) : 'id は英小文字・数字・ハイフンで指定する'

export type AssignInput = { id?: string; mode?: Mode; scope?: string[]; description?: string }

export const assign = async (io: Io, cfg: Config, input: AssignInput): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  if (!isValidId(input.id)) return fail('id は英小文字・数字・ハイフンで指定する')
  const mode: Mode = input.mode === 'read' ? 'read' : 'write'
  const scope = (input.scope ?? []).filter(s => typeof s === 'string' && s.trim() !== '')
  if (mode === 'write' && scope.length === 0) return fail('書き込みタスクには scope (担当するパスや glob) が必要')
  const tasks = await load(io, repo)
  if (tasks.some(t => t.id === input.id)) return fail(`タスク ${input.id} は登録済み`)

  const head = await io.run(['git', 'rev-parse', 'HEAD'], { cwd: repo.root })
  if (head.exitCode !== 0) return fail(`HEAD を解決できない: ${err(head)}`)
  const base = head.stdout.trim()
  const userDirty = await dirtyFiles(io, repo.root)
  const task: Task = {
    id: input.id,
    mode,
    scope,
    description: input.description ?? '',
    base,
    userDirty,
    state: mode === 'read' ? 'research' : 'working',
    createdAt: new Date().toISOString(),
  }

  if (mode === 'write') {
    const name = repo.root.split('/').pop() ?? 'repo'
    const parent = cfg.worktreeRoot !== '' ? cfg.worktreeRoot : `${repo.root}/../${name}-workspaces`
    const path = `${parent}/${input.id}`
    const branch = `ws/${input.id}`
    // -b は既存ブランチを上書きしない。ベースは HEAD のコミットで、作業ツリーのユーザー変更には触れない。
    const add = await io.run(['git', 'worktree', 'add', '-b', branch, path, base], { cwd: repo.root })
    if (add.exitCode !== 0) return fail(`worktree を作れない: ${err(add)}`)
    const resolved = await io.run(['git', 'rev-parse', '--show-toplevel'], { cwd: path })
    task.path = resolved.exitCode === 0 ? resolved.stdout.trim() : path
    task.branch = branch
  }
  await save(io, repo, [...tasks, task])

  return done(
    mode === 'read'
      ? `${task.id}: 読み取りタスクとして登録した。共有の作業ツリーを読むだけにし、書き込ませない。`
      : [
          `${task.id}: worktree を作成した。`,
          `- 作業ディレクトリ: ${task.path}`,
          `- ブランチ: ${task.branch} / ベース: ${base.slice(0, 12)}`,
          `- 担当範囲: ${scope.join(', ')}`,
          userDirty.length > 0
            ? `- 開始前のユーザー変更 ${userDirty.length} 件は元の作業ツリーにそのまま残る (worktree には含まれない): ${userDirty.slice(0, 10).join(', ')}`
            : '- 開始前のユーザー変更はない',
          '委譲先にはこの作業ディレクトリと担当範囲を伝え、範囲外を触らせないこと。',
        ].join('\n'),
  )
}

export const status = async (io: Io): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  const tasks = await load(io, repo)
  const rows: string[] = []
  for (const t of tasks) {
    if (t.mode === 'write' && !(t.state === 'integrated' || t.state === 'verified')) {
      const snap = await snapshot(io, t)
      rows.push(typeof snap === 'string' ? `${t.id}: 変更の取得に失敗 (${snap})` : `${t.id}: 変更 ${snap.files.length} ファイル`)
    }
  }
  return done([summarize(tasks), ...rows].join('\n'))
}

const othersFiles = async (io: Io, tasks: Task[], self: Task): Promise<Record<string, string[]>> => {
  const out: Record<string, string[]> = {}
  for (const t of tasks) {
    if (t.id === self.id || t.mode !== 'write' || t.state === 'integrated' || t.state === 'verified') continue
    const snap = await snapshot(io, t)
    if (typeof snap !== 'string') out[t.id] = snap.files
  }
  return out
}

const evaluateTask = async (io: Io, repo: Repo, tasks: Task[], task: Task) => {
  const snap = await snapshot(io, task)
  if (typeof snap === 'string') return snap
  // --check は作業ツリーを書き換えない。ユーザーが後から変えたファイルとの食い違いもここで分かる。
  const apply =
    snap.patch === ''
      ? undefined
      : await io.run(['git', 'apply', '--check', '--binary', '-'], { cwd: repo.root, stdin: snap.patch })
  const current = await dirtyFiles(io, repo.root)
  const blockers = evaluate({
    files: snap.files,
    scope: task.scope,
    others: await othersFiles(io, tasks, task),
    userDirty: [...new Set([...task.userDirty, ...current])],
    applyError: apply !== undefined && apply.exitCode !== 0 ? err(apply) : undefined,
  })
  return { ...snap, blockers }
}

export const check = async (io: Io, id: unknown): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  const tasks = await load(io, repo)
  const task = find(tasks, id)
  if (typeof task === 'string') return fail(task)
  if (task.mode === 'read') return fail('読み取りタスクは統合の対象ではない')
  if (task.state === 'integrated' || task.state === 'verified') return done(`${task.id}: 統合済み (${task.state})`)
  const r = await evaluateTask(io, repo, tasks, task)
  if (typeof r === 'string') return fail(r)
  if (r.files.length === 0) return done(`${task.id}: まだ変更がない。作業中のまま。`)
  const next: State = r.blockers.length === 0 ? 'ready' : 'blocked'
  const e = await update(io, repo, task, next)
  if (e !== undefined) return fail(e)
  const head = `${task.id}: 変更 ${r.files.length} ファイル (${r.files.slice(0, 10).join(', ')})`
  return r.blockers.length === 0
    ? done(`${head}\n統合可能 (ready)。未統合のため完了ではない。`)
    : { ok: true, text: `${head}\n統合不可 (blocked)。\n${formatBlockers(r.blockers)}\n解消するまで統合しない。強制上書きはしない。` }
}

export const integrate = async (io: Io, id: unknown): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  const tasks = await load(io, repo)
  const task = find(tasks, id)
  if (typeof task === 'string') return fail(task)
  if (task.mode === 'read') return fail('読み取りタスクは統合の対象ではない')
  if (task.state === 'integrated' || task.state === 'verified') return fail(`${task.id} は統合済み`)
  const r = await evaluateTask(io, repo, tasks, task)
  if (typeof r === 'string') return fail(r)
  if (r.files.length === 0) return fail('統合する変更がない')
  if (r.blockers.length > 0) {
    await update(io, repo, task, 'blocked')
    return fail(`統合しなかった。\n${formatBlockers(r.blockers)}`)
  }
  // --3way や --reject は使わない。ひとつでも当たらなければ何も適用されない。
  const applied = await io.run(['git', 'apply', '--binary', '-'], { cwd: repo.root, stdin: r.patch })
  if (applied.exitCode !== 0) {
    await update(io, repo, task, 'blocked')
    return fail(`適用に失敗した。作業ツリーは変更されていない: ${err(applied)}`)
  }
  // チェック済みの扱いにしてから統合済みへ進める。
  const e = await update(io, repo, { ...task, state: 'ready' }, 'integrated')
  if (e !== undefined) return fail(e)
  return done(
    `${task.id}: ${r.files.length} ファイルを作業ツリーに適用した (commit・push はしていない)。\n統合済みだが未検証。workspace_verify で検証するまで完了と報告しない。`,
  )
}

export const verify = async (io: Io, cfg: Config, id: unknown): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  const tasks = await load(io, repo)
  const task = find(tasks, id)
  if (typeof task === 'string') return fail(task)
  if (task.state !== 'integrated') return fail(`${task.id} は ${task.state}。統合済みのタスクだけ検証できる`)
  if (cfg.verifyCommand === '') return fail('verifyCommand が未設定。統合済みのまま完了にはしない')
  const r = await io.run(['sh', '-c', cfg.verifyCommand], { cwd: repo.root, timeoutMs: 600_000 })
  if (r.exitCode !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n')
    return fail(`検証に失敗 (exit ${r.exitCode})。統合済み・未検証のまま。\n${tail}`)
  }
  const e = await update(io, repo, task, 'verified')
  return e === undefined ? done(`${task.id}: 検証に成功した。完了。`) : fail(e)
}

/** 差分をパッチとして保存する。worktree・ブランチ・変更は削除しない。 */
export const collect = async (io: Io, id: unknown): Promise<Outcome> => {
  const repo = await repoOf(io)
  if (repo === undefined) return fail('git リポジトリの中で実行すること')
  const tasks = await load(io, repo)
  const targets = id === undefined ? tasks.filter(isPending) : [find(tasks, id)]
  const out: string[] = []
  let ok = true
  for (const task of targets) {
    if (typeof task === 'string') return fail(task)
    const snap = await snapshot(io, task)
    if (typeof snap === 'string') {
      ok = false
      out.push(`${task.id}: 回収できない (${snap})`)
      continue
    }
    if (snap.files.length === 0) {
      out.push(`${task.id}: 回収する変更がない`)
      continue
    }
    const file = `${repo.store}/patches/${task.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`
    await io.write(file, snap.patch)
    const all = await load(io, repo)
    const i = all.findIndex(t => t.id === task.id)
    if (i >= 0) {
      all[i] = { ...all[i]!, patchFile: file }
      await save(io, repo, all)
    }
    out.push(`${task.id}: ${snap.files.length} ファイルの差分を保存 ${file}\n  worktree ${task.path} とブランチ ${task.branch} は残してある`)
  }
  return { ok, text: out.length === 0 ? '回収対象の未完了タスクはない。' : out.join('\n') }
}

export const pendingSummary = async (io: Io): Promise<string | undefined> => {
  const repo = await repoOf(io)
  if (repo === undefined) return undefined
  const tasks = (await load(io, repo)).filter(isPending)
  return tasks.length === 0 ? undefined : `workspace-isolation の未完了タスク (統合・検証が済むまで完了と報告しない):\n${summarize(tasks)}`
}
