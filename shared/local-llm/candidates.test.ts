import { describe, expect, test } from 'bun:test'
import { clipInput, idsSchema, pickByIds, quoteInSource, renderCandidates, splitCandidates, validateIds, verifyQuotes } from './candidates'
import { matchesSchema } from './schema'

const SRC = 'alpha\n\nbeta one\nbeta two\n\n\ngamma'

describe('splitCandidates', () => {
  test('行ごとに ID を振り、原文の位置と行番号を保つ', () => {
    const c = splitCandidates(SRC, { by: 'lines' })
    expect(c.map(x => [x.id, x.text, x.line])).toEqual([[1, 'alpha', 1], [2, 'beta one', 3], [3, 'beta two', 4], [4, 'gamma', 7]])
    for (const x of c) expect(SRC.slice(x.start, x.end)).toBe(x.text)
  })

  test('段落ごと (長いものは行境界、さらに長い行は文字数で切る) と件数の上限', () => {
    const c = splitCandidates(SRC, { by: 'chunks' })
    expect(c.map(x => x.text)).toEqual(['alpha', 'beta one\nbeta two', 'gamma'])
    expect(splitCandidates(SRC, { by: 'chunks', maxChars: 10 }).map(x => x.text)).toEqual(['alpha', 'beta one', 'beta two', 'gamma'])
    expect(splitCandidates('abcdefgh', { by: 'lines', maxChars: 3 }).map(x => x.text)).toEqual(['abc', 'def', 'gh'])
    expect(splitCandidates(SRC, { by: 'lines', maxCount: 2 })).toHaveLength(2)
    expect(splitCandidates('', { by: 'lines' })).toEqual([])
  })

  test('プロンプト用の表示', () => {
    expect(renderCandidates(splitCandidates(SRC, { by: 'chunks' }))).toBe('[1] alpha\n[2] beta one\n    beta two\n[3] gamma')
  })
})

describe('validateIds / pickByIds', () => {
  const c = splitCandidates(SRC, { by: 'lines' })

  test('drop は不正・範囲外・重複を除き、順序を保つ', () => {
    expect(validateIds([3, 1, 3, 9, 0, 'x', 1.5, 2], c)).toEqual({ ok: true, ids: [3, 1, 2], dropped: 5 })
    expect(validateIds([1, 2, 3, 4], c, { max: 2 })).toEqual({ ok: true, ids: [1, 2], dropped: 2 })
  })

  test('strict は 1 つでも不正なら拒否する', () => {
    expect(validateIds([1, 2], c, { mode: 'strict' })).toEqual({ ok: true, ids: [1, 2], dropped: 0 })
    expect(validateIds([1, 9], c, { mode: 'strict' })).toEqual({ ok: false, reason: 'out_of_range' })
    expect(validateIds([1, 1], c, { mode: 'strict' })).toEqual({ ok: false, reason: 'duplicate' })
    expect(validateIds(['1'], c, { mode: 'strict' })).toEqual({ ok: false, reason: 'invalid_id' })
    expect(validateIds([1, 2, 3], c, { mode: 'strict', max: 2 })).toEqual({ ok: false, reason: 'too_many' })
    expect(validateIds({ ids: [1] }, c)).toEqual({ ok: false, reason: 'not_array' })
  })

  test('ID を原文の断片へ戻す', () => {
    expect(pickByIds(c, [4, 2, 99]).map(x => x.text)).toEqual(['gamma', 'beta one'])
  })
})

describe('引用と入力', () => {
  test('引用は空白の違いを無視して原文と照合する', () => {
    expect(quoteInSource(SRC, 'beta one\n beta   two')).toBe(true)
    expect(quoteInSource(SRC, 'beta three')).toBe(false)
    expect(quoteInSource(SRC, '  ')).toBe(false)
    expect(verifyQuotes(SRC, ['alpha', 'delta'])).toEqual({ valid: ['alpha'], invalid: ['delta'] })
  })

  test('入力の切り詰めと ID スキーマ', () => {
    expect(clipInput('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
    expect(clipInput('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(matchesSchema({ ids: [1, 2] }, idsSchema(2))).toBe(true)
    expect(matchesSchema({ ids: [1, 2, 3] }, idsSchema(2))).toBe(false)
    expect(matchesSchema({ ids: [0] }, idsSchema(2))).toBe(false)
  })
})
