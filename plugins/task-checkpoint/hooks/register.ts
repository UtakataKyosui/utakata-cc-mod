import type { Register } from 'claude-code'
import {
  type Body,
  type Chosen,
  type Config,
  type Finding,
  type Observed,
  type Op,
  GUIDE,
  SLOTS,
  applyOp,
  choose,
  describeIssues,
  emptyBody,
  encode,
  fingerprint,
  isEmptyBody,
  nextSlot,
  pathsOf,
  readConfig,
  reconcile,
  renderLedger,
  resolveDir,
  restoreInterrupted,
} from './policy'

const TOOL = 'checkpoint'
const TOOL_FULL = `mcp__task-checkpoint__${TOOL}`

const TOOL_DESCRIPTION = [
  'ゴール・タスク・依存関係・状態・成果物・検証結果・未解決事項をローカルに保存する。',
  'Compaction や再開のあとはこの内容がシステムプロンプトに載る。秘密値や会話の全文は渡さない。',
  'op: goal / task / artifact / verify / issue / resolve_issue / show / reconcile。',
  'task は id, title, deps, status, note。running にできるのは依存先がすべて done のとき、done にできるのは verify で pass を記録して成果物が変わっていないときだけ。',
].join('')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['goal', 'task', 'artifact', 'verify', 'issue', 'resolve_issue', 'show', 'reconcile'] },
    goal: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    deps: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['pending', 'running', 'blocked', 'failed', 'needs_recheck', 'done'] },
    note: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' }, description: 'プロジェクトルートからの相対パス' },
    command: { type: 'string', description: '実行した検証コマンド' },
    result: { type: 'string', enum: ['pass', 'fail'] },
    text: { type: 'string' },
    index: { type: 'number' },
  },
  required: ['op'],
}

type Loaded = { chosen: Chosen; body: Body; findings: Finding[] }
type Runtime = { cfg: Config; cache: Loaded | undefined; queue: Promise<unknown> }

// 操作を直列にして、読み書きの競合で保存内容を壊さない
const serial = <T>(rt: Runtime, fn: () => Promise<T>): Promise<T> => {
  const run = rt.queue.then(fn, fn)
  rt.queue = run.catch(() => undefined)
  return run
}

const dirOf = async ($: any, rt: Runtime) => resolveDir(await $.session.root(), rt.cfg.saveDir)
const nowIso = async ($: any) => new Date(await $.clock.now()).toISOString()

async function observe($: any, paths: readonly string[]): Promise<Observed> {
  const root = await $.session.root()
  const out: Observed = {}
  for (const p of paths) out[p] = fingerprint(await $.fs.stat(`${root}/${p}`).catch(() => undefined))
  return out
}

async function revision($: any): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'rev-parse', 'HEAD'])
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

async function read($: any, rt: Runtime): Promise<Chosen> {
  const dir = await dirOf($, rt)
  const candidates = []
  for (const slot of SLOTS) {
    candidates.push({ slot, text: (await $.fs.read(`${dir}/${slot}`).catch(() => undefined)) as string | undefined })
  }
  const chosen = choose(candidates)
  // 壊れた面は上書きされる前に退避する
  for (const issue of chosen.issues) {
    const copy = `${dir}/corrupt-${issue.slot}`
    if (!(await $.fs.exists(copy))) {
      const text = candidates.find(c => c.slot === issue.slot)?.text ?? ''
      await $.fs.write(copy, text.slice(0, 65536)).catch(() => undefined)
    }
  }
  return chosen
}

async function write($: any, rt: Runtime, chosen: Chosen, body: Body): Promise<Chosen> {
  if (!chosen.writable) throw new Error('新しいスキーマ版の保存データがあるため書き込まない')
  const dir = await dirOf($, rt)
  if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
  const seq = chosen.seq + 1
  const slot = nextSlot(chosen.slot)
  await $.fs.write(`${dir}/${slot}`, encode(body, seq, await nowIso($)))
  const back = choose([{ slot, text: await $.fs.read(`${dir}/${slot}`).catch(() => undefined) }])
  if (back.body === undefined || back.seq !== seq) throw new Error(`${slot} の書き込みを読み戻して確認できなかった`)
  return { ...chosen, body, seq, slot, issues: chosen.issues.filter(i => i.slot !== slot) }
}

// 保存内容を読み、中断を再確認へ戻し、実ファイルと照合して、変化があれば保存する
function recover($: any, rt: Runtime): Promise<Loaded> {
  return serial(rt, async () => {
    let chosen = await read($, rt)
    const restored = restoreInterrupted(chosen.body ?? emptyBody(), await nowIso($))
    const observed = await observe($, pathsOf(restored, { op: 'reset' }))
    const rec = reconcile(restored, observed, await revision($), await nowIso($))
    if (chosen.body !== undefined && chosen.writable && JSON.stringify(rec.body) !== JSON.stringify(chosen.body)) {
      chosen = await write($, rt, chosen, rec.body)
    }
    rt.cache = { chosen, body: rec.body, findings: rec.findings }
    return rt.cache
  })
}

const loaded = ($: any, rt: Runtime) => (rt.cache ? Promise.resolve(rt.cache) : recover($, rt))

function commit($: any, rt: Runtime, op: Op): Promise<string> {
  return serial(rt, async () => {
    let cur = rt.cache
    if (cur === undefined) {
      const chosen = await read($, rt)
      cur = { chosen, body: chosen.body ?? emptyBody(), findings: [] }
    }
    const observed = await observe($, pathsOf(cur.body, op))
    const applied = applyOp(cur.body, op, { now: await nowIso($), observed, rev: await revision($) })
    if (!applied.ok) return applied.error
    const chosen = await write($, rt, cur.chosen, applied.body)
    rt.cache = { chosen, body: applied.body, findings: cur.findings }
    return applied.message
  })
}

const diagnosis = (l: Loaded) => describeIssues(l.chosen.issues, l.chosen.writable)

function show(l: Loaded): string {
  const parts = [isEmptyBody(l.body) ? '保存された状態はない' : renderLedger(l.body, l.findings, 100)]
  const d = diagnosis(l)
  if (d.length > 0) parts.push(`診断:\n${d.join('\n')}`)
  return parts.join('\n')
}

async function safely(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    return `task-checkpoint: 失敗した (${String(err)})`
  }
}

async function runTool($: any, rt: Runtime, input: Record<string, any>): Promise<string> {
  switch (input.op) {
    case 'show':
      return show(await loaded($, rt))
    case 'reconcile':
      return show(await recover($, rt))
    case 'goal':
      return commit($, rt, { op: 'goal', goal: String(input.goal ?? '') })
    case 'task':
      return commit($, rt, { op: 'task', id: String(input.id ?? ''), title: input.title, deps: input.deps, status: input.status, note: input.note })
    case 'artifact':
      return commit($, rt, { op: 'artifact', id: String(input.id ?? ''), paths: Array.isArray(input.paths) ? input.paths.map(String) : [] })
    case 'verify':
      return commit($, rt, { op: 'verify', id: String(input.id ?? ''), command: String(input.command ?? ''), result: input.result })
    case 'issue':
      return commit($, rt, { op: 'issue', text: String(input.text ?? '') })
    case 'resolve_issue':
      return commit($, rt, { op: 'resolve_issue', index: Number(input.index) })
    default:
      return 'op は goal / task / artifact / verify / issue / resolve_issue / show / reconcile のいずれか'
  }
}

async function runCommand($: any, rt: Runtime, args: string): Promise<string> {
  const [sub = 'show', ...rest] = args.trim().split(/\s+/)
  switch (sub) {
    case 'show':
    case '':
      return show(await loaded($, rt))
    case 'reconcile':
      return show(await recover($, rt))
    case 'diagnose': {
      const l = await loaded($, rt)
      const d = diagnosis(l)
      return d.length > 0 ? d.join('\n') : `保存データに問題はない (保存先 ${rt.cfg.saveDir}, 世代 ${l.chosen.seq})`
    }
    case 'goal':
      return commit($, rt, { op: 'goal', goal: rest.join(' ') })
    case 'reset':
      return commit($, rt, { op: 'reset' })
    default:
      return '使い方: /checkpoint [show|reconcile|diagnose|goal <文>|reset]'
  }
}

export const register: Register = (on, options) => {
  const rt: Runtime = { cfg: readConfig(options), cache: undefined, queue: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA })
      await $.command.register({ name: 'checkpoint', description: 'ゴールとタスクの保存状態を表示・照合する', argumentHint: '[show|reconcile|diagnose|goal <文>|reset]' })
      const l = await recover($, rt)
      const attention = l.findings.filter(f => f.kind !== 'rev-changed').length + diagnosis(l).length
      if (attention > 0) $.ui.toast(`task-checkpoint: 要確認が ${attention} 件ある。/checkpoint で確認できる`)
    } catch (err) {
      $.ui.log(`task-checkpoint: could not restore (${String(err)})`, { to: 'debug' })
    }
    return next(e)
  })

  // Compaction のあとも、毎回のプロンプト構成で保存状態が載る
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      const l = await loaded($, rt)
      const d = diagnosis(l)
      if (isEmptyBody(l.body) && d.length === 0) return r
      const ledger = isEmptyBody(l.body) ? '' : renderLedger(l.body, l.findings, rt.cfg.maxPromptTasks)
      const text = [GUIDE, ledger, d.length > 0 ? `保存データの診断:\n${d.join('\n')}` : ''].filter(Boolean).join('\n\n')
      return { sections: [...r.sections, { id: 'task-checkpoint:ledger', text, scope: 'session' as const }] }
    } catch {
      return r
    }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && r.skip === undefined) {
      await recover($, rt).catch(() => undefined)
    }
    return r
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const result = await safely(() => runTool($, rt, e as unknown as Record<string, any>))
    return { result }
  })

  on('command.run', { command: 'checkpoint' }, async ($, e) => ({ text: await safely(() => runCommand($, rt, e.args)) }))

  // goal-orchestrator とは疎結合に連携する。/goal の文を拾ってゴールとして記録するだけ
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const ran = await next(e)
    const goal = e.args.trim()
    if (goal !== '' && goal !== 'clear') await commit($, rt, { op: 'goal', goal }).catch(() => undefined)
    return ran
  })
}
