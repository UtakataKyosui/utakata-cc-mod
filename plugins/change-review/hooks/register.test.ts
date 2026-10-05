import { test, expect } from 'claude-code/testing'
import {
  exceeded,
  formatStatus,
  guidance,
  initialState,
  isMutatingBash,
  judgeSkip,
  parseReport,
  parseShortstat,
  readConfig,
  reportNote,
  reviewerPrompt,
} from './policy'

const GOOD = [
  '- [major] src/a.ts:12 | null を返す経路で呼び出し元が落ちる | 根拠: b.ts:30 が戻り値をそのまま参照している',
  '- [nit] src/a.ts:40-42 | 変数名が紛らわしい | 根拠: 同ファイルの user と混同しやすい',
  '確認範囲: git diff 全体、b.ts の呼び出し元',
  '判定: 要修正',
].join('\n')

test('設定の既定値と丸め', () => {
  const cfg = readConfig({ skipMaxFiles: 999, skipMaxLines: -5, maxReReviews: 1.7 })
  expect(cfg).toEqual({ skipMaxFiles: 100, skipMaxLines: 0, maxReviews: 2 })
  expect(readConfig(undefined)).toEqual({ skipMaxFiles: 2, skipMaxLines: 30, maxReviews: 3 })
})

test('指摘の形式検証', () => {
  const ok = parseReport(GOOD)
  expect(ok.problems).toEqual([])
  expect(ok.findings.map(f => f.severity)).toEqual(['major', 'nit'])
  expect(ok.findings[0].location).toBe('src/a.ts:12')
  expect(reportNote(ok)).toBe('')

  const bad = parseReport(['- [major] 全体的にエラー処理が弱い', '- [minor] a.ts:3 | 命名 | 根拠: 一般論', '判定: 要修正'].join('\n'))
  expect(bad.findings).toEqual([])
  expect(bad.problems.some(p => p.startsWith('形式に合わない指摘'))).toBe(true)
  expect(bad.problems).toContain('「確認範囲:」の行がない')
  expect(reportNote(bad)).toContain('[change-review]')

  expect(parseReport('確認範囲: 差分全体').problems).toContain('「判定: 指摘なし」または「判定: 要修正」の行がない')
  expect(parseReport('確認範囲: 差分全体\n判定: 指摘なし').problems).toEqual([])
  const contradict = parseReport(GOOD.replace('要修正', '指摘なし'))
  expect(contradict.problems.some(p => p.includes('blocker/major'))).toBe(true)
})

test('小さな変更はレビューを省略できる', () => {
  const cfg = readConfig({})
  expect(parseShortstat(' 3 files changed, 20 insertions(+), 5 deletions(-)')).toEqual({ files: 3, lines: 25 })
  expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, lines: 1 })
  expect(judgeSkip({ files: 2, lines: 30 }, cfg).skip).toBe(true)
  expect(judgeSkip({ files: 3, lines: 5 }, cfg).skip).toBe(false)
  expect(judgeSkip({ files: 1, lines: 31 }, cfg).skip).toBe(false)
  expect(judgeSkip({ files: 0, lines: 0 }, cfg).skip).toBe(true)
  expect(judgeSkip({ files: 1, lines: 1 }, readConfig({ skipMaxFiles: 0 })).skip).toBe(false)
})

test('未実施・未解決・上限を完了報告用に明示する', () => {
  const cfg = readConfig({ maxReReviews: 1 })
  expect(formatStatus(initialState(), cfg)).toContain('レビュー未実施')
  expect(formatStatus({ ...initialState(), skipped: '小さな変更' }, cfg)).toContain('レビュー省略: 小さな変更')
  expect(formatStatus({ reviews: 1, severe: 2, skipped: undefined }, cfg)).toContain('未解決の重大指摘')
  expect(formatStatus({ reviews: 1, severe: undefined, skipped: undefined }, cfg)).toContain('形式検証に通っていない')
  expect(formatStatus({ reviews: 1, severe: 0, skipped: undefined }, cfg)).toContain('重大な未解決指摘はない')
  expect(exceeded({ reviews: 1, severe: 0, skipped: undefined }, cfg)).toBe(false)
  expect(formatStatus({ reviews: 2, severe: 1, skipped: undefined }, cfg)).toContain('上限に達している')
  expect(guidance(cfg)).toContain('未解決の重大指摘')
  expect(guidance(cfg)).toContain('再確認')
  expect(reviewerPrompt).toContain('読み取り専用')
})

test('読み取り専用でない Bash を見分ける', () => {
  expect(isMutatingBash('git diff HEAD~1')).toBe(false)
  expect(isMutatingBash('git log --oneline | head')).toBe(false)
  expect(isMutatingBash('grep -rn foo src 2>&1')).toBe(false)
  expect(isMutatingBash('rm -rf dist')).toBe(true)
  expect(isMutatingBash('echo x > a.txt')).toBe(true)
  expect(isMutatingBash('sed -i s/a/b/ f')).toBe(true)
  expect(isMutatingBash('git commit -m x')).toBe(true)
  expect(isMutatingBash('npm install foo')).toBe(true)
})

test('レビュアーを読み取り専用で登録し、システムプロンプトに指針を足す', async ($: any, on: any) => {
  const specs: { name: string; tools: string[]; disallowedTools: string[] }[] = []
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.register', (_$: unknown, spec: any) => (specs.push(spec), { value: { agent: `change-review:${spec.name}` } }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(specs.map(s => s.name)).toEqual(['reviewer'])
  expect(specs[0].disallowedTools).toContain('Edit')
  expect(specs[0].tools).not.toContain('Write')
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', outputStyle: null, tools: [], traits: [], surfaces: [] })
  expect(composed.sections.some((s: { id: string }) => s.id === 'change-review:guidance')).toBe(true)
})

test('再レビュー回数の上限を超えたレビュアーの起動を拒否する', { options: { maxReReviews: 1 } }, async ($: any, on: any) => {
  let n = 0
  on('agent.spawn', () => ({ agentId: `r${++n}`, model: 'sonnet' }))
  const spawn = () => $.agent.spawn({ subagentType: 'change-review:reviewer', prompt: 'review', description: 'review' })
  expect((await spawn()).agentId).toBe('r1')
  expect((await spawn()).agentId).toBe('r2')
  expect((await spawn()).deny).toContain('未解決')
  const other = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'x' })
  expect(other.deny).toBeUndefined()
})

test('レビュアーの報告に不備があれば注記し、編集系のツールを拒否する', async ($: any, on: any) => {
  on('agent.spawn', () => ({ agentId: 'r1', model: 'sonnet' }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.agent.spawn({ subagentType: 'change-review:reviewer', prompt: 'review', description: 'review' })

  const done = await $.turn.complete({ answer: '- [major] 弱い', agentId: 'r1', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
  expect(done.text).toContain('[change-review]')
  const ok = await $.turn.complete({ answer: GOOD, agentId: 'r1', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
  expect(ok.text).not.toContain('[change-review]')

  const edit = await $.tool.call({ tool: 'Edit', file_path: '/tmp/a', old_string: 'a', new_string: 'b', agentId: 'r1' })
  expect(edit.deny).toContain('読み取り専用')
  const bash = await $.tool.call({ tool: 'Bash', command: 'rm -rf x', agentId: 'r1' })
  expect(bash.deny).toContain('読み取り専用')
  const read = await $.tool.call({ tool: 'Bash', command: 'git diff', agentId: 'r1' })
  expect(read.deny).toBeUndefined()
  const main = await $.tool.call({ tool: 'Edit', file_path: '/tmp/a', old_string: 'a', new_string: 'b' })
  expect(main.deny).toBeUndefined()
})
