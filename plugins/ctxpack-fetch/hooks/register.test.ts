import { test, expect } from 'claude-code/testing'
import { clipText, ctxpackArgs, guidance, isHttpUrl, readConfig } from './policy'

test('URL は http(s) だけ通す', () => {
  expect(isHttpUrl('https://example.com/docs')).toBe(true)
  expect(isHttpUrl('http://example.com')).toBe(true)
  expect(isHttpUrl('--stats')).toBe(false)
  expect(isHttpUrl('file:///etc/passwd')).toBe(false)
  expect(isHttpUrl('./page.html')).toBe(false)
  expect(isHttpUrl(undefined)).toBe(false)
})

test('ctxpack の引数: query があるときだけ --query を付ける', () => {
  expect(ctxpackArgs({ url: 'https://example.com' })).toEqual(['ctxpack', 'https://example.com'])
  expect(ctxpackArgs({ url: 'https://example.com', query: ' argparse ' })).toEqual([
    'ctxpack', 'https://example.com', '--query', 'argparse',
  ])
  expect(ctxpackArgs({ url: 'https://example.com', query: '  ' })).toEqual(['ctxpack', 'https://example.com'])
})

test('文字数の切り詰めと設定の丸め', () => {
  expect(clipText('abc', 5)).toBe('abc')
  expect(clipText('abcdef', 3)).toContain('全 6 文字')
  expect(readConfig(undefined).maxChars).toBe(60000)
  expect(readConfig({ maxChars: 1 }).maxChars).toBe(1000)
  expect(readConfig({ maxChars: 9e9 }).maxChars).toBe(400000)
  expect(guidance).toContain('fetch_page')
})
