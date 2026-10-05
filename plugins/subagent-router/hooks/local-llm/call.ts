import type { LlmConfig } from './config'
import { type JsonSchema, matchesSchema } from './schema'

export type FailReason =
  | 'disabled'
  | 'unreachable'
  | 'timeout'
  | 'http'
  | 'invalid_json'
  | 'schema'
  | 'semantic'
  | 'input_too_large'
  | 'output_too_large'
  | 'trust_denied'
  | 'all_failed'

/** all_failed 以外の、1 回の試行が失敗した理由。 */
export type AttemptReason = Exclude<FailReason, 'disabled' | 'input_too_large' | 'all_failed'>

export type Attempt = { model: string; reason: AttemptReason; ms: number }

export type LlmResult<T> =
  | { ok: true; value: T; model: string; ms: number; inChars: number; outChars: number }
  | { ok: false; reason: FailReason; ms: number; attempts: Attempt[] }

/**
 * 呼び出し層が使う通信の口。`$` はインポート越しに渡せない (claude plugin validate が拒否する) ので、
 * 各 plugin が register.ts の中で `$.http.fetch` などを包んで作る。
 */
export type LlmTransport = {
  fetch: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: string }>
  sleep: (ms: number, options: { signal: AbortSignal }) => Promise<void>
  log?: (text: string) => unknown
}

export type LlmRequest<T> = {
  /** 診断ログの接頭辞に使う plugin 名。 */
  label: string
  prompt: string
  system?: string
  /** ollama の format。応答の検証にも使う。 */
  schema: JsonSchema
  /** スキーマを通った値の意味の検証。false なら reason: semantic。 */
  semantic?: (value: T) => boolean
  /** auto で使う決定的な条件。未指定の auto は使わない。 */
  autoWhen?: () => boolean
}

/** 失敗したモデルを飛ばす回数の管理。呼び出し側が plugin のあいだ保持する。 */
export type LlmState = { cooldown: Map<string, number>; cooldownCalls: number }

export const createLlmState = (cooldownCalls = 5): LlmState => ({ cooldown: new Map(), cooldownCalls })

/** 失敗したモデルを cooldown 回の呼び出しのあいだ飛ばす。全部飛ばす状況では最後の 1 つを試す。 */
export const pickCandidates = (models: readonly string[], cooldown: ReadonlyMap<string, number>): string[] => {
  const live = models.filter(m => (cooldown.get(m) ?? 0) <= 0)
  const last = models[models.length - 1]
  return live.length > 0 ? live : last === undefined ? [] : [last]
}

export const tick = (cooldown: Map<string, number>) => {
  for (const [k, v] of cooldown) {
    if (v <= 1) cooldown.delete(k)
    else cooldown.set(k, v - 1)
  }
}

export const buildBody = (cfg: Pick<LlmConfig, 'keepAlive'>, model: string, req: Pick<LlmRequest<unknown>, 'prompt' | 'system' | 'schema'>) =>
  JSON.stringify({
    model,
    stream: false,
    think: false,
    format: req.schema,
    keep_alive: cfg.keepAlive,
    options: { temperature: 0 },
    messages: [...(req.system === undefined ? [] : [{ role: 'system', content: req.system }]), { role: 'user', content: req.prompt }],
  })

const TIMEOUT = { timeout: true } as const
const DENY = /trust-boundary|denied|blocked/i

type Raw = { ok: true; text: string } | { ok: false; reason: AttemptReason }

async function post(t: LlmTransport, cfg: LlmConfig, model: string, req: LlmRequest<unknown>, waitMs: number, deadline: Promise<typeof TIMEOUT>): Promise<Raw> {
  const stop = new AbortController()
  try {
    const call = t
      .fetch(`${cfg.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: buildBody(cfg, model, req) })
      .then(
        res => res,
        (e: unknown) => ({ error: e }),
      )
    const own = t.sleep(waitMs, { signal: stop.signal }).then(
      () => TIMEOUT,
      () => TIMEOUT,
    )
    const res = await Promise.race([call, own, deadline])
    if ('timeout' in res) return { ok: false, reason: 'timeout' }
    if ('error' in res) return { ok: false, reason: DENY.test(String((res.error as { message?: unknown } | undefined)?.message ?? res.error)) ? 'trust_denied' : 'unreachable' }
    if (!res.ok) return { ok: false, reason: res.status === 403 && DENY.test(res.text) ? 'trust_denied' : 'http' }
    const content = (JSON.parse(res.text) as { message?: { content?: unknown } }).message?.content
    return typeof content === 'string' ? { ok: true, text: content } : { ok: false, reason: 'http' }
  } catch {
    return { ok: false, reason: 'http' }
  } finally {
    stop.abort()
  }
}

/**
 * ローカル LLM を呼ぶ。throw せず、成功か失敗理由をタグ付きで返す。
 * off と、条件を満たさない auto は通信せずに disabled を返す。
 */
export async function callLocalLlm<T>(t: LlmTransport, cfg: LlmConfig, req: LlmRequest<T>, state: LlmState = createLlmState()): Promise<LlmResult<T>> {
  const started = Date.now()
  const inChars = req.prompt.length + (req.system?.length ?? 0)
  const attempts: Attempt[] = []
  const finish = (reason: FailReason): LlmResult<T> => {
    log(t, req.label, `reason=${reason} in=${inChars}`)
    return { ok: false, reason, ms: Date.now() - started, attempts }
  }
  try {
    if (cfg.mode === 'off' || (cfg.mode === 'auto' && req.autoWhen?.() !== true)) return { ok: false, reason: 'disabled', ms: 0, attempts }
    if (inChars > cfg.maxInputChars) return finish('input_too_large')

    const stop = new AbortController()
    const deadline = t.sleep(cfg.totalTimeoutMs, { signal: stop.signal }).then(
      () => TIMEOUT,
      () => TIMEOUT,
    )
    let expired = false
    void deadline.then(() => void (expired = true))
    try {
      const candidates = pickCandidates(cfg.models, state.cooldown).slice(0, cfg.maxAttempts)
      tick(state.cooldown)

      for (const model of candidates) {
        if (expired) break
        const t0 = Date.now()
        const fail = (reason: AttemptReason, outChars = 0) => {
          attempts.push({ model, reason, ms: Date.now() - t0 })
          log(t, req.label, `reason=${reason} model=${model} ms=${Date.now() - t0} in=${inChars} out=${outChars}`)
        }
        const raw = await post(t, cfg, model, req as LlmRequest<unknown>, cfg.timeoutMs, deadline)
        if (!raw.ok) {
          fail(raw.reason)
          if (raw.reason === 'trust_denied') return finish('trust_denied')
          state.cooldown.set(model, state.cooldownCalls)
          continue
        }
        const outChars = raw.text.length
        let value: unknown
        let reason: AttemptReason | undefined
        if (outChars > cfg.maxOutputChars) reason = 'output_too_large'
        else {
          try {
            value = JSON.parse(raw.text)
          } catch {
            reason = 'invalid_json'
          }
        }
        if (reason === undefined && !matchesSchema(value, req.schema)) reason = 'schema'
        if (reason === undefined && req.semantic !== undefined) {
          try {
            if (!req.semantic(value as T)) reason = 'semantic'
          } catch {
            reason = 'semantic'
          }
        }
        if (reason !== undefined) {
          fail(reason, outChars)
          state.cooldown.set(model, state.cooldownCalls)
          continue
        }
        const ms = Date.now() - started
        log(t, req.label, `ok model=${model} ms=${ms} in=${inChars} out=${outChars}`)
        return { ok: true, value: value as T, model, ms, inChars, outChars }
      }
      return finish('all_failed')
    } finally {
      stop.abort()
    }
  } catch {
    return finish('all_failed')
  }
}

/** 理由コードと所要時間・サイズだけを記録する。プロンプトや応答の本文は書かない。 */
const log = (t: LlmTransport, label: string, text: string) => {
  try {
    t.log?.(`${label}: local-llm ${text}`)
  } catch {}
}
