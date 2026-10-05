import { test, expect, mock } from 'claude-code/testing'
import { fnv1a, formatReport, parseConditions, readConfig, verdictOf, type Entry, type Run } from './policy'

const RUN = 'mcp__verification-gate__verify_run'
const DEFINE = 'mcp__verification-gate__verify_define'
const STATUS = 'mcp__verification-gate__verify_status'

const run = (over: Partial<Run>): Run => ({ outcome: 'passed', exitCode: 0, at: 't', durationMs: 1, fingerprint: 'a', ...over })
const entry = (last?: Run, baseline?: Run): Entry => ({ condition: { id: 'c', description: 'd', command: ['x'], timeoutMs: 1000 }, last, baseline })

test('判定: 成功・失敗・未実行・タイムアウト・再変更', () => {
  expect(verdictOf(entry(), 'a')).toBe('unrun')
  expect(verdictOf(entry(run({})), 'a')).toBe('passed')
  expect(verdictOf(entry(run({})), 'b')).toBe('stale')
  expect(verdictOf(entry(run({ fingerprint: null })), 'a')).toBe('unknown-state')
  expect(verdictOf(entry(run({})), null)).toBe('unknown-state')
  expect(verdictOf(entry(run({ outcome: 'failed', exitCode: 1 })), 'a')).toBe('failed')
  expect(verdictOf(entry(run({ outcome: 'timeout', exitCode: null })), 'a')).toBe('timeout')
  expect(verdictOf(entry(run({ outcome: 'error', exitCode: null })), 'a')).toBe('unverifiable')
})

test('判定: 既存の失敗と今回の変更による失敗を区別する', () => {
  const failed = run({ outcome: 'failed', exitCode: 1 })
  expect(verdictOf(entry(failed, run({ outcome: 'failed', exitCode: 1 })), 'a')).toBe('preexisting')
  expect(verdictOf(entry(failed, run({ outcome: 'failed', exitCode: 2 })), 'a')).toBe('failed')
  expect(verdictOf(entry(failed, run({})), 'a')).toBe('regression')
})

test('条件の検証と設定の丸め', () => {
  expect(parseConditions([], 1000).error).toBeDefined()
  expect(parseConditions([{ id: 'a b', command: ['x'] }], 1000).error).toContain('id')
  expect(parseConditions([{ id: 'a', command: 'npm test' }], 1000).error).toContain('argv')
  expect(parseConditions([{ id: 'a', command: ['x'] }, { id: 'a', command: ['y'] }], 1000).error).toContain('重複')
  expect(parseConditions([{ id: 'a', command: ['x'], timeout_sec: 5 }], 1000).conditions[0]!.timeoutMs).toBe(5000)
  expect(parseConditions([{ id: 'a', command: ['x'] }], 1000).conditions[0]!.timeoutMs).toBe(1000)
  expect(readConfig(undefined).defaultTimeoutMs).toBe(300_000)
  expect(readConfig({ defaultTimeoutSec: 99999 }).defaultTimeoutMs).toBe(600_000)
  expect(fnv1a('a')).not.toBe(fnv1a('b'))
  expect(formatReport([])).toContain('登録されていない')
})

type Script = (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | 'hang'

const setup = (on: any, script: Script) => {
  const state = { tree: 'clean', toasts: [] as string[], clock: undefined as any }
  const kv = new Map<string, unknown>()
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/proj' }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: kv.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    kv.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('process.run', async ($: any, e: { argv: readonly string[] }) => {
    if (e.argv[0] === 'git') {
      const sub = e.argv[1]
      const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
      if (sub === 'rev-parse') return out(e.argv[2] === 'HEAD' ? 'abc' : 'true')
      if (sub === 'status') return out(state.tree)
      return out('')
    }
    const r = script(e.argv)
    if (r === 'hang') await new Promise(() => {})
    return { value: { exitCode: r === 'hang' ? 1 : r.exitCode, stdout: r === 'hang' ? '' : (r.stdout ?? ''), stderr: r === 'hang' ? '' : (r.stderr ?? '') } }
  })
  state.clock = clock
  on('ui.toast', (_$: unknown, e: { text?: string; message?: string }) => {
    state.toasts.push(e.text ?? e.message ?? '')
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  return state
}

const call = ($: any, tool: string, input: object = {}) => $.tool.call({ tool, ...input })
const define = ($: any, timeout_sec = 10) =>
  call($, DEFINE, { conditions: [{ id: 'unit', description: '単体テストが通る', command: ['npm', 'test'], timeout_sec }] })

test('成功: 実行後は成功と判定され、変更状態が記録される', async ($: any, on: any) => {
  setup(on, () => ({ exitCode: 0, stdout: 'ok' }))
  await define($)
  expect((await call($, STATUS)).result).toContain('未実行')
  const r = await call($, RUN)
  expect(r.result).toContain('成功')
  expect(r.result).toContain('exit 0')
  expect(r.result).toContain('全条件が、現在の変更状態で成功')
})

test('失敗: 終了コードと出力の末尾を示し、成功扱いにしない', async ($: any, on: any) => {
  setup(on, () => ({ exitCode: 3, stderr: 'boom at line 1' }))
  await define($)
  const r = await call($, RUN)
  expect(r.result).toContain('失敗')
  expect(r.result).toContain('exit 3')
  expect(r.result).toContain('boom at line 1')
  expect(r.result).toContain('完了と報告せず')
})

test('タイムアウト: 時間内に終わらないコマンドは理由付きで未検証として記録する', async ($: any, on: any) => {
  const s = setup(on, () => 'hang')
  await define($, 7)
  const pending = call($, RUN)
  await s.clock.advance(7000 + 2000)
  const r = (await pending).result
  expect(r).toContain('タイムアウト')
  expect(r).toContain('7 秒以内に終わらなかった')
  expect(r).toContain('完了と報告せず')
  expect((await call($, STATUS)).result).toContain('未検証')
})

test('再変更: 成功後にファイルが変わると未検証に戻り、再実行で成功に戻る', async ($: any, on: any) => {
  const s = setup(on, () => ({ exitCode: 0 }))
  await define($)
  await call($, RUN)
  expect((await call($, STATUS)).result).toContain('全条件が、現在の変更状態で成功')
  s.tree = ' M src/a.ts'
  const stale = (await call($, STATUS)).result
  expect(stale).toContain('再変更あり')
  expect(stale).toContain('完了と報告せず')
  await $.turn.complete({ answer: '完了', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(s.toasts.join()).toContain('未検証または失敗')
  await call($, RUN)
  expect((await call($, STATUS)).result).toContain('全条件が、現在の変更状態で成功')
})

test('既存の失敗: 変更前の基準と照らして区別する', async ($: any, on: any) => {
  let code = 1
  setup(on, () => ({ exitCode: code }))
  await define($)
  expect((await call($, RUN, { baseline: true })).result).toContain('基準として記録')
  expect((await call($, RUN)).result).toContain('既存の失敗')

  code = 0
  await call($, RUN, { baseline: true })
  code = 1
  expect((await call($, RUN)).result).toContain('今回の変更による')
})

test('未登録・不正入力は拒否する', async ($: any, on: any) => {
  setup(on, () => ({ exitCode: 0 }))
  expect((await call($, RUN)).deny).toContain('verify_define')
  expect((await call($, DEFINE, { conditions: [{ id: 'a', command: 'npm test' }] })).deny).toContain('argv')
  await define($)
  expect((await call($, RUN, { id: 'nope' })).deny).toContain('見つからない')
})
