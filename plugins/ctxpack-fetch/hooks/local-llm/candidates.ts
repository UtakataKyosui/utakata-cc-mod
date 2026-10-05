import type { JsonSchema } from './schema'

/** 原文を分けた 1 件。id は 1 始まりで、start/end は原文の文字位置、line は 1 始まりの開始行。 */
export type Candidate = { id: number; text: string; start: number; end: number; line: number }

export type SplitOptions = {
  /** lines: 1 行 1 件 (空行は除く) / chunks: 空行区切りの段落を 1 件にする。 */
  by: 'lines' | 'chunks'
  /** 1 件の最大文字数。超える段落は行の境界で、超える行は文字数で切る。 */
  maxChars?: number
  /** 件数の上限。超えた分は候補に入れない。 */
  maxCount?: number
}

const lines = (source: string): { text: string; start: number }[] => {
  const out: { text: string; start: number }[] = []
  let pos = 0
  for (const line of source.split('\n')) {
    out.push({ text: line, start: pos })
    pos += line.length + 1
  }
  return out
}

const lineOf = (source: string, offset: number) => {
  let n = 1
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) n++
  return n
}

/** 原文を候補に分けて ID を振る。text は常に原文の slice で、原文へ戻せる。 */
export const splitCandidates = (source: string, o: SplitOptions): Candidate[] => {
  const max = o.maxChars !== undefined && o.maxChars > 0 ? o.maxChars : Infinity
  const spans: { start: number; end: number }[] = []
  const cut = (start: number, end: number) => {
    for (let s = start; s < end; s += max) spans.push({ start: s, end: Math.min(end, s + max) })
  }
  if (o.by === 'lines') {
    for (const p of lines(source)) if (p.text.trim() !== '') cut(p.start, p.start + p.text.length)
  } else {
    let cur: { start: number; end: number } | undefined
    const flush = () => {
      if (cur !== undefined) cut(cur.start, cur.end)
      cur = undefined
    }
    for (const p of lines(source)) {
      if (p.text.trim() === '') {
        flush()
        continue
      }
      const end = p.start + p.text.length
      if (cur !== undefined && end - cur.start > max) flush()
      cur = cur === undefined ? { start: p.start, end } : { start: cur.start, end }
    }
    flush()
  }
  return spans.slice(0, o.maxCount ?? Infinity).map((s, i) => ({ id: i + 1, text: source.slice(s.start, s.end), start: s.start, end: s.end, line: lineOf(source, s.start) }))
}

/** プロンプトに載せる `[id] 本文` 形式。複数行の候補は 2 行目以降をインデントする。 */
export const renderCandidates = (cands: readonly Candidate[]): string => cands.map(c => `[${c.id}] ${c.text.replace(/\n/g, '\n    ')}`).join('\n')

export type IdCheck =
  | { ok: true; ids: number[]; dropped: number }
  | { ok: false; reason: 'not_array' | 'invalid_id' | 'out_of_range' | 'duplicate' | 'too_many' }

/**
 * LLM が返した ID 列を検証する。
 * strict: 不正・範囲外・重複が 1 つでもあれば拒否 / drop: それらを除いて残りを返す (順序は保つ)。
 * max を超える件数は、strict では拒否、drop では先頭 max 件に絞る。
 */
export const validateIds = (raw: unknown, cands: readonly Candidate[], o: { mode?: 'strict' | 'drop'; max?: number } = {}): IdCheck => {
  const strict = o.mode === 'strict'
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_array' }
  const known = new Set(cands.map(c => c.id))
  const seen = new Set<number>()
  const ids: number[] = []
  let dropped = 0
  for (const v of raw) {
    const bad: 'invalid_id' | 'out_of_range' | 'duplicate' | undefined =
      typeof v !== 'number' || !Number.isInteger(v) ? 'invalid_id' : !known.has(v) ? 'out_of_range' : seen.has(v) ? 'duplicate' : undefined
    if (bad !== undefined) {
      if (strict) return { ok: false, reason: bad }
      dropped++
      continue
    }
    seen.add(v as number)
    ids.push(v as number)
  }
  if (o.max !== undefined && ids.length > o.max) {
    if (strict) return { ok: false, reason: 'too_many' }
    dropped += ids.length - o.max
    ids.length = o.max
  }
  return { ok: true, ids, dropped }
}

/** ID 列を原文の断片に戻す。 */
export const pickByIds = (cands: readonly Candidate[], ids: readonly number[]): Candidate[] => {
  const byId = new Map(cands.map(c => [c.id, c]))
  return ids.flatMap(id => byId.get(id) ?? [])
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** LLM の引用が原文に実在するか。空白の違いは無視する。 */
export const quoteInSource = (source: string, quote: string): boolean => {
  const q = squash(quote)
  return q !== '' && squash(source).includes(q)
}

export const verifyQuotes = (source: string, quotes: readonly string[]): { valid: string[]; invalid: string[] } => {
  const valid: string[] = []
  const invalid: string[] = []
  for (const q of quotes) (quoteInSource(source, q) ? valid : invalid).push(q)
  return { valid, invalid }
}

/** 入力を max 文字で切る。切ったかどうかを返すので、呼び出し側が既存動作へ戻すかを決められる。 */
export const clipInput = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true }

/** `{ "ids": [..] }` を返させる応答スキーマ。 */
export const idsSchema = (maxItems: number): JsonSchema => ({
  type: 'object',
  properties: { ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems } },
  required: ['ids'],
})
