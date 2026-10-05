// 実 ollama のモデルの cold / warm を、申告ではなく操作と観測で決める。
//   cold: keep_alive 0 で読み込みを解除し、/api/ps で解除を確かめる
//   warm: 空のプロンプトで読み込み、/api/ps で読み込みを確かめる
//   observe: 操作せず、/api/ps の状態を記録する
import type { Warmth } from './schema'

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

export type WarmMode = 'cold' | 'warm' | 'observe'
export const WARM_MODES: readonly WarmMode[] = ['cold', 'warm', 'observe']

/** `tev1:4b` と `tev1:4b:latest` は同じモデルとして扱う。 */
export const isLoaded = (names: readonly string[], model: string): boolean => names.some(n => n === model || n === `${model}:latest` || n.split(':')[0] === model)

const realWait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export const createControl = (opts: { url: string; models: readonly string[]; fetch?: Fetch; wait?: (ms: number) => Promise<void> }) => {
  const f: Fetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const wait = opts.wait ?? realWait
  const post = async (body: unknown): Promise<boolean> => {
    try {
      return (await f(`${opts.url}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).ok
    } catch {
      return false
    }
  }

  /** 読み込み済みのモデル名。取得できなければ null。 */
  const loaded = async (): Promise<string[] | null> => {
    try {
      const res = await f(`${opts.url}/api/ps`)
      if (!res.ok) return null
      const models = ((await res.json()) as { models?: { name?: unknown; model?: unknown }[] }).models
      return Array.isArray(models) ? models.map(m => String(m.name ?? m.model ?? '')).filter(n => n !== '') : null
    } catch {
      return null
    }
  }

  const settle = async (done: (names: string[]) => boolean): Promise<boolean | null> => {
    for (let i = 0; i < 20; i++) {
      const names = await loaded()
      if (names === null) return null
      if (done(names)) return true
      await wait(300)
    }
    return false
  }

  /** モデルの状態を整えて、観測した状態を返す。確かめられなければ unknown。 */
  const prepare = async (mode: WarmMode): Promise<Warmth> => {
    const first = opts.models[0]
    if (first === undefined) return 'unknown'
    if (mode === 'cold') {
      await Promise.all(opts.models.map(m => post({ model: m, keep_alive: 0 })))
      return (await settle(names => opts.models.every(m => !isLoaded(names, m)))) === true ? 'cold' : 'unknown'
    }
    if (mode === 'warm') {
      await post({ model: first, keep_alive: '5m' })
      return (await settle(names => isLoaded(names, first))) === true ? 'warm' : 'unknown'
    }
    const names = await loaded()
    return names === null ? 'unknown' : isLoaded(names, first) ? 'warm' : 'cold'
  }

  return { loaded, prepare }
}
