import { test, expect } from 'claude-code/testing'
import { analyze, expandHome, isDeictic, isFragment, parseDays, parsePromptLine, readConfig, renderReport, reportFileName, resolveDir } from './policy'

const row = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-10-10T00:00:00.000Z', message: { role: 'user', content }, ...extra })

test('設定の既定値と不正値の丸め', () => {
  expect(readConfig({})).toEqual({
    transcriptDir: '~/.claude/projects',
    reportDir: 'reports',
    days: 7,
    ollamaUrl: 'http://localhost:11434',
    draftModel: 'gemma4:e4b',
    judgeModel: 'tev1:4b',
  })
  expect(readConfig({ ollamaUrl: 'http://h:1//' }).ollamaUrl).toBe('http://h:1')
  expect(readConfig({ days: 0, reportDir: ' ' }).days).toBe(7)
  expect(parseDays('30', 7)).toBe(30)
  expect(parseDays('', 7)).toBe(7)
  expect(parseDays('abc', 7)).toBe(7)
  expect(expandHome('~/a', '/h')).toBe('/h/a')
  expect(resolveDir('/r/', 'reports')).toBe('/r/reports')
  expect(resolveDir('/r', '/abs')).toBe('/abs')
})

test('会話ログから手打ちのプロンプトだけを取り出す', () => {
  expect(parsePromptLine(row('この関数を直して'))?.text).toBe('この関数を直して')
  expect(parsePromptLine(row([{ type: 'text', text: '前半' }, { type: 'text', text: '後半' }]))?.text).toBe('前半\n後半')
  expect(parsePromptLine(row([{ type: 'tool_result', content: 'x' }]))).toBeUndefined()
  expect(parsePromptLine(row('<command-name>/clear</command-name>'))).toBeUndefined()
  expect(parsePromptLine(row('Caveat: ...'))).toBeUndefined()
  expect(parsePromptLine(row('x', { isSidechain: true }))).toBeUndefined()
  expect(parsePromptLine(row('x', { isMeta: true }))).toBeUndefined()
  expect(parsePromptLine(JSON.stringify({ type: 'assistant' }))).toBeUndefined()
  expect(parsePromptLine('not json')).toBeUndefined()
})

test('誤送信と指示語の判定', () => {
  expect(isFragment('jaa')).toBe(true)
  expect(isFragment('はい')).toBe(false)
  expect(isFragment('/clear')).toBe(false)
  expect(isFragment('この関数を直して')).toBe(false)
  expect(isDeictic('それを記録してほしい')).toBe(true)
  expect(isDeictic('お願いします')).toBe(true)
  expect(isDeictic('それを docs/a.md に記録して')).toBe(false)
  expect(isDeictic('#12 を直して')).toBe(false)
})

test('期間内のプロンプトを集計してレポートにする', () => {
  const at = Date.parse('2026-10-10T00:00:00.000Z')
  const mk = (text: string, sessionId = 's1', t = at): { sessionId: string; at: number; text: string } => ({ sessionId, at: t, text })
  const prompts = [
    mk('それを記録して'),
    mk('jaa'),
    mk('a'.repeat(20_000)),
    mk('期間外', 's2', at - 10 * 86_400_000),
    ...Array.from({ length: 20 }, (_, i) => mk(`この件を進めて${i}`, 's3')),
  ]
  const a = analyze(prompts, at - 86_400_000, at + 86_400_000)
  expect(a.total).toBe(23)
  expect(a.sessions).toBe(2)
  expect([a.deictic.length, a.fragments.length, a.large.length]).toEqual([1, 1, 1])
  expect(a.drips).toEqual([{ sessionId: 's3', count: 20 }])
  const md = renderReport(a)
  expect(md).toContain('# プロンプト分析（2026-10-09〜2026-10-11）')
  expect(md).toContain('### 要件の小出し')
  expect(md).toContain('「それを記録して」')
  expect(reportFileName(at)).toBe('2026-10-10-prompt-analysis.md')
  expect(renderReport(analyze([], 0, 1))).toContain('該当するプロンプトはなかった')
})
