import { test, expect } from 'claude-code/testing'
import { buildPlaybook, mentionsIssue, pickMode, readConfig } from './policy'

test('設定の既定値と不正値の丸め', () => {
  expect(readConfig({})).toEqual({ mode: 'plan', maxLines: 400, maxFiles: 15, maxLayers: 3 })
  expect(readConfig({ mode: 'bogus', maxLines: 99999, maxFiles: 'x', maxLayers: 1 })).toEqual({ mode: 'plan', maxLines: 5000, maxFiles: 15, maxLayers: 2 })
})

test('Issue の実装依頼を検出する', () => {
  expect(mentionsIssue('https://github.com/a/b/issues/12 を実装して')).toBe(true)
  expect(mentionsIssue('Issue #34 に対応して')).toBe(true)
  expect(mentionsIssue('issue 5 をやって')).toBe(true)
  expect(mentionsIssue('#7 のイシューを実装')).toBe(true)
  expect(mentionsIssue('gh stack で PR を作って')).toBe(true)
})

test('無関係なプロンプトとスラッシュコマンドは対象外', () => {
  expect(mentionsIssue('README を直して')).toBe(false)
  expect(mentionsIssue('/goal Issue #3 を実装')).toBe(false)
  expect(mentionsIssue(`${buildPlaybook(readConfig({}))} Issue #3`)).toBe(false)
})

test('手順書に基準と gh stack の手順が入る', () => {
  const text = buildPlaybook(readConfig({ maxLines: 600, maxFiles: 20, maxLayers: 4 }))
  expect(text).toContain('見込み変更行数 600 以上')
  expect(text).toContain('見込み変更ファイル数 20 以上')
  expect(text).toContain('4 つ以上の層')
  expect(text).toContain('gh stack submit --auto')
  expect(text).toContain('見込み変更行数 300 以上')
})

test('進め方は設定が既定で、プロンプトで上書きできる', () => {
  expect(pickMode('Issue #1 を実装', 'plan')).toBe('plan')
  expect(pickMode('Issue #1 を実装', 'after')).toBe('after')
  expect(pickMode('Issue #1 stack:after で', 'plan')).toBe('after')
  expect(pickMode('Issue #1 実装前にスタックを計画して', 'after')).toBe('plan')
  expect(pickMode('Issue #1 実装後にスタックに分割して', 'plan')).toBe('after')
})

test('mode ごとに手順が変わり、共通部分は残る', () => {
  const plan = buildPlaybook(readConfig({}), 'plan')
  const after = buildPlaybook(readConfig({}), 'after')
  expect(plan).toContain('実装前にスタックを計画する')
  expect(plan).toContain('gh stack init <最下層ブランチ>')
  expect(after).toContain('実装後にスタックへ分割する')
  expect(after).toContain('git branch <層1のブランチ>')
  for (const text of [plan, after]) {
    expect(text).toContain('「変更範囲が大きい」の基準')
    expect(text).toContain('gh stack submit --auto')
    expect(text).toContain('守ること')
  }
  expect(buildPlaybook(readConfig({ mode: 'after' }))).toContain('実装後にスタックへ分割する')
})

const echo = ($: any, on: any) =>
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({
    text: e.text,
    context: e.context,
  }))

test('Issue を含むプロンプトに手順書が context で付く', async ($, on) => {
  echo($, on)
  const hit = await $.prompt.submit({ text: 'Issue #12 を実装して' })
  expect(hit.context?.[0]).toContain('<stack-pr-playbook>')

  const forced = await $.prompt.submit({ text: 'Issue #12 を実装して stack:after' })
  expect(forced.context?.[0]).toContain('実装後にスタックへ分割する')

  const miss = await $.prompt.submit({ text: 'テストを実行して' })
  expect(miss.context).toBeUndefined()
})
