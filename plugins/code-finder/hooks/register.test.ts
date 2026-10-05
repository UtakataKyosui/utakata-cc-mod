import { test, expect } from 'claude-code/testing'
import { clip, fdArgs, formatResult, guidance, readConfig, rgArgs } from './policy'

test('fd の引数: 種別・拡張子・パターンの区切り', () => {
  expect(fdArgs({ pattern: 'config', extension: ['.ts', 'tsx'], type: 'file', hidden: true, max_depth: 3, path: 'src' })).toEqual([
    'fd', '--color', 'never', '--type', 'f', '--extension', 'ts', '--extension', 'tsx',
    '--hidden', '--max-depth', '3', '--', 'config', 'src',
  ])
  expect(fdArgs({})).toEqual(['fd', '--color', 'never', '--', '.'])
  expect(fdArgs({ pattern: '-rf', glob: true }).slice(-3)).toEqual(['--glob', '--', '-rf'])
})

test('rg の引数: オプション・絞り込み済みファイル', () => {
  const a = rgArgs({ pattern: 'TODO|FIXME', type: 'ts', ignore_case: true, context: 2, glob: '!*.test.ts', path: 'src' })
  expect(a).toContain('--ignore-case')
  expect(a).toContain('--context')
  expect(a.slice(-3)).toEqual(['--', 'TODO|FIXME', 'src'])
  expect(rgArgs({ pattern: 'x', path: 'src' }, ['a.ts', 'b.ts']).slice(-4)).toEqual(['--', 'x', 'a.ts', 'b.ts'])
  expect(rgArgs({ pattern: '-v', files_only: true, context: 3 })).not.toContain('--context')
})

test('件数の切り詰めとメッセージ', () => {
  expect(clip('a\nb\nc\n', 2)).toEqual({ text: 'a\nb', total: 3, clipped: true })
  expect(formatResult('', 10, 'ファイル')).toContain('見つからなかった')
  expect(formatResult('a\nb\nc', 2, '一致')).toContain('全 3 行')
  expect(formatResult('a\nb', 5, '一致')).toBe('a\nb')
})

test('設定の丸めと案内文', () => {
  expect(readConfig(undefined).maxResults).toBe(200)
  expect(readConfig({ maxResults: 99999 }).maxResults).toBe(2000)
  expect(guidance(false, false)).toBeUndefined()
  expect(guidance(true, true)).toContain('file_pattern')
  expect(guidance(false, true)).not.toContain('find_files')
})
