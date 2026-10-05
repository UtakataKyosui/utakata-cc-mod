export type Config = {
  verifyCommand: string
  worktreeRoot: string
  guardDestructive: boolean
  autoCollect: boolean
}

export const readConfig = (options: Record<string, unknown> | undefined): Config => ({
  verifyCommand: typeof options?.verifyCommand === 'string' ? options.verifyCommand.trim() : '',
  worktreeRoot: typeof options?.worktreeRoot === 'string' ? options.worktreeRoot.trim() : '',
  guardDestructive: options?.guardDestructive !== false,
  autoCollect: options?.autoCollect !== false,
})

export type Mode = 'write' | 'read'
/** research は読み取り専用タスク。verified だけが完了。 */
export type State = 'research' | 'working' | 'ready' | 'blocked' | 'integrated' | 'verified'

export type Task = {
  id: string
  mode: Mode
  scope: string[]
  description: string
  base: string
  branch?: string
  path?: string
  /** 割り当て時点で既にあったユーザーの未コミット変更 */
  userDirty: string[]
  state: State
  createdAt: string
  patchFile?: string
}

const TRANSITIONS: Record<State, State[]> = {
  research: [],
  working: ['working', 'ready', 'blocked'],
  ready: ['working', 'ready', 'blocked', 'integrated'],
  blocked: ['working', 'ready', 'blocked'],
  integrated: ['integrated', 'verified'],
  verified: [],
}

export const canTransition = (from: State, to: State): boolean => TRANSITIONS[from].includes(to)

export const isValidId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(id)

const normalize = (p: string): string => p.trim().replace(/^\.\//, '').replace(/\/+$/, '')

const globToRegExp = (glob: string): RegExp => {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** 担当範囲に入るか。glob を含まない指定はファイルそのものか、そのディレクトリ配下。 */
export const inScope = (file: string, scope: readonly string[]): boolean => {
  const f = normalize(file)
  return scope.some(raw => {
    const s = normalize(raw)
    if (s === '') return false
    if (/[*?]/.test(s)) return globToRegExp(s).test(f)
    return f === s || f.startsWith(`${s}/`)
  })
}

export const outOfScope = (files: readonly string[], scope: readonly string[]): string[] =>
  files.filter(f => !inScope(f, scope))

/** 他タスクの変更ファイルと重なるもの。 */
export const overlaps = (files: readonly string[], others: Record<string, readonly string[]>): Record<string, string[]> => {
  const mine = new Set(files)
  const out: Record<string, string[]> = {}
  for (const [id, theirs] of Object.entries(others)) {
    const shared = theirs.filter(f => mine.has(f))
    if (shared.length > 0) out[id] = shared
  }
  return out
}

/** `git status --porcelain=v1 -z` から変更パスを取り出す。リネームは新旧の両方。 */
export const parsePorcelain = (out: string): string[] => {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!
    if (e.length < 4) continue
    paths.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') {
      const old = parts[++i]
      if (old) paths.push(old)
    }
  }
  return paths
}

export const lines = (out: string): string[] => out.split('\n').filter(l => l !== '')

export type Blocker = { kind: 'out-of-scope' | 'overlap' | 'user-change' | 'conflict'; detail: string }

export type CheckInput = {
  files: readonly string[]
  scope: readonly string[]
  others: Record<string, readonly string[]>
  userDirty: readonly string[]
  applyError: string | undefined
}

/** 統合前の判定。ひとつでも blocker があれば統合しない。 */
export const evaluate = (i: CheckInput): Blocker[] => {
  const blockers: Blocker[] = []
  const stray = outOfScope(i.files, i.scope)
  if (stray.length > 0) blockers.push({ kind: 'out-of-scope', detail: stray.join(', ') })
  for (const [id, shared] of Object.entries(overlaps(i.files, i.others)))
    blockers.push({ kind: 'overlap', detail: `${id} と同じファイルを変更: ${shared.join(', ')}` })
  const dirty = new Set(i.userDirty)
  const touched = i.files.filter(f => dirty.has(f))
  if (touched.length > 0) blockers.push({ kind: 'user-change', detail: `ユーザーの未コミット変更と重なる: ${touched.join(', ')}` })
  if (i.applyError !== undefined) blockers.push({ kind: 'conflict', detail: i.applyError })
  return blockers
}

export const formatBlockers = (blockers: readonly Blocker[]): string =>
  blockers.map(b => `- [${b.kind}] ${b.detail}`).join('\n')

const STATE_LABEL: Record<State, string> = {
  research: '調査中 (共有の読み取り領域)',
  working: '作業中・未統合',
  ready: '統合可能・未統合',
  blocked: '統合不可・未統合',
  integrated: '統合済み・未検証',
  verified: '完了 (統合・検証済み)',
}

/** 完了と呼べるのは verified だけ。 */
export const isDone = (t: Task): boolean => t.state === 'verified'

export const isPending = (t: Task): boolean => t.mode === 'write' && !isDone(t)

export const summarize = (tasks: readonly Task[]): string => {
  if (tasks.length === 0) return '登録されたタスクはない。'
  const rows = tasks.map(t => `- ${t.id}: ${STATE_LABEL[t.state]}${t.path ? ` (${t.path})` : ''}`)
  const pending = tasks.filter(isPending).length
  return [...rows, pending > 0 ? `未完了の書き込みタスクが ${pending} 件ある。統合・検証が済むまで完了と報告しない。` : '書き込みタスクはすべて完了している。']
    .join('\n')
}

/** git の引数列からサブコマンドとその引数を取り出す。-C と -c は値を取る。 */
const subcommand = (tokens: readonly string[]): { sub: string; rest: string[] } | undefined => {
  const at = tokens.findIndex(t => !/^\w+=/.test(t))
  if (at < 0 || !(tokens[at] === 'git' || tokens[at]!.endsWith('/git'))) return undefined
  let i = at + 1
  while (i < tokens.length && tokens[i]!.startsWith('-')) i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1
  const sub = tokens[i]
  return sub === undefined ? undefined : { sub, rest: tokens.slice(i + 1) }
}

const shortFlag = (rest: readonly string[], ch: string): boolean => rest.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(ch))

/** 破壊的な git 操作なら名前を返す。 */
export const destructiveGit = (command: string): string | undefined => {
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const cmd = subcommand(seg.trim().split(/\s+/))
    if (cmd === undefined) continue
    const { sub, rest } = cmd
    if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard'
    if (sub === 'clean' && (rest.includes('--force') || shortFlag(rest, 'f'))) return 'git clean -f'
    if (sub === 'push' && (rest.includes('--force') || shortFlag(rest, 'f') || rest.some(a => /^\+\S/.test(a))))
      return 'git push --force'
    if (sub === 'worktree' && rest[0] === 'remove' && (rest.includes('--force') || shortFlag(rest, 'f')))
      return 'git worktree remove --force'
  }
  return undefined
}

export const guidance = (): string =>
  [
    '書き込みを行う並列タスクは、委譲前に mcp__workspace-isolation__workspace_assign で専用 worktree と担当範囲を割り当てる。',
    '- 委譲先にはその worktree のパスを作業ディレクトリとして伝え、担当範囲外を触らせない',
    '- 統合前に workspace_check で範囲外変更・タスク間の重なり・ユーザー変更との衝突・適用可否を確認する。blocked のものは統合しない',
    '- workspace_integrate は差分を作業ツリーに適用するだけで、commit・push はしない。上書きはせず、衝突時は失敗する',
    '- 統合後は workspace_verify で検証する。integrated までは完了と報告しない。完了は verified だけ',
    '- 中断・終了時は workspace_collect で差分を保存する。worktree やブランチを削除しない',
    '- 調査だけのタスクは mode: read で登録し、worktree は作らない',
  ].join('\n')
