// ollama の /api/chat の代役。プロンプトの候補 ("[ID] 本文") から、戦略に従って決定的に ID を選んで返す。
import type { EvalCase } from './cases'

export type Strategy = 'oracle' | 'head-biased' | 'bait-follower' | 'down' | 'invalid'

export const STRATEGIES: readonly Strategy[] = ['oracle', 'head-biased', 'bait-follower', 'down', 'invalid']

/**
 * - oracle: 必要情報を持つ候補だけを選ぶ (理想的な応答)
 * - head-biased: 先頭の候補だけを選ぶ (末尾や中間を取りこぼす)
 * - bait-follower: 誤誘導・指示文の候補を選ぶ
 * - down: 接続先が 503 を返す
 * - invalid: 存在しない ID を返す
 */
export type MockHttp = (url: string, init?: { body?: string }) => Promise<{ ok: boolean; status: number; text: string }>

const HEAD_PICK = 3

/** プロンプト本文から候補の ID と本文を取り出す。続き行は 4 つの空白で始まる。 */
export const parseCandidates = (prompt: string): { id: number; text: string }[] =>
  prompt
    .split(/\n(?=\[\d+\] )/)
    .map(part => /^\[(\d+)\] ([\s\S]*)$/.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ id: Number(m[1]), text: m[2]!.replace(/\n    /g, '\n') }))

const matching = (cands: readonly { id: number; text: string }[], patterns: readonly string[]) => {
  const res = patterns.map(p => new RegExp(p, 'm'))
  return cands.filter(c => res.some(re => re.test(c.text))).map(c => c.id)
}

export const mockOllama = (strategy: Strategy, c: EvalCase, opts: { latencyMs?: number } = {}): { http: MockHttp; calls: () => number } => {
  let calls = 0
  const http: MockHttp = async (_url, init) => {
    calls++
    if (opts.latencyMs !== undefined && opts.latencyMs > 0) await new Promise(r => setTimeout(r, opts.latencyMs))
    if (strategy === 'down') return { ok: false, status: 503, text: '' }
    const body = JSON.parse(init?.body ?? '{}') as { messages?: { role: string; content: string }[] }
    const prompt = body.messages?.find(m => m.role === 'user')?.content ?? ''
    const cands = parseCandidates(prompt)
    const ids =
      strategy === 'oracle'
        ? matching(cands, c.oracle)
        : strategy === 'head-biased'
          ? cands.slice(0, HEAD_PICK).map(x => x.id)
          : strategy === 'bait-follower'
            ? matching(cands, c.bait)
            : [cands.length + 1000]
    return { ok: true, status: 200, text: JSON.stringify({ message: { content: JSON.stringify({ ids }) } }) }
  }
  return { http, calls: () => calls }
}
