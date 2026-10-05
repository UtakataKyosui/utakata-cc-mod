import { describe, expect, test } from 'bun:test'
import { type LlmTransport, type LlmRequest, callLocalLlm, createLlmState, pickCandidates, tick } from './call'
import { LLM_DEFAULTS, type LlmConfig, readLlmConfig } from './config'

type Reply = { ok: boolean; status: number; text: string } | Error | 'hang'
const content = (v: unknown) => ({ ok: true, status: 200, text: JSON.stringify({ message: { content: typeof v === 'string' ? v : JSON.stringify(v) } }) })

const engine = (reply: (model: string, n: number) => Reply) => {
  const calls: { url: string; model: string; body: any }[] = []
  const logs: string[] = []
  const $: LlmTransport = {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, model: body.model, body })
      const r = reply(body.model, calls.length)
      if (r === 'hang') return new Promise(() => {})
      if (r instanceof Error) throw r
      return r
    },
    sleep: (ms, o) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        o.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))))
      }),
    log: t => void logs.push(t),
  }
  return { $, calls, logs }
}

const cfg = (o: Partial<LlmConfig> = {}): LlmConfig => ({ ...LLM_DEFAULTS, mode: 'always', models: ['a', 'b', 'c'], timeoutMs: 40, totalTimeoutMs: 400, ...o })
const SCHEMA = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } as const
const req = (o: Partial<LlmRequest<{ n: number }>> = {}): LlmRequest<{ n: number }> => ({ label: 't', prompt: 'SECRET-PROMPT', schema: SCHEMA, ...o })

describe('モードと通信', () => {
  test('off は通信せず disabled を返す', async () => {
    const e = engine(() => content({ n: 1 }))
    const r = await callLocalLlm(e.$, cfg({ mode: 'off' }), req())
    expect(r).toMatchObject({ ok: false, reason: 'disabled' })
    expect(e.calls).toHaveLength(0)
  })

  test('auto は条件を満たすときだけ通信し、条件なしは使わない', async () => {
    const e = engine(() => content({ n: 1 }))
    expect((await callLocalLlm(e.$, cfg({ mode: 'auto' }), req())).ok).toBe(false)
    expect((await callLocalLlm(e.$, cfg({ mode: 'auto' }), req({ autoWhen: () => false }))).ok).toBe(false)
    expect(e.calls).toHaveLength(0)
    expect(await callLocalLlm(e.$, cfg({ mode: 'auto' }), req({ autoWhen: () => true }))).toMatchObject({ ok: true, value: { n: 1 }, model: 'a' })
    expect(e.calls).toHaveLength(1)
  })

  test('always は必ず試し、リクエストに format・keep_alive・system が入る', async () => {
    const e = engine(() => content({ n: 2 }))
    const r = await callLocalLlm(e.$, cfg({ keepAlive: '9m', ollamaUrl: 'http://h:1' }), req({ system: 'sys' }))
    expect(r).toMatchObject({ ok: true, value: { n: 2 }, model: 'a', inChars: 'SECRET-PROMPT'.length + 3 })
    expect(e.calls[0]!.url).toBe('http://h:1/api/chat')
    expect(e.calls[0]!.body).toMatchObject({ stream: false, format: SCHEMA, keep_alive: '9m' })
    expect(e.calls[0]!.body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'SECRET-PROMPT' }])
  })
})

describe('失敗の分類 (throw せず次のモデルへ回る)', () => {
  const attemptsOf = async (reply: Reply, o: Partial<LlmRequest<{ n: number }>> = {}, c: Partial<LlmConfig> = {}) => {
    const e = engine(() => reply)
    const r = await callLocalLlm(e.$, cfg({ maxAttempts: 1, ...c }), req(o))
    return { r, e }
  }

  test('接続不能', async () => {
    const { r } = await attemptsOf(new Error('ECONNREFUSED'))
    expect(r).toMatchObject({ ok: false, reason: 'all_failed', attempts: [{ model: 'a', reason: 'unreachable' }] })
  })
  test('タイムアウト', async () => {
    const { r } = await attemptsOf('hang')
    expect(r).toMatchObject({ ok: false, attempts: [{ reason: 'timeout' }] })
  })
  test('非 ok と message なし', async () => {
    expect((await attemptsOf({ ok: false, status: 500, text: '' })).r).toMatchObject({ attempts: [{ reason: 'http' }] })
    expect((await attemptsOf({ ok: true, status: 200, text: '{}' })).r).toMatchObject({ attempts: [{ reason: 'http' }] })
    expect((await attemptsOf({ ok: true, status: 200, text: 'not json' })).r).toMatchObject({ attempts: [{ reason: 'http' }] })
  })
  test('不正 JSON', async () => {
    expect((await attemptsOf(content('{oops'))).r).toMatchObject({ attempts: [{ reason: 'invalid_json' }] })
  })
  test('スキーマ違反', async () => {
    expect((await attemptsOf(content({ n: 'x' }))).r).toMatchObject({ attempts: [{ reason: 'schema' }] })
    expect((await attemptsOf(content({}))).r).toMatchObject({ attempts: [{ reason: 'schema' }] })
  })
  test('意味検証の失敗と、検証関数の例外', async () => {
    expect((await attemptsOf(content({ n: 5 }), { semantic: v => v.n < 3 })).r).toMatchObject({ attempts: [{ reason: 'semantic' }] })
    expect((await attemptsOf(content({ n: 5 }), { semantic: () => { throw new Error('x') } })).r).toMatchObject({ attempts: [{ reason: 'semantic' }] })
  })
  test('出力が上限を超える', async () => {
    expect((await attemptsOf(content({ n: 1 }), {}, { maxOutputChars: 3 })).r).toMatchObject({ attempts: [{ reason: 'output_too_large' }] })
  })
  test('入力が上限を超えると通信せず input_too_large', async () => {
    const { r, e } = await attemptsOf(content({ n: 1 }), {}, { maxInputChars: 5 })
    expect(r).toMatchObject({ ok: false, reason: 'input_too_large' })
    expect(e.calls).toHaveLength(0)
  })
  test('trust-boundary の拒否は例外でも非 ok でも trust_denied で、他のモデルを試さない', async () => {
    const a = await attemptsOf(new Error('trust-boundary: 許可されていない宛先への送信を止めました'), {}, { maxAttempts: 3 })
    expect(a.r).toMatchObject({ ok: false, reason: 'trust_denied' })
    expect(a.e.calls).toHaveLength(1)
    const b = await attemptsOf({ ok: false, status: 403, text: 'trust-boundary: blocked' }, {}, { maxAttempts: 3 })
    expect(b.r).toMatchObject({ ok: false, reason: 'trust_denied' })
    expect(b.e.calls).toHaveLength(1)
  })
})

describe('候補の切り替えと上限', () => {
  test('失敗したら次のモデルで成功する', async () => {
    const e = engine(m => (m === 'a' ? new Error('down') : content({ n: 3 })))
    const r = await callLocalLlm(e.$, cfg(), req())
    expect(r).toMatchObject({ ok: true, model: 'b', value: { n: 3 } })
    expect(e.calls.map(c => c.model)).toEqual(['a', 'b'])
  })

  test('全候補が失敗すると all_failed で、試行回数の上限を守る', async () => {
    const e = engine(() => content('{'))
    const r = await callLocalLlm(e.$, cfg({ maxAttempts: 2 }), req())
    expect(r).toMatchObject({ ok: false, reason: 'all_failed' })
    expect(r.ok === false && r.attempts.map(a => a.model)).toEqual(['a', 'b'])
    expect(e.calls).toHaveLength(2)
  })

  test('全体の待ち時間の上限で打ち切る', async () => {
    const e = engine(() => 'hang')
    const t0 = Date.now()
    const r = await callLocalLlm(e.$, cfg({ timeoutMs: 100, totalTimeoutMs: 150, maxAttempts: 3 }), req())
    expect(r).toMatchObject({ ok: false, reason: 'all_failed' })
    expect(Date.now() - t0).toBeLessThan(400)
    expect(e.calls.length).toBeLessThan(3)
  })

  test('失敗したモデルは cooldown のあいだ飛ばし、全部飛ばす状況では最後を試す', async () => {
    const e = engine(m => (m === 'a' ? new Error('down') : content({ n: 1 })))
    const state = createLlmState(2)
    await callLocalLlm(e.$, cfg(), req(), state)
    await callLocalLlm(e.$, cfg(), req(), state)
    expect(e.calls.map(c => c.model)).toEqual(['a', 'b', 'b'])
    await callLocalLlm(e.$, cfg(), req(), state)
    await callLocalLlm(e.$, cfg(), req(), state)
    expect(e.calls.map(c => c.model)).toEqual(['a', 'b', 'b', 'b', 'a', 'b'])

    const cd = new Map([['a', 3], ['b', 3], ['c', 3]])
    expect(pickCandidates(['a', 'b', 'c'], cd)).toEqual(['c'])
    tick(cd)
    tick(cd)
    tick(cd)
    expect(pickCandidates(['a', 'b', 'c'], cd)).toEqual(['a', 'b', 'c'])
  })

  test('fetch の同期例外やログの例外でも throw しない', async () => {
    const e = engine(() => content({ n: 1 }))
    e.$.fetch = (() => { throw new Error('sync') }) as LlmTransport['fetch']
    e.$.log = () => { throw new Error('log') }
    expect((await callLocalLlm(e.$, cfg(), req())).ok).toBe(false)
  })
})

describe('診断ログ', () => {
  test('理由・モデル・時間・サイズだけを記録し、プロンプトと応答の本文は含めない', async () => {
    const e = engine(m => (m === 'a' ? content('{"leak":"SECRET-OUTPUT') : content({ n: 1 })))
    await callLocalLlm(e.$, cfg(), req())
    const text = e.logs.join('\n')
    expect(text).toContain('reason=invalid_json model=a')
    expect(text).toContain('ok model=b')
    expect(text).toMatch(/in=13 out=\d+/)
    expect(text).not.toContain('SECRET')
  })
})

test('readLlmConfig の結果をそのまま渡せる', async () => {
  const e = engine(() => content({ n: 1 }))
  expect((await callLocalLlm(e.$, readLlmConfig({ llmMode: 'always' }), req())).ok).toBe(true)
})
