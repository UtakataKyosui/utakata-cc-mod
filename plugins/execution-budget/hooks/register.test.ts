import { test, expect, mock } from 'claude-code/testing'
import {
  addUsage,
  appendLog,
  decide,
  emptyUsage,
  fingerprint,
  formatStatus,
  formatUsage,
  halt,
  makeLogEntry,
  newGoal,
  parseCommand,
  pruneLog,
  readConfig,
  recordSpawn,
  resume,
  stop,
} from './policy'

const cfg = readConfig({ maxMinutes: 10, maxConcurrent: 2, maxSpawns: 3, maxRetries: 1 })
const spawn = (goal: ReturnType<typeof newGoal>, fp: string, retry: boolean, now = 0) =>
  recordSpawn(goal, { fp, retry, id: `a${goal.spawns}`, type: 'Explore', now }, cfg)

test('設定の既定値と不正値の丸め', () => {
  const d = readConfig({})
  expect([d.maxMs, d.maxConcurrent, d.maxSpawns, d.maxRetries]).toEqual([7_200_000, 4, 30, 5])
  expect(d.retentionMs).toBe(7 * 86_400_000)
  expect(d.recordDescriptions).toBe(false)
  expect(readConfig({ maxSpawns: -1, maxMinutes: 'x' }).maxSpawns).toBe(30)
  expect(readConfig({ maxSpawns: 0 }).maxSpawns).toBe(0)
})

test('各上限で新しい起動を断る', () => {
  const g0 = newGoal('s', 0)
  expect(decide(g0, cfg, 0, 0, 'x')).toEqual({ allow: true, retry: false })
  expect(decide(g0, cfg, 10 * 60_000, 0, 'x')).toEqual({ allow: false, limit: 'time', halts: true })
  expect(decide(g0, cfg, 0, 2, 'x')).toEqual({ allow: false, limit: 'concurrent', halts: false })
  const g3 = spawn(spawn(spawn(g0, 'a', false), 'b', false), 'c', false)
  expect(decide(g3, cfg, 0, 0, 'd')).toEqual({ allow: false, limit: 'spawns', halts: true })
  const g1 = spawn(g0, 'a', false)
  const retried = spawn(g1, 'a', true)
  expect(decide(g1, cfg, 0, 0, 'a')).toEqual({ allow: true, retry: true })
  expect(decide(retried, cfg, 0, 0, 'a')).toEqual({ allow: false, limit: 'retries', halts: true })
  expect(decide(retried, cfg, 0, 0, 'other')).toEqual({ allow: true, retry: false })
})

test('0 は無制限', () => {
  const free = readConfig({ maxMinutes: 0, maxConcurrent: 0, maxSpawns: 0, maxRetries: 0 })
  expect(decide(newGoal('s', 0), free, 1e12, 99, 'x').allow).toBe(true)
})

test('停止と再開: 上限到達は未達成として扱い、再開で数え直す', () => {
  const g = halt(spawn(spawn(spawn(newGoal('s', 0), 'a', false), 'b', false), 'c', false), 'spawns', 5)
  expect(decide(g, cfg, 6, 0, 'z')).toEqual({ allow: false, limit: 'spawns', halts: false })
  const text = formatStatus(g, cfg, 6, 1).join('\n')
  expect(text).toContain('ゴールは未達成')
  expect(text).toContain('止められず')
  const back = resume(g, 100)
  expect(back.status).toBe('running')
  expect(back.spawns).toBe(3)
  expect(decide(back, cfg, 101, 0, 'z').allow).toBe(true)
  const s = stop(back, 200)
  expect(decide(s, cfg, 201, 0, 'z')).toEqual({ allow: false, limit: 'stopped', halts: false })
  expect(formatStatus(s, cfg, 201, 0)[0]).toContain('手動停止中')
})

test('使用量は取得不能なら不明、金額は推計と表示する', () => {
  const none = formatUsage(emptyUsage(), undefined).join('\n')
  expect(none).toContain('トークン: 不明')
  expect(none).toContain('費用: 不明')
  const u = addUsage(emptyUsage(), { model: 'sonnet', input_tokens: 10, output_tokens: 5 })
  const some = formatUsage(u, 1.234).join('\n')
  expect(some).toContain('入力 10 / 出力 5')
  expect(some).toContain('費用: 推計 約 $1.23')
  expect(some).toContain('課金額でもない')
})

test('ログは許可したキーだけを残し、本文や秘密値を含めない', () => {
  const e = makeLogEntry(1, { kind: 'spawn', agentType: 'Explore', prompt: 'sk-secret', text: 'x', model: 'has space', input: 3 })
  expect(e).toEqual({ at: 1, kind: 'spawn', agentType: 'Explore', input: 3 })
  expect(makeLogEntry(1, {}, 'desc')).toEqual({ at: 1, description: 'desc' })
  expect(fingerprint('a', 'b', 'c')).not.toContain('c ')
})

test('保持期間を過ぎたログを削除する', () => {
  const day = 86_400_000
  const log = [{ at: 0, kind: 'old' }, { at: 5 * day, kind: 'new' }]
  expect(pruneLog(log, 8 * day, 7 * day).map(e => e.kind)).toEqual(['new'])
  expect(appendLog(log, { at: 8 * day, kind: 'x' }, 8 * day, 7 * day).map(e => e.kind)).toEqual(['new', 'x'])
  expect(appendLog(log, { at: 8 * day, kind: 'x' }, 8 * day, 0)).toEqual([])
})

test('コマンドの解釈', () => {
  expect(parseCommand('')).toBe('status')
  expect(parseCommand(' resume now')).toBe('resume')
  expect(parseCommand('zzz')).toBe('help')
})

const setup = ($: any, on: any, agents: { status: string }[], store: Record<string, unknown> = {}) => {
  mock.clock(on)
  mock.store(on, store)
  on('session.id', () => ({ value: 'sess' }))
  on('agent.list', () => ({ value: agents }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1, percent: 0 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `a${++n}` }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

const budget = async ($: any, args = '') => (await $.command.run({ command: 'budget', args })).text as string

const spawnCall = ($: any, description = 'd', prompt = 'SECRET-PROMPT') =>
  $.agent.spawn({ prompt, description, subagentType: 'Explore' })

test('起動総数の上限で拒否し、本文を保存しない', { options: { maxSpawns: 2, maxRetries: 0 } }, async ($, on) => {
  setup($, on, [])
  expect((await spawnCall($, 'one')).agentId).toBe('a1')
  expect((await spawnCall($, 'two')).agentId).toBe('a2')
  const denied = await spawnCall($, 'three')
  expect(denied.deny).toContain('ゴールの達成ではなく')
  const status = await budget($)
  expect(status).toContain('起動総数の上限に到達して停止中')
  expect(status).toContain('断った起動 1 件')
  const dump = status + (await budget($, 'log'))
  expect(dump).not.toContain('SECRET-PROMPT')
  expect(dump).not.toContain('three')
})

test('同時実行数の上限では起動だけ断り、ゴールは止めない', { options: { maxConcurrent: 1 } }, async ($, on) => {
  setup($, on, [{ status: 'running' }])
  const denied = await spawnCall($)
  expect(denied.deny).toContain('同時実行数')
  expect(await budget($)).toContain('実行中')
})

test('再試行の上限で拒否する', { options: { maxRetries: 1 } }, async ($, on) => {
  setup($, on, [])
  await spawnCall($, 'same')
  expect((await spawnCall($, 'same')).agentId).toBe('a2')
  expect((await spawnCall($, 'same')).deny).toContain('再試行回数')
})

test('/budget で停止と再開ができる', async ($, on) => {
  setup($, on, [])
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await $.command.run({ command: 'budget', args: 'stop' })
  expect((await spawnCall($)).deny).toContain('手動停止')
  const r = await $.command.run({ command: 'budget', args: 'resume' })
  expect(r.text).toContain('実行中')
  expect((await spawnCall($)).agentId).toBeDefined()
  expect(await budget($)).toContain('トークン: 不明')
})

test('ターンの使用量を集計する', async ($, on) => {
  setup($, on, [])
  await $.turn.complete({
    answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer',
    usage: { model: 'sonnet', input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(await budget($)).toContain('入力 7 / 出力 3')
})
