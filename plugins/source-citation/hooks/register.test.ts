import { test, expect } from 'claude-code/testing'
import { denyText, guidance, hasSource, isDocPath, isResearchTool, readConfig } from './policy'

test('調査ツールの判定', () => {
  expect(isResearchTool('WebFetch')).toBe(true)
  expect(isResearchTool('WebSearch')).toBe(true)
  expect(isResearchTool('mcp__ctxpack-fetch__fetch_page')).toBe(true)
  expect(isResearchTool('mcp__claude-in-chrome__navigate')).toBe(true)
  expect(isResearchTool('Read')).toBe(false)
  expect(isResearchTool('Write')).toBe(false)
})

test('出典 URL の判定', () => {
  expect(hasSource('参考: https://example.com/a')).toBe(true)
  expect(hasSource('[docs](http://example.com)')).toBe(true)
  expect(hasSource('出典は忘れた')).toBe(false)
  expect(hasSource(undefined)).toBe(false)
})

test('対象拡張子と設定の丸め', () => {
  const cfg = readConfig(undefined)
  expect(isDocPath('/a/report.md', cfg)).toBe(true)
  expect(isDocPath('/a/NOTE.TXT', cfg)).toBe(true)
  expect(isDocPath('/a/main.ts', cfg)).toBe(false)
  expect(isDocPath('/a/Makefile', cfg)).toBe(false)
  expect(readConfig({ extensions: ' .MDX, html ,' }).extensions).toEqual(['mdx', 'html'])
  expect(readConfig({ extensions: ' , ' }).extensions).toContain('md')
  expect(guidance).toContain('出典')
  expect(denyText).toContain('出典')
})

test('調査後は出典のない文書の書き込みを拒否する', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const write = (content: string, file_path = '/tmp/report.md') => $.tool.call({ tool: 'Write', file_path, content })

  expect((await write('出典なし')).deny).toBeUndefined()
  await $.tool.call({ tool: 'WebSearch', query: 'x' })
  expect((await write('出典なし')).deny).toContain('出典')
  expect((await write('本文\n出典: https://example.com')).deny).toBeUndefined()
  expect((await write('const a = 1', '/tmp/a.ts')).deny).toBeUndefined()
})
