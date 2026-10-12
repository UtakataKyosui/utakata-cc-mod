import { test, expect } from 'claude-code/testing'
import { analyze } from './policy'
import { findingsOf, improve, parseVerdict, refine, renderImprovements } from './improve'
import type { Llm } from './improve'

const at = Date.parse('2026-10-10T00:00:00.000Z')
const mk = (text: string, sessionId = 's1') => ({ sessionId, at, text })

const fake = (verdicts: string[]): Llm & { drafts: string[] } => {
  const drafts: string[] = []
  return {
    drafts,
    draft: async prompt => {
      drafts.push(prompt)
      return `規則${drafts.length}`
    },
    judge: async () => verdicts.shift() ?? '?',
  }
}

test('判断モデルの出力から選択肢を読む', () => {
  expect(parseVerdict('A')).toBe('adopt')
  expect(parseVerdict(' B\n')).toBe('revise')
  expect(parseVerdict('C')).toBe('discard')
  expect(parseVerdict('考察のA案は弱い。\n</think>\n\nB')).toBe('revise')
  expect(parseVerdict('<think>Aかもしれない</think>C')).toBe('discard')
  expect(parseVerdict('Answer: A')).toBe('adopt')
  expect(parseVerdict('採用')).toBeUndefined()
  expect(parseVerdict('')).toBeUndefined()
})

test('集計結果から改善案の対象を取り出す', () => {
  const a = analyze([mk('それを記録して'), mk('jaa')], at - 1000, at + 1000)
  expect(findingsOf(a).map(f => f.id)).toEqual(['deictic', 'fragments'])
  expect(findingsOf(analyze([], 0, 1))).toEqual([])
})

test('採用・修正・棄却の流れ', async () => {
  const f = findingsOf(analyze([mk('それを記録して')], at - 1000, at + 1000))[0]

  const adopted = await refine(fake(['A']), f)
  expect([adopted.status, adopted.rounds]).toEqual(['adopted', 1])

  const llm = fake(['B', 'A'])
  const revised = await refine(llm, f)
  expect([revised.status, revised.rounds, revised.rule]).toEqual(['adopted', 2, '規則2'])
  expect(llm.drafts[1]).toContain('前回の案への指摘')

  expect((await refine(fake(['B', 'B']), f)).status).toBe('needs-review')
  expect((await refine(fake(['C']), f)).status).toBe('discarded')
  expect((await refine(fake(['???']), f)).status).toBe('needs-review')
  const unreadable = await refine(fake(['???', 'A']), f)
  expect([unreadable.status, unreadable.rounds]).toEqual(['needs-review', 1])
})

test('改善案のレポート', async () => {
  const a = analyze([mk('それを記録して'), mk('jaa')], at - 1000, at + 1000)
  const proposals = await improve(fake(['A', 'C']), a)
  const md = renderImprovements(proposals, { draft: 'gemma4:e4b', judge: 'tev1:4b' }, 'http://localhost:11434')
  expect(md).toContain('## 採用された改善案')
  expect(md).toContain('### 指示語だけのプロンプト')
  expect(md).toContain('## 棄却された観察')
  expect(md).toContain('gemma4:e4b')
  expect(md).toContain('外部には送っていない')
  expect(renderImprovements(proposals, { draft: 'a', judge: 'b' }, 'http://192.168.0.5:11434')).toContain('http://192.168.0.5:11434 に送って処理した')
  expect(renderImprovements([], { draft: 'a', judge: 'b' }, 'http://localhost:11434')).toContain('改善案を作る対象がなかった')
})
