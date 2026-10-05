export type Config = {
  maxMs: number
  maxConcurrent: number
  maxSpawns: number
  maxRetries: number
  retentionMs: number
  recordDescriptions: boolean
}

export type Limit = 'time' | 'concurrent' | 'spawns' | 'retries'
export type GoalStatus = 'running' | 'limit' | 'stopped'

export type AgentRec = { id: string; type: string; model?: string; startedAt: number; result?: string; description?: string }
export type DeniedRec = { at: number; type: string; limit: Limit | 'stopped'; description?: string }

export type Usage = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  byModel: Record<string, { input: number; output: number }>
}

export type Goal = {
  id: string
  sessionId: string
  startedAt: number
  status: GoalStatus
  haltReason?: Limit
  haltedAt?: number
  // 再開時の基準点。上限は基準点からの増分で判定する
  base: { at: number; spawns: number; retries: number }
  spawns: number
  retries: number
  seen: Record<string, number>
  agents: AgentRec[]
  denied: DeniedRec[]
  usage: Usage
}

const DAY_MS = 86_400_000
const KEEP_AGENTS = 50
const KEEP_DENIED = 50
const KEEP_SEEN = 200
export const MAX_LOG_ENTRIES = 500

export const readConfig = (options: Readonly<Record<string, unknown>>): Config => {
  const num = (key: string, fallback: number, max: number) => {
    const v = Number(options[key])
    return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback
  }
  return {
    maxMs: num('maxMinutes', 120, 1440) * 60_000,
    maxConcurrent: num('maxConcurrent', 4, 50),
    maxSpawns: num('maxSpawns', 30, 500),
    maxRetries: num('maxRetries', 5, 100),
    retentionMs: num('retentionDays', 7, 365) * DAY_MS,
    recordDescriptions: options.recordDescriptions === true,
  }
}

export const emptyUsage = (): Usage => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} })

export const newGoal = (sessionId: string, now: number): Goal => ({
  id: `g-${now.toString(36)}`,
  sessionId,
  startedAt: now,
  status: 'running',
  base: { at: now, spawns: 0, retries: 0 },
  spawns: 0,
  retries: 0,
  seen: {},
  agents: [],
  denied: [],
  usage: emptyUsage(),
})

// 同じ種類・説明・本文の起動を再試行とみなすための指紋。本文そのものは保存しない
export const fingerprint = (type: string, description: string, prompt: string) => {
  let h = 5381
  for (const ch of `${type}\n${description}\n${prompt}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0
  return h.toString(36)
}

export type Decision = { allow: true; retry: boolean } | { allow: false; limit: Limit | 'stopped'; halts: boolean }

export const decide = (goal: Goal, cfg: Config, now: number, active: number, fp: string): Decision => {
  if (goal.status === 'stopped') return { allow: false, limit: 'stopped', halts: false }
  if (goal.status === 'limit') return { allow: false, limit: goal.haltReason ?? 'stopped', halts: false }
  const retry = (goal.seen[fp] ?? 0) > 0
  if (cfg.maxMs > 0 && now - goal.base.at >= cfg.maxMs) return { allow: false, limit: 'time', halts: true }
  if (cfg.maxSpawns > 0 && goal.spawns - goal.base.spawns >= cfg.maxSpawns) return { allow: false, limit: 'spawns', halts: true }
  if (retry && cfg.maxRetries > 0 && goal.retries - goal.base.retries >= cfg.maxRetries) {
    return { allow: false, limit: 'retries', halts: true }
  }
  // 同時実行数は一時的な混雑なので、ゴールは止めずこの起動だけ断る
  if (cfg.maxConcurrent > 0 && active >= cfg.maxConcurrent) return { allow: false, limit: 'concurrent', halts: false }
  return { allow: true, retry }
}

export const halt = (goal: Goal, limit: Limit, now: number): Goal => ({ ...goal, status: 'limit', haltReason: limit, haltedAt: now })

export const stop = (goal: Goal, now: number): Goal => ({ ...goal, status: 'stopped', haltReason: undefined, haltedAt: now })

// 再開は、その時点を新しい基準点にして上限を数え直す。履歴と使用量は残る
export const resume = (goal: Goal, now: number): Goal => ({
  ...goal,
  status: 'running',
  haltReason: undefined,
  haltedAt: undefined,
  base: { at: now, spawns: goal.spawns, retries: goal.retries },
})

const cap = <T>(list: readonly T[], n: number) => list.slice(-n)

const clip = (text: string | undefined, enabled: boolean) => (enabled && text ? text.slice(0, 80) : undefined)

export type SpawnInfo = {
  fp: string
  retry: boolean
  id: string
  type: string
  model?: string
  now: number
  description?: string
}

export const recordSpawn = (goal: Goal, s: SpawnInfo, cfg: Config): Goal => {
  const seen = { ...goal.seen, [s.fp]: (goal.seen[s.fp] ?? 0) + 1 }
  const keys = Object.keys(seen)
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_SEEN))) delete seen[k]
  return {
    ...goal,
    spawns: goal.spawns + 1,
    retries: goal.retries + (s.retry ? 1 : 0),
    seen,
    agents: cap([...goal.agents, { id: s.id, type: s.type, model: s.model, startedAt: s.now, description: clip(s.description, cfg.recordDescriptions) }], KEEP_AGENTS),
  }
}

export const recordDenied = (goal: Goal, d: DeniedRec, cfg: Config): Goal => ({
  ...goal,
  denied: cap([...goal.denied, { ...d, description: clip(d.description, cfg.recordDescriptions) }], KEEP_DENIED),
})

export const recordEnd = (goal: Goal, agentId: string, result: string): Goal => ({
  ...goal,
  agents: goal.agents.map(a => (a.id === agentId ? { ...a, result } : a)),
})

export type TurnUsageLike = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export const addUsage = (u: Usage, t: TurnUsageLike): Usage => {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const model = t.model ?? 'unknown'
  const prev = u.byModel[model] ?? { input: 0, output: 0 }
  return {
    turns: u.turns + 1,
    input: u.input + n(t.input_tokens),
    output: u.output + n(t.output_tokens),
    cacheRead: u.cacheRead + n(t.cache_read_input_tokens),
    cacheWrite: u.cacheWrite + n(t.cache_creation_input_tokens),
    byModel: { ...u.byModel, [model]: { input: prev.input + n(t.input_tokens), output: prev.output + n(t.output_tokens) } },
  }
}

// 取得できなかった値は「不明」、ホストの集計に基づく金額は「推計」と書く
export const formatUsage = (u: Usage, costUsd: number | undefined): string[] => {
  const lines: string[] = []
  if (u.turns === 0) {
    lines.push('トークン: 不明 (使用量を取得できたターンがない)')
  } else {
    lines.push(
      `トークン: 入力 ${u.input} / 出力 ${u.output} / キャッシュ読込 ${u.cacheRead} / キャッシュ書込 ${u.cacheWrite} (${u.turns} ターン分。取得できたターンのみ)`,
    )
    for (const [model, v] of Object.entries(u.byModel)) lines.push(`  ${model}: 入力 ${v.input} / 出力 ${v.output}`)
  }
  lines.push(
    costUsd === undefined
      ? '費用: 不明 (ホストが費用を集計していない)'
      : `費用: 推計 約 $${costUsd.toFixed(2)} (セッション全体のホスト集計。このゴール単独の値でも、精密な課金額でもない)`,
  )
  return lines
}

export const limitLabel = (limit: Limit | 'stopped'): string =>
  ({
    time: '経過時間の上限',
    spawns: '起動総数の上限',
    retries: '再試行回数の上限',
    concurrent: '同時実行数の上限',
    stopped: '手動停止',
  })[limit]

const minutes = (ms: number) => Math.floor(ms / 60_000)

const cfgLine = (label: string, used: number, max: number, unit = '') => `${label}: ${used}${unit} / ${max === 0 ? '無制限' : `${max}${unit}`}`

export const formatStatus = (goal: Goal, cfg: Config, now: number, active: number): string[] => {
  const state =
    goal.status === 'running'
      ? '実行中'
      : goal.status === 'stopped'
        ? '手動停止中 (ゴールは未達成。/budget resume で再開)'
        : `${limitLabel(goal.haltReason ?? 'stopped')}に到達して停止中 (ゴールは未達成。/budget resume で再開)`
  const lines = [
    `ゴール ${goal.id}: ${state}`,
    cfgLine('経過時間', minutes(now - goal.base.at), cfg.maxMs / 60_000, '分'),
    cfgLine('起動数', goal.spawns - goal.base.spawns, cfg.maxSpawns),
    cfgLine('再試行', goal.retries - goal.base.retries, cfg.maxRetries),
    cfgLine('同時実行', active, cfg.maxConcurrent),
    `累計: 起動 ${goal.spawns} 回 / 再試行 ${goal.retries} 回`,
  ]
  if (goal.status !== 'running' && active > 0) {
    lines.push(`実行中の ${active} 件の SubAgent はこのプラグインでは止められず、そのまま動き続ける。止めるなら TaskStop を使う`)
  }
  if (goal.denied.length > 0) {
    lines.push(`残作業: 断った起動 ${goal.denied.length} 件`)
    for (const d of goal.denied.slice(-10)) {
      lines.push(`  - ${d.type}${d.description ? ` (${d.description})` : ''} [${limitLabel(d.limit)}]`)
    }
  }
  const unfinished = goal.agents.filter(a => a.result === undefined).length
  if (goal.agents.length > 0) lines.push(`進捗: 起動済み ${goal.agents.length} 件のうち結果の記録なし ${unfinished} 件`)
  return lines
}

export const denyMessage = (limit: Limit | 'stopped', goal: Goal, active: number): string => {
  if (limit === 'concurrent') {
    return `execution-budget: 同時実行数の上限に達しているため、この起動は断った。実行中の SubAgent が終わってから再度起動すること。ゴールは継続中`
  }
  const running = active > 0 ? `実行中の ${active} 件は止まらない。` : ''
  return `execution-budget: ${limitLabel(limit)}により新しい SubAgent の起動と再試行を止めた。これはゴールの達成ではなく、予算切れによる中断である。${running}進捗と残作業は保存済み (/budget status)。利用者が /budget resume を実行するまで起動しないこと。成果が未完なら、完了とは報告せず、残作業を利用者に伝えること`
}

export type LogEntry = Record<string, string | number | boolean>

const SAFE = /^[\w.:@/-]{1,64}$/
const NUM_KEYS = new Set(['tokensBefore', 'tokensAfter', 'input', 'output', 'cacheRead', 'cacheWrite', 'elapsedMs'])
const STR_KEYS = new Set(['kind', 'agentType', 'model', 'requestedModel', 'limit', 'reason', 'trigger', 'agentId', 'goal'])

// 許可したキーだけを残す。本文や任意の文字列は入らない
export const makeLogEntry = (at: number, fields: Record<string, unknown>, description?: string): LogEntry => {
  const e: LogEntry = { at }
  for (const [k, v] of Object.entries(fields)) {
    if (STR_KEYS.has(k) && typeof v === 'string' && SAFE.test(v)) e[k] = v
    else if (NUM_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) e[k] = v
    else if (k === 'retry' && typeof v === 'boolean') e[k] = v
  }
  if (description) e.description = description.slice(0, 80)
  return e
}

export const pruneLog = (log: readonly LogEntry[], now: number, retentionMs: number): LogEntry[] =>
  retentionMs === 0 ? [] : log.filter(e => typeof e.at === 'number' && now - e.at <= retentionMs).slice(-MAX_LOG_ENTRIES)

export const appendLog = (log: readonly LogEntry[], entry: LogEntry, now: number, retentionMs: number): LogEntry[] =>
  retentionMs === 0 ? [] : pruneLog([...log, entry], now, retentionMs)

export const formatLog = (log: readonly LogEntry[], limit = 30): string[] =>
  log.slice(-limit).map(e => {
    const { at, ...rest } = e
    return `${new Date(Number(at)).toISOString()} ${Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' ')}`
  })

export type ParsedCommand = 'status' | 'stop' | 'resume' | 'reset' | 'log' | 'help'

export const parseCommand = (args: string): ParsedCommand => {
  const w = args.trim().split(/\s+/)[0] ?? ''
  if (w === '' || w === 'status') return 'status'
  return w === 'stop' || w === 'resume' || w === 'reset' || w === 'log' ? w : 'help'
}

export const statusBar = (goal: Goal, cfg: Config): string => {
  const mark = goal.status === 'running' ? '' : goal.status === 'limit' ? ' 停止(上限)' : ' 停止'
  return `予算 起動 ${goal.spawns - goal.base.spawns}/${cfg.maxSpawns === 0 ? '∞' : cfg.maxSpawns}${mark}`
}

const ACTIVE = new Set(['pending', 'running', 'waiting'])

export const countActive = (agents: readonly { status: string }[]) => agents.filter(a => ACTIVE.has(a.status)).length
