import { test, expect, mock } from 'claude-code/testing'
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
  buildDiffView,
  buildPrecheckPrompt,
  checkFinding,
  classifyFindings,
  diffArgs,
  formatPrecheck,
  parseDiff,
  precheckGuidance,
  PRECHECK_TOOL,
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

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function f() {',
  '   const x = load()',
  '-  return x',
  '+  if (x === null) return null',
  '+  return x.value',
  ' }',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-gone',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' keep',
  '+added = 1',
  '',
].join('\n')

test('差分を新側の行番号付きで読み、バイナリ・削除は対象外にする', () => {
  const files = parseDiff(DIFF)
  expect(files.map(f => f.path)).toEqual(['src/a.ts', 'img.png', 'old.ts', 'src/b.ts'])
  expect(files[0].hunks[0].lines.map(l => l.line)).toEqual([10, undefined, 11, 12, 13])
  expect(files[1].excluded).toBe('バイナリ')
  expect(files[2].excluded).toContain('削除')
  const view = buildDiffView(files, 10000)
  expect(view.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(view.files[0].ranges).toEqual([[10, 13]])
  expect(view.excluded.map(e => e.path)).toEqual(['img.png', 'old.ts'])
  expect(view.omitted).toEqual([])
})

test('差分は入力の上限で切り詰め、送らなかった範囲を未確認として明示する', () => {
  const files = parseDiff(DIFF)
  const view = buildDiffView(files, 120)
  expect(view.files[0].cut).toBe(true)
  expect(view.files[0].visible.has(13)).toBe(false)
  expect(view.omitted).toEqual(['src/b.ts'])
  const text = formatPrecheck({ model: 'm', command: 'git diff HEAD', view, verified: [], rejected: [], notes: [] })
  expect(text).toContain('src/a.ts: 入力の上限で途中から未送信')
  expect(text).toContain('src/b.ts: 入力の上限で未送信')
  const { prompt } = buildPrecheckPrompt({ request: 'r'.repeat(5000) }, files, 1500)
  expect(prompt.length).toBeLessThan(1500)
  expect(prompt).not.toContain('r'.repeat(1600))
})

test('架空のファイル・範囲外の行・根拠のない引用を除外する', () => {
  const view = buildDiffView(parseDiff(DIFF), 10000)
  const ok = { file: 'src/a.ts', line: 12, quote: 'return x.value', issue: 'null の扱い', evidence: '直前で null を返す分岐がある' }
  expect(checkFinding(ok, view)).toBeUndefined()
  expect(checkFinding({ ...ok, file: 'src/ghost.ts' }, view)).toBe('file_not_in_diff')
  expect(checkFinding({ ...ok, file: 'old.ts' }, view)).toBe('file_not_in_diff')
  expect(checkFinding({ ...ok, line: 99 }, view)).toBe('line_out_of_range')
  expect(checkFinding({ ...ok, quote: 'return y.other' }, view)).toBe('quote_not_found')
  expect(checkFinding({ ...ok, evidence: '' }, view)).toBe('evidence_missing')
  const { verified, rejected } = classifyFindings([ok, { ...ok, file: 'src/ghost.ts' }], view)
  expect(verified).toEqual([ok])
  expect(rejected.map(r => r.reason)).toEqual(['file_not_in_diff'])
  const text = formatPrecheck({ model: 'm', command: 'git diff HEAD', view, verified, rejected, notes: [] })
  expect(text).toContain('参考データ')
  expect(text).toContain('src/ghost.ts:12 (送った差分にないファイル)')
})

test('一次点検の git 引数は固定の読み取りコマンドに限り、オプションの混入を拒否する', () => {
  expect(diffArgs({})).toEqual(['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--'])
  expect(diffArgs({ staged: true })).toEqual(['git', 'diff', '--no-color', '--no-ext-diff', '--staged', '--'])
  expect(diffArgs({ range: 'main...HEAD' })?.slice(-2)).toEqual(['main...HEAD', '--'])
  expect(diffArgs({ range: '--output=/tmp/x' })).toBeUndefined()
  expect(diffArgs({ range: 'HEAD; rm -rf /' })).toBeUndefined()
  expect(diffArgs({ range: '$(id)' })).toBeUndefined()
})

test('一次点検は参考データでありレビュー完了に数えない', () => {
  const cfg = readConfig({})
  const pre = { runs: 2, failed: 1, findings: 3 }
  const text = formatStatus(initialState(), cfg, pre)
  expect(text).toContain('レビュー 0/3 回')
  expect(text).toContain('レビュー未実施')
  expect(text).toContain('一次点検 (ローカルLLM): 成功 2 回 / 失敗 1 回')
  expect(text).toContain('レビューの省略・合格の根拠にしない')
  expect(formatStatus(initialState(), cfg)).toBe(formatStatus(initialState(), cfg, { runs: 0, failed: 0, findings: 0 }))
  expect(precheckGuidance).toContain('レビューの実施に数えない')
})

type Setup = { fetched: string[]; ran: (readonly string[])[]; registered: { name: string }[]; agents: { prompt: string }[] }

const setupLlm = (on: any, content: () => string | undefined, opts: { diff?: string } = {}): Setup => {
  const s: Setup = { fetched: [], ran: [], registered: [], agents: [] }
  mock.clock(on)
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    s.ran.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv.includes('--shortstat') ? ' 5 files changed, 200 insertions(+)' : (opts.diff ?? DIFF), stderr: '' } }
  })
  on('http.fetch', (_$: unknown, e: { init?: { body?: string } }) => {
    s.fetched.push(e.init!.body!)
    const c = content()
    return c === undefined
      ? { value: { ok: false, status: 500, headers: {}, text: '' } }
      : { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ message: { content: c } }) } }
  })
  on('tool.register', (_$: unknown, spec: { name: string }) => (s.registered.push(spec), { value: undefined }))
  on('agent.register', (_$: unknown, spec: { prompt: string }) => (s.agents.push(spec), { value: { agent: 'change-review:reviewer' } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  return s
}

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
const GOOD_JSON = JSON.stringify({
  findings: [
    { file: 'src/a.ts', line: 12, quote: 'return x.value', issue: 'null の扱い', evidence: '直前で null を返す分岐がある' },
    { file: 'src/ghost.ts', line: 1, quote: 'nothing', issue: '架空', evidence: '存在しないファイル' },
  ],
})

test('off ではツールを登録せず、通信もしない (既存の動作のまま)', async ($: any, on: any) => {
  const s = setupLlm(on, () => GOOD_JSON)
  await start($)
  expect(s.registered).toEqual([])
  expect(s.agents[0].prompt).toBe(reviewerPrompt)
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', outputStyle: null, tools: [], traits: [], surfaces: [] })
  expect(composed.sections[0].text).toBe(guidance(readConfig({})))
  const r = await $.tool.call({ tool: PRECHECK_TOOL })
  expect(r.result).toContain('実施されなかった')
  expect(s.fetched).toHaveLength(0)
  expect(s.ran).toHaveLength(0)
})

test('always: 一次点検は候補を検証して返し、レビュー回数には数えない', { options: { llmMode: 'always', maxReReviews: 0 } }, async ($: any, on: any) => {
  const s = setupLlm(on, () => GOOD_JSON)
  on('agent.spawn', () => ({ agentId: 'r1', model: 'sonnet' }))
  await start($)
  expect(s.registered.map(t => t.name)).toEqual(['precheck_diff'])
  expect(s.agents[0].prompt).toContain('未検証の参考データ')

  const r = await $.tool.call({ tool: PRECHECK_TOOL, request: '修正して', acceptance: 'null で落ちない', verification: 'test pass' })
  expect(r.result).toContain('src/a.ts:12 | null の扱い')
  expect(r.result).toContain('src/ghost.ts:1 (送った差分にないファイル)')
  expect(r.result).toContain('原差分の取得: git diff HEAD --')
  expect(s.fetched).toHaveLength(1)
  const body = JSON.parse(s.fetched[0])
  expect(body.messages.map((m: { content: string }) => m.content).join('\n')).toContain('null で落ちない')
  expect(body.tools).toBeUndefined()
  // 実行したのは固定の git diff だけ
  expect(s.ran).toEqual([['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--']])

  const status = (await $.command.run({ command: 'change-review', args: '' })).text
  expect(status).toContain('レビュー 0/1 回')
  expect(status).toContain('レビュー未実施')
  expect(status).toContain('一次点検 (ローカルLLM): 成功 1 回')
  // 一次点検の後も reviewer は初回から起動でき、上限にも影響しない
  expect((await $.agent.spawn({ subagentType: 'change-review:reviewer', prompt: 'x', description: 'x' })).agentId).toBe('r1')
  expect((await $.agent.spawn({ subagentType: 'change-review:reviewer', prompt: 'x', description: 'x' })).deny).toContain('未解決')
})

test('一次点検で指摘なしでもレビュー省略の根拠にならない', { options: { llmMode: 'always' } }, async ($: any, on: any) => {
  setupLlm(on, () => '{"findings":[]}')
  await start($)
  const r = await $.tool.call({ tool: PRECHECK_TOOL })
  expect(r.result).toContain('指摘なしは問題がない証拠ではない')
  const status = (await $.command.run({ command: 'change-review', args: '' })).text
  expect(status).toContain('レビュー未実施')
  expect(status).not.toContain('重大な未解決指摘はない')
})

test('不正な range は git を実行せず、通信もしない', { options: { llmMode: 'always' } }, async ($: any, on: any) => {
  const s = setupLlm(on, () => GOOD_JSON)
  await start($)
  const r = await $.tool.call({ tool: PRECHECK_TOOL, range: '--output=/tmp/x' })
  expect(r.result).toContain('実施されなかった')
  expect(s.ran).toHaveLength(0)
  expect(s.fetched).toHaveLength(0)
})

test('ollama が失敗しても throw せず、既存のレビュー手順を続けるよう返す', { options: { llmMode: 'always' } }, async ($: any, on: any) => {
  const s = setupLlm(on, () => undefined)
  await start($)
  const r = await $.tool.call({ tool: PRECHECK_TOOL })
  expect(r.result).toContain('既存の手順どおり reviewer SubAgent')
  expect(s.fetched.length).toBeGreaterThan(0)
  expect((await $.command.run({ command: 'change-review', args: '' })).text).toContain('失敗 1 回')
})

test('auto: 省略できる小さな変更では通信しない', { options: { llmMode: 'auto' } }, async ($: any, on: any) => {
  const small = 'diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,1 +1,2 @@\n keep\n+x = 1\n'
  const s = setupLlm(on, () => '{"findings":[]}', { diff: small })
  await start($)
  expect((await $.tool.call({ tool: PRECHECK_TOOL })).result).toContain('実施されなかった')
  expect(s.fetched).toHaveLength(0)
})

test('auto: 省略できない規模なら点検する', { options: { llmMode: 'auto', skipMaxLines: 1 } }, async ($: any, on: any) => {
  const s = setupLlm(on, () => '{"findings":[]}')
  await start($)
  expect((await $.tool.call({ tool: PRECHECK_TOOL })).result).toContain('確認範囲')
  expect(s.fetched).toHaveLength(1)
})
