import { test, expect, mock } from 'claude-code/testing'
import { COLLECT_MAX_CHARS, buildExcerpt, collectLog, fnv1a, formatReport, parseConditions, readConfig, verdictOf, windowCandidates, type Entry, type Run } from './policy'
import { splitCandidates } from './local-llm'

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
  const state = { tree: 'clean', toasts: [] as string[], logs: [] as string[], clock: undefined as any }
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
  on('ui.log', (_$: unknown, e: unknown) => {
    state.logs.push(JSON.stringify(e))
    return { value: undefined }
  })
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

// --- ローカルLLMによる失敗ログの抽出 ---

type Line = { id: number; text: string }
type Reply = (lines: Line[]) => unknown

const llmSetup = (on: any, script: Script, reply: Reply) => {
  const s = setup(on, script)
  const fetches: { system: string; prompt: string }[] = []
  on('http.fetch', (_$: unknown, e: { init?: { body?: string } }) => {
    const messages = JSON.parse(e.init!.body!).messages as { content: string }[]
    const prompt = messages[messages.length - 1]!.content
    fetches.push({ system: messages.length > 1 ? messages[0]!.content : '', prompt })
    const lines = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ id: Number(m[1]), text: m[2]! }))
    const r = reply(lines)
    if (r === 'error') return { value: { ok: false, status: 500, headers: {}, text: '' } }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }) } }
  })
  return Object.assign(s, { fetches })
}

const ALWAYS = { options: { llmMode: 'always' } }
const noise = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `noise line ${from + i}`)
const idsMatching = (re: RegExp): Reply => lines => ({ ids: lines.filter(l => re.test(l.text)).map(l => l.id) })
// エラーが先頭と中間にあり、末尾は無関係なログ
const mixedLog = [...noise(3), 'ERROR: boom at src/a.ts:3', '  expected 1 but got 2', ...noise(150, 3), 'FAIL test_widget', ...noise(200, 153)].join('\n')
const head = (r: string) => r.split('\n\n--- ')[0]!

test('抽出: 末尾が無関係でも、先頭・中間のエラーを原文のまま行番号付きで返す', ALWAYS, async ($: any, on: any) => {
  const s = llmSetup(on, () => ({ exitCode: 1, stdout: mixedLog }), idsMatching(/ERROR|expected|FAIL/))
  await define($)
  const r = (await call($, RUN)).result
  expect(s.fetches).toHaveLength(1)
  expect(r).toContain('ローカルLLMが選んだ 3 行の原文')
  expect(r).toContain('L4: ERROR: boom at src/a.ts:3')
  expect(r).toContain('L5:   expected 1 but got 2')
  expect(r).toContain('L156: FAIL test_widget')
  expect(r).not.toContain('noise line 352')
  expect(r).toContain('再実行')
  expect(r).toContain('exit 1')
})

test('抽出: off は通信せず、既存の末尾出力を返す', async ($: any, on: any) => {
  const s = llmSetup(on, () => ({ exitCode: 1, stdout: mixedLog }), idsMatching(/ERROR/))
  await define($)
  const r = (await call($, RUN)).result
  expect(s.fetches).toHaveLength(0)
  expect(r).toContain('の出力 (末尾) ---')
  expect(r).toContain('noise line 352')
  expect(r).not.toContain('ERROR: boom')
})

// 失敗・既存の失敗・再変更・タイムアウトの判定表示が、LLM の応答 (成功・不正・失敗) や off と完全に同じになる
const verdictRuns: string[] = []
const scenarios: [string, object, Reply][] = [
  ['off', {}, idsMatching(/ERROR/)],
  ['選択に成功', ALWAYS, idsMatching(/ERROR/)],
  ['不正な行ID', ALWAYS, () => ({ ids: [9999] })],
  ['JSON でない応答', ALWAYS, () => 'not json'],
  ['モデルの失敗', ALWAYS, () => 'error'],
]
for (const [name, opts, reply] of scenarios) {
  test(`抽出: 判定は抽出結果に影響されない (${name})`, opts, async ($: any, on: any) => {
    let code = 1
    const s = llmSetup(on, () => (code === -1 ? 'hang' : { exitCode: code, stdout: mixedLog }), reply)
    await define($, 7)
    const failed = head((await call($, RUN)).result)
    await call($, RUN, { baseline: true })
    const preexisting = head((await call($, RUN)).result)
    code = 0
    await call($, RUN)
    s.tree = ' M src/a.ts'
    const stale = (await call($, STATUS)).result
    s.tree = 'clean'
    code = -1
    const pending = call($, RUN)
    await s.clock.advance(7000 + 2000)
    const timeout = head((await pending).result)
    const all = [failed, preexisting, stale, timeout].join('\n=====\n')
    expect(all).toContain('失敗 (既存の失敗かは不明')
    expect(all).toContain('既存の失敗。ベースラインでも同じ')
    expect(all).toContain('再変更あり')
    expect(all).toContain('タイムアウト')
    verdictRuns.push(all)
    expect(all).toBe(verdictRuns[0]!)
  })
}

const rejected: [string, Reply][] = [
  ['範囲外の行ID', () => ({ ids: [9999] })],
  ['重複した行ID', () => ({ ids: [1, 1] })],
  ['空の選択', () => ({ ids: [] })],
  ['整数でない行ID', () => ({ ids: [1.5] })],
  ['上限を超える件数', lines => ({ ids: lines.map(l => l.id) })],
  ['JSON でない応答', () => 'not json'],
  ['モデルの失敗', () => 'error'],
]
for (const [name, reply] of rejected) {
  test(`抽出: ${name}は既存の末尾出力に戻る`, ALWAYS, async ($: any, on: any) => {
    llmSetup(on, () => ({ exitCode: 1, stdout: mixedLog }), reply)
    await define($)
    const r = (await call($, RUN)).result
    expect(r).toContain('の出力 (末尾) ---')
    expect(r).toContain('noise line 352')
    expect(r).toContain('失敗')
  })
}

test('抽出: 成功・タイムアウトでは LLM を呼ばない', ALWAYS, async ($: any, on: any) => {
  let mode: 'ok' | 'hang' = 'ok'
  const s = llmSetup(on, () => (mode === 'hang' ? 'hang' : { exitCode: 0, stdout: mixedLog }), idsMatching(/ERROR/))
  await define($, 7)
  await call($, RUN)
  mode = 'hang'
  const pending = call($, RUN)
  await s.clock.advance(9000)
  await pending
  expect(s.fetches).toHaveLength(0)
})


test('抽出: 長大なログは収集上限で切り、入力上限に収め、省略を明示する', ALWAYS, async ($: any, on: any) => {
  const big = ['ERROR: first failure', ...noise(40_000), 'ERROR: last failure'].join('\n')
  const s = llmSetup(on, () => ({ exitCode: 1, stdout: big }), idsMatching(/ERROR/))
  await define($)
  const r = (await call($, RUN)).result
  expect(s.fetches).toHaveLength(1)
  expect(s.fetches[0]!.prompt.length + s.fetches[0]!.system.length).toBeLessThanOrEqual(12_000)
  expect(s.fetches[0]!.prompt).toContain('中央の')
  expect(r).toContain('L1: ERROR: first failure')
  expect(r).toContain('ERROR: last failure')
  expect(r).toContain('収集していない')
  expect(r).toContain(`先頭と末尾の計 ${COLLECT_MAX_CHARS} 文字だけを収集した`)
})

test('抽出: 返却は outputTailChars で打ち切り、省いた行数を示す', { options: { llmMode: 'always', outputTailChars: 120 } }, async ($: any, on: any) => {
  llmSetup(on, () => ({ exitCode: 1, stdout: mixedLog }), idsMatching(/noise line 1[0-4]\d$/))
  await define($)
  const r = (await call($, RUN)).result
  expect(r).toContain('返却上限のため')
  expect(r).toContain('L103: noise line 100')
  expect(r).not.toContain('noise line 120')
  expect(r).not.toContain('(末尾)')
})

test('抽出: auto は末尾に収まらない長さのときだけ使う', { options: { llmMode: 'auto' } }, async ($: any, on: any) => {
  let out = 'short failure'
  const s = llmSetup(on, () => ({ exitCode: 1, stdout: out }), idsMatching(/ERROR/))
  await define($)
  expect((await call($, RUN)).result).toContain('short failure')
  expect(s.fetches).toHaveLength(0)
  out = mixedLog
  expect((await call($, RUN)).result).toContain('ERROR: boom')
  expect(s.fetches).toHaveLength(1)
})

test('抽出: 診断記録にログ本文を残さない', ALWAYS, async ($: any, on: any) => {
  const s = llmSetup(on, () => ({ exitCode: 1, stdout: mixedLog }), idsMatching(/ERROR/))
  await define($)
  await call($, RUN)
  expect(s.logs.length).toBeGreaterThan(0)
  expect(s.logs.join('\n')).not.toMatch(/boom|noise line|FAIL test_widget/)
})

test('抽出: 純粋な組み立て (収集の上限・窓・中略の印)', () => {
  const c = collectLog('a'.repeat(30) + '\n' + 'b'.repeat(30), 20)
  expect(c.text).toBe(`${'a'.repeat(10)}\n${'b'.repeat(10)}`)
  expect(c.omitted).toBe(41)
  const cands = splitCandidates(c.text, { by: 'lines', maxChars: 300 })
  const ex = buildExcerpt(cands, c.joinAt, c.omitted, 1000)
  expect(ex.text).toContain('収集していない')
  const many = splitCandidates(noise(100).join('\n'), { by: 'lines' })
  const w = windowCandidates(many, 400)
  expect(w.hidden).toBeGreaterThan(0)
  expect(w.shown[0]!.id).toBe(1)
  expect(w.shown[w.shown.length - 1]!.id).toBe(100)
})
