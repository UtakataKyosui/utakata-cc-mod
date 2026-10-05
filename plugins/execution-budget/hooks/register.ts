import type { Register } from 'claude-code'
import {
  type Config,
  type Goal,
  type LogEntry,
  addUsage,
  appendLog,
  countActive,
  decide,
  denyMessage,
  fingerprint,
  formatLog,
  formatStatus,
  formatUsage,
  halt,
  makeLogEntry,
  newGoal,
  parseCommand,
  pruneLog,
  readConfig,
  recordDenied,
  recordEnd,
  recordSpawn,
  resume,
  statusBar,
  stop,
} from './policy'

const GOAL_KEY = 'goal'
const LOG_KEY = 'log'

const HELP = '使い方: /budget [status|stop|resume|reset|log]'

async function load($: any): Promise<Goal> {
  const sessionId: string = await $.session.id()
  const saved = (await $.store.get(GOAL_KEY)) as Goal | undefined
  if (saved !== undefined && saved.sessionId === sessionId) return saved
  // 別セッションのゴールは引き継がず、直前のものだけ参照用に残す
  if (saved !== undefined) await $.store.set('previous', saved)
  const goal = newGoal(sessionId, await $.clock.now())
  await $.store.set(GOAL_KEY, goal)
  return goal
}

async function save($: any, cfg: Config, goal: Goal) {
  await $.store.set(GOAL_KEY, goal)
  $.ui.status(statusBar(goal, cfg))
}

async function log($: any, cfg: Config, fields: Record<string, unknown>, description?: string) {
  if (cfg.retentionMs === 0) return
  const now: number = await $.clock.now()
  const entry = makeLogEntry(now, fields, cfg.recordDescriptions ? description : undefined)
  const prev = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  await $.store.set(LOG_KEY, appendLog(prev, entry, now, cfg.retentionMs))
}

async function active($: any) {
  return countActive(await $.agent.list())
}

async function cost($: any): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const cfg: Config = readConfig(options)
  let chain: Promise<unknown> = Promise.resolve()
  let reserving = 0

  // 保存値の読み書きを直列化して、並行する起動で更新が失われないようにする
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  on('session.start', async ($, e, next) => {
    await locked(async () => {
      const goal = await load($)
      await save($, cfg, goal)
      const now = await $.clock.now()
      const prev = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
      await $.store.set(LOG_KEY, pruneLog(prev, now, cfg.retentionMs))
    })
    await $.command.register({ name: 'budget', description: 'SubAgent の実行予算の状況表示・停止・再開 (status|stop|resume|reset|log)' })
    return next(e)
  })

  on('command.run', { command: 'budget' }, ($, e) =>
    locked(async () => {
      const now: number = await $.clock.now()
      let goal = await load($)
      const cmd = parseCommand(e.args)
      if (cmd === 'help') return { text: HELP }
      if (cmd === 'log') {
        const lines = formatLog(((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? [])
        return { text: lines.length === 0 ? '診断ログはない' : lines.join('\n') }
      }
      if (cmd === 'stop') goal = stop(goal, now)
      if (cmd === 'resume') goal = resume(goal, now)
      if (cmd === 'reset') {
        await $.store.set('previous', goal)
        goal = newGoal(goal.sessionId, now)
      }
      if (cmd !== 'status') {
        await save($, cfg, goal)
        await log($, cfg, { kind: cmd, goal: goal.id })
      }
      const lines = [...formatStatus(goal, cfg, now, await active($)), ...formatUsage(goal.usage, await cost($))]
      return { text: lines.join('\n') }
    }),
  )

  on('agent.spawn', async ($, e, next) => {
    const fp = fingerprint(e.subagentType, e.description, e.prompt)
    const verdict = await locked(async () => {
      const now: number = await $.clock.now()
      let goal = await load($)
      const act = await active($)
      const d = decide(goal, cfg, now, act + reserving, fp)
      if (d.allow) {
        reserving++
        return { d, act }
      }
      if (d.halts) {
        goal = halt(goal, d.limit as 'time', now)
        $.ui.toast(`execution-budget: ${d.limit} の上限に達したため新しい起動を止めた`)
      }
      goal = recordDenied(goal, { at: now, type: e.subagentType, limit: d.limit, description: e.description }, cfg)
      await save($, cfg, goal)
      await log($, cfg, { kind: 'deny', limit: d.limit, agentType: e.subagentType, goal: goal.id }, e.description)
      return { d, act }
    })
    if (!verdict.d.allow) return { deny: denyMessage(verdict.d.limit, await locked(() => load($)), verdict.act) }

    let started
    try {
      started = await next(e)
    } finally {
      reserving--
    }
    if ('deny' in started || started.agentId === undefined) return started
    const { agentId, model } = started
    await locked(async () => {
      const now: number = await $.clock.now()
      const goal = recordSpawn(
        await load($),
        { fp, retry: verdict.d.allow && verdict.d.retry, id: agentId, type: e.subagentType, model, now, description: e.description },
        cfg,
      )
      await save($, cfg, goal)
      await log($, cfg, { kind: 'spawn', agentId, agentType: e.subagentType, model, requestedModel: e.model, retry: verdict.d.allow && verdict.d.retry, goal: goal.id }, e.description)
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.usage === undefined && e.agentId === undefined) return r
    await locked(async () => {
      let goal = await load($)
      if (e.usage !== undefined) {
        goal = { ...goal, usage: addUsage(goal.usage, e.usage) }
        await log($, cfg, { kind: 'usage', agentId: e.agentId, model: e.usage.model, input: e.usage.input_tokens, output: e.usage.output_tokens })
      }
      if (e.agentId !== undefined) {
        goal = recordEnd(goal, e.agentId, e.reason)
        await log($, cfg, { kind: 'turn', agentId: e.agentId, reason: e.reason })
      }
      await save($, cfg, goal)
    })
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && r.skip === undefined) {
      await locked(() => log($, cfg, { kind: 'compact', trigger: e.trigger, agentId: e.agentId, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter }))
    }
    return r
  })
}
