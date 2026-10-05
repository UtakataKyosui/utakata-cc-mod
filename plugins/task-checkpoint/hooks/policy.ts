export const SCHEMA = 1

export const STATUSES = ['pending', 'running', 'blocked', 'failed', 'needs_recheck', 'done'] as const
export type Status = (typeof STATUSES)[number]

export type Artifact = { path: string }
export type Verification = {
  command: string
  result: 'pass' | 'fail'
  at: string
  rev?: string
  /** 検証時点のファイル指紋。照合で現在の指紋と比べる */
  sealed: Record<string, string>
}
export type Task = {
  id: string
  title: string
  status: Status
  deps: string[]
  artifacts: Artifact[]
  verification?: Verification
  note: string
  updatedAt: string
  interruptedAt?: string
}
export type Body = { goal: string; tasks: Task[]; issues: string[] }

export type Config = { saveDir: string; maxPromptTasks: number }

export const readConfig = (options: Readonly<Record<string, unknown>>): Config => {
  const n = Number(options.maxPromptTasks)
  return {
    saveDir: typeof options.saveDir === 'string' && options.saveDir !== '' ? options.saveDir : '.claude/checkpoints',
    maxPromptTasks: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20,
  }
}

export const resolveDir = (root: string, dir: string) => (dir.startsWith('/') ? dir : `${root}/${dir}`)

export const emptyBody = (): Body => ({ goal: '', tasks: [], issues: [] })

// ---- 秘匿 ----

const LIMITS = { goal: 1000, title: 200, note: 500, issue: 300, command: 200 }
const MAX_TASKS = 100
const MAX_ARTIFACTS = 20
const MAX_ISSUES = 20

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
]
const KEY_VALUE = /((?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential)s?["']?\s*[:=]\s*)(["']?)[^\s"',;]+/gi

export const redact = (text: string) => {
  let out = text
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]')
  return out.replace(KEY_VALUE, '$1$2[REDACTED]')
}

/** 秘密値を伏せ、改行を潰して上限で切る。会話全文の丸ごと保存を避ける */
export const clean = (text: unknown, max: number) => {
  const flat = redact(String(text ?? '')).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const SECRET_PATH = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|credentials(\.json)?|\.npmrc|\.netrc)$/i

export const normalizePath = (raw: string): { ok: true; path: string } | { ok: false; error: string } => {
  const p = raw.trim().replace(/^\.\//, '')
  if (p === '' || p.length > 300) return { ok: false, error: 'パスが空か長すぎる' }
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.includes('\\')) {
    return { ok: false, error: `${p}: プロジェクトルートからの相対パスだけ指定できる` }
  }
  if (p.split('/').includes('..')) return { ok: false, error: `${p}: 親ディレクトリは指定できない` }
  if (SECRET_PATH.test(p)) return { ok: false, error: `${p}: 秘密情報を含みうるファイルは記録しない` }
  return { ok: true, path: p }
}

// ---- 保存形式 (スキーマ版・チェックサム・二面書き) ----

/** 改ざん検出ではなく破損検出のための FNV-1a (32bit) */
export const checksum = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export type DecodeFailure = 'parse' | 'shape' | 'checksum' | 'future-schema'

export const encode = (body: Body, seq: number, savedAt: string) => {
  const payload = JSON.stringify(body)
  return JSON.stringify({ schema: SCHEMA, seq, savedAt, checksum: checksum(payload), body })
}

const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

const isTask = (t: any): t is Task =>
  t !== null &&
  typeof t === 'object' &&
  typeof t.id === 'string' &&
  typeof t.title === 'string' &&
  isStatus(t.status) &&
  isStrings(t.deps) &&
  Array.isArray(t.artifacts) &&
  t.artifacts.every((a: any) => a !== null && typeof a === 'object' && typeof a.path === 'string') &&
  typeof t.note === 'string' &&
  typeof t.updatedAt === 'string' &&
  (t.verification === undefined ||
    (t.verification !== null &&
      typeof t.verification === 'object' &&
      (t.verification.result === 'pass' || t.verification.result === 'fail') &&
      t.verification.sealed !== null &&
      typeof t.verification.sealed === 'object'))

export const isBody = (b: any): b is Body =>
  b !== null && typeof b === 'object' && typeof b.goal === 'string' && isStrings(b.issues) && Array.isArray(b.tasks) && b.tasks.every(isTask)

export type Decoded = { ok: true; body: Body; seq: number; savedAt: string } | { ok: false; reason: DecodeFailure; detail?: string }

export const decode = (text: string): Decoded => {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, reason: 'parse', detail: String(err).slice(0, 120) }
  }
  if (raw === null || typeof raw !== 'object' || typeof raw.schema !== 'number' || typeof raw.seq !== 'number') {
    return { ok: false, reason: 'shape' }
  }
  if (raw.schema > SCHEMA) return { ok: false, reason: 'future-schema', detail: `schema ${raw.schema}` }
  if (raw.schema !== SCHEMA || !isBody(raw.body)) return { ok: false, reason: 'shape' }
  if (raw.checksum !== checksum(JSON.stringify(raw.body))) return { ok: false, reason: 'checksum' }
  return { ok: true, body: raw.body, seq: raw.seq, savedAt: String(raw.savedAt ?? '') }
}

export type Candidate = { slot: string; text: string | undefined }
export type SlotIssue = { slot: string; reason: DecodeFailure; detail?: string }
export type Chosen = {
  body: Body | undefined
  seq: number
  slot: string | undefined
  issues: SlotIssue[]
  /** 未来版の面があるときは上書きしない */
  writable: boolean
}

export const SLOTS = ['slot-a.json', 'slot-b.json'] as const

/** 検証に通った面のうち seq が最大のものを採る。壊れた面は診断として返す */
export const choose = (candidates: readonly Candidate[]): Chosen => {
  const out: Chosen = { body: undefined, seq: 0, slot: undefined, issues: [], writable: true }
  for (const c of candidates) {
    if (c.text === undefined) continue
    const d = decode(c.text)
    if (!d.ok) {
      out.issues.push({ slot: c.slot, reason: d.reason, detail: d.detail })
      if (d.reason === 'future-schema') out.writable = false
      continue
    }
    if (out.slot === undefined || d.seq > out.seq) {
      out.body = d.body
      out.seq = d.seq
      out.slot = c.slot
    }
  }
  return out
}

/** 次に書く面。直近に有効だった面と別の面へ書き、書き損じても直前の状態を残す */
export const nextSlot = (current: string | undefined) => (current === SLOTS[0] ? SLOTS[1] : SLOTS[0])

const REASONS: Record<DecodeFailure, string> = {
  parse: 'JSON として読めない',
  shape: '形式が想定と違う',
  checksum: 'チェックサムが一致しない (書き込み途中の破損か手編集)',
  'future-schema': 'このプラグインより新しいスキーマ版で書かれている',
}

export const describeIssues = (issues: readonly SlotIssue[], writable: boolean) =>
  [
    ...issues.map(i => `${i.slot}: ${REASONS[i.reason]}${i.detail ? ` (${i.detail})` : ''}`),
    ...(writable ? [] : ['新しいスキーマ版の保存データがあるため、上書きせず読み取り専用で扱う。プラグインを更新するか保存先を変える']),
  ]

// ---- 状態遷移 ----

const ALLOWED: Record<Status, readonly Status[]> = {
  pending: ['running', 'blocked'],
  running: ['done', 'failed', 'blocked', 'pending'],
  blocked: ['pending', 'running'],
  failed: ['pending', 'running'],
  needs_recheck: ['running', 'done', 'failed', 'pending', 'blocked'],
  done: ['needs_recheck', 'pending'],
}

export const canTransition = (from: Status, to: Status) => from === to || ALLOWED[from].includes(to)

/** ファイルの指紋。照合時に保存時の値と比べる */
export const fingerprint = (stat: { size: number; mtimeMs: number } | undefined) =>
  stat === undefined ? null : `${stat.size}:${Math.floor(stat.mtimeMs)}`

export type Observed = Record<string, string | null>

/** 完了にできるのは、検証が合格で、その後に成果物が変わっていないときだけ */
export const completionBlocker = (task: Task, observed: Observed): string | undefined => {
  const v = task.verification
  if (v === undefined || v.result !== 'pass') return `${task.id}: 合格した検証の記録がないため完了にできない`
  for (const a of task.artifacts) {
    const now = observed[a.path]
    if (now === null || now === undefined) return `${task.id}: 成果物 ${a.path} が見つからない`
    if (v.sealed[a.path] === undefined) return `${task.id}: ${a.path} は検証のあとに追加されたため再検証が要る`
    if (v.sealed[a.path] !== now) return `${task.id}: ${a.path} は検証のあとに変わったため再検証が要る`
  }
  return undefined
}

const ID = /^[A-Za-z0-9_.-]{1,40}$/

const hasCycle = (tasks: readonly Task[], id: string, deps: readonly string[]) => {
  const depsOf = (x: string) => (x === id ? deps : (tasks.find(t => t.id === x)?.deps ?? []))
  const seen = new Set<string>()
  const walk = (x: string): boolean => {
    if (x === id) return true
    if (seen.has(x)) return false
    seen.add(x)
    return depsOf(x).some(walk)
  }
  return deps.some(walk)
}

export type Op =
  | { op: 'goal'; goal: string }
  | { op: 'task'; id: string; title?: string; deps?: string[]; status?: Status; note?: string }
  | { op: 'artifact'; id: string; paths: string[] }
  | { op: 'verify'; id: string; command: string; result: 'pass' | 'fail' }
  | { op: 'issue'; text: string }
  | { op: 'resolve_issue'; index: number }
  | { op: 'reset' }

export type Ctx = { now: string; observed: Observed; rev?: string }
export type Applied = { ok: true; body: Body; message: string } | { ok: false; error: string }

const fail = (error: string): Applied => ({ ok: false, error })

/** 操作が触るパス。呼び出し側が指紋を先に集める */
export const pathsOf = (body: Body, op: Op): string[] => {
  const all = new Set(body.tasks.flatMap(t => t.artifacts.map(a => a.path)))
  if (op.op === 'artifact') for (const p of op.paths) all.add(p.trim().replace(/^\.\//, ''))
  return [...all]
}

export const applyOp = (body: Body, op: Op, ctx: Ctx): Applied => {
  switch (op.op) {
    case 'reset':
      return { ok: true, body: emptyBody(), message: '保存内容を空にした' }
    case 'goal': {
      const goal = clean(op.goal, LIMITS.goal)
      if (goal === '') return fail('ゴールが空')
      return { ok: true, body: { ...body, goal }, message: 'ゴールを記録した' }
    }
    case 'issue': {
      const text = clean(op.text, LIMITS.issue)
      if (text === '') return fail('未解決事項が空')
      if (body.issues.length >= MAX_ISSUES) return fail(`未解決事項は ${MAX_ISSUES} 件まで`)
      return { ok: true, body: { ...body, issues: [...body.issues, text] }, message: '未解決事項を追加した' }
    }
    case 'resolve_issue': {
      if (!Number.isInteger(op.index) || op.index < 1 || op.index > body.issues.length) return fail('その番号の未解決事項はない')
      return { ok: true, body: { ...body, issues: body.issues.filter((_, i) => i !== op.index - 1) }, message: '未解決事項を解消した' }
    }
    case 'task':
      return applyTask(body, op, ctx)
    case 'artifact': {
      const t = body.tasks.find(x => x.id === op.id)
      if (t === undefined) return fail(`タスク ${op.id} がない`)
      const paths = new Set(t.artifacts.map(a => a.path))
      for (const raw of op.paths) {
        const n = normalizePath(raw)
        if (!n.ok) return fail(n.error)
        paths.add(n.path)
      }
      if (paths.size > MAX_ARTIFACTS) return fail(`成果物は 1 タスク ${MAX_ARTIFACTS} 件まで`)
      const next: Task = { ...t, artifacts: [...paths].map(path => ({ path })), updatedAt: ctx.now }
      return replaceTask(body, next, '成果物を記録した')
    }
    case 'verify': {
      const t = body.tasks.find(x => x.id === op.id)
      if (t === undefined) return fail(`タスク ${op.id} がない`)
      if (op.result !== 'pass' && op.result !== 'fail') return fail('result は pass か fail')
      const sealed: Record<string, string> = {}
      for (const a of t.artifacts) {
        const fp = ctx.observed[a.path]
        if (fp !== null && fp !== undefined) sealed[a.path] = fp
      }
      const verification: Verification = {
        command: clean(op.command, LIMITS.command),
        result: op.result,
        at: ctx.now,
        ...(ctx.rev ? { rev: ctx.rev } : {}),
        sealed,
      }
      return replaceTask(body, { ...t, verification, updatedAt: ctx.now }, `検証結果 (${op.result}) を記録した`)
    }
  }
}

const replaceTask = (body: Body, task: Task, message: string): Applied => ({
  ok: true,
  body: { ...body, tasks: body.tasks.map(t => (t.id === task.id ? task : t)) },
  message,
})

const applyTask = (body: Body, op: Extract<Op, { op: 'task' }>, ctx: Ctx): Applied => {
  if (!ID.test(op.id)) return fail('タスク ID は英数字と _ . - の 40 文字まで')
  const prev = body.tasks.find(t => t.id === op.id)
  if (prev === undefined && body.tasks.length >= MAX_TASKS) return fail(`タスクは ${MAX_TASKS} 件まで`)
  const deps = op.deps ?? prev?.deps ?? []
  for (const d of deps) {
    if (d === op.id) return fail('自分自身には依存できない')
    if (!body.tasks.some(t => t.id === d)) return fail(`依存先 ${d} がない`)
  }
  if (hasCycle(body.tasks, op.id, deps)) return fail('依存関係が循環する')
  const status = op.status ?? prev?.status ?? 'pending'
  if (!isStatus(status)) return fail(`status は ${STATUSES.join(' / ')} のいずれか`)
  const base: Task = prev ?? { id: op.id, title: op.id, status: 'pending', deps: [], artifacts: [], note: '', updatedAt: ctx.now }
  const task: Task = {
    ...base,
    title: op.title !== undefined ? clean(op.title, LIMITS.title) || base.title : base.title,
    note: op.note !== undefined ? clean(op.note, LIMITS.note) : base.note,
    deps,
    status,
    updatedAt: ctx.now,
  }
  if (prev !== undefined && !canTransition(prev.status, status)) {
    return fail(`${op.id}: ${prev.status} から ${status} へは変更できない`)
  }
  if (status !== base.status || prev === undefined) {
    if (status === 'running') {
      const open = deps.filter(d => body.tasks.find(t => t.id === d)?.status !== 'done')
      if (open.length > 0) return fail(`${op.id}: 依存先 ${open.join(', ')} が完了していない`)
    }
    if (status === 'done') {
      const why = completionBlocker(task, ctx.observed)
      if (why !== undefined) return fail(why)
    }
  }
  if (status !== 'needs_recheck') delete task.interruptedAt
  const tasks = prev === undefined ? [...body.tasks, task] : body.tasks.map(t => (t.id === op.id ? task : t))
  return { ok: true, body: { ...body, tasks }, message: `タスク ${op.id} を記録した (${status})` }
}

// ---- 復元と照合 ----

export type Finding = {
  taskId: string
  kind: 'interrupted' | 'artifact-missing' | 'artifact-changed' | 'verification-missing' | 'rev-changed'
  detail: string
}

/** 中断された running は完了にせず、再確認対象へ戻す */
export const restoreInterrupted = (body: Body, now: string): Body => ({
  ...body,
  tasks: body.tasks.map(t =>
    t.status === 'running' ? { ...t, status: 'needs_recheck' as const, interruptedAt: now, updatedAt: now } : t,
  ),
})

/** 保存内容を実際のファイルと版に照合する。根拠が古い done は再確認へ戻す */
export const reconcile = (body: Body, observed: Observed, rev: string | undefined, now: string): { body: Body; findings: Finding[] } => {
  const findings: Finding[] = []
  const tasks = body.tasks.map(t => {
    if (t.status === 'needs_recheck' && t.interruptedAt !== undefined) {
      findings.push({ taskId: t.id, kind: 'interrupted', detail: '中断されたため再確認が要る' })
    }
    if (t.status === 'pending') return t
    let stale = false
    for (const a of t.artifacts) {
      const now_ = observed[a.path]
      if (now_ === null || now_ === undefined) {
        findings.push({ taskId: t.id, kind: 'artifact-missing', detail: `${a.path} が見つからない` })
        stale = true
      } else if (t.verification?.sealed[a.path] !== undefined && t.verification.sealed[a.path] !== now_) {
        findings.push({ taskId: t.id, kind: 'artifact-changed', detail: `${a.path} が検証のあとに変わった` })
        stale = true
      }
    }
    if (t.status === 'done' && t.verification?.result !== 'pass') {
      findings.push({ taskId: t.id, kind: 'verification-missing', detail: '合格した検証の記録がない' })
      stale = true
    }
    if (t.verification?.rev && rev && t.verification.rev !== rev) {
      findings.push({ taskId: t.id, kind: 'rev-changed', detail: `検証時の版 ${t.verification.rev.slice(0, 7)} から ${rev.slice(0, 7)} に進んでいる` })
    }
    return stale && t.status === 'done' ? { ...t, status: 'needs_recheck' as const, updatedAt: now } : t
  })
  return { body: { ...body, tasks }, findings }
}

// ---- 表示 ----

const MARK: Record<Status, string> = {
  pending: '[ ]',
  running: '[>]',
  blocked: '[!]',
  failed: '[x]',
  needs_recheck: '[?]',
  done: '[v]',
}

export const isEmptyBody = (b: Body) => b.goal === '' && b.tasks.length === 0 && b.issues.length === 0

/** 未完了を先に並べ、上限で切る */
export const renderLedger = (body: Body, findings: readonly Finding[], limit: number) => {
  const rank = (t: Task) => (t.status === 'done' ? 1 : 0)
  const sorted = [...body.tasks].sort((a, b) => rank(a) - rank(b))
  const shown = sorted.slice(0, limit)
  const lines: string[] = []
  if (body.goal) lines.push(`ゴール: ${body.goal}`)
  for (const t of shown) {
    const deps = t.deps.length > 0 ? ` 依存: ${t.deps.join(',')}` : ''
    const files = t.artifacts.length > 0 ? ` 成果: ${t.artifacts.map(a => a.path).join(',')}` : ''
    const ver = t.verification ? ` 検証: ${t.verification.result}` : ''
    const note = t.note ? ` / ${t.note}` : ''
    lines.push(`${MARK[t.status]} ${t.id} ${t.title} (${t.status})${deps}${files}${ver}${note}`)
  }
  if (sorted.length > shown.length) lines.push(`ほか ${sorted.length - shown.length} 件のタスクは省略`)
  body.issues.forEach((x, i) => lines.push(`未解決 ${i + 1}: ${x}`))
  for (const f of findings.filter(x => x.kind !== 'rev-changed' || shown.some(t => t.id === x.taskId))) {
    lines.push(`要確認 ${f.taskId}: ${f.detail}`)
  }
  return lines.join('\n')
}

export const GUIDE = [
  'task-checkpoint: 上のゴールとタスクはローカルに保存された状態で、ファイルや検証結果と照合して復元したもの。',
  '[?] needs_recheck は中断または根拠が古いタスクで、完了とみなさず、実際のファイルとテストを確認してから進める。',
  '状態の記録と更新は mcp__task-checkpoint__checkpoint ツールで行う。done にできるのは合格した検証を記録したあとだけ。',
  '秘密値と会話の全文は記録しない。',
].join('\n')
