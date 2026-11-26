import { test, expect, type Engine } from 'claude-code/testing'
import { guidance, isBashWrite, isFixRequest, judgeSpec, readSpec } from './policy'

const CONFIRM = 'mcp__clarify-fix-request__confirm_fix_request'

async function submit($: Engine, text: string, kind = 'composer') {
  await $.prompt.submit({ text, wait: false, origin: { kind } } as never)
}

const edit = ($: Engine, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: '/tmp/a.css', old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)

const confirm = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: CONFIRM, ...input } as never)

const spec = {
  quote: 'ボタンの色を赤に変えて',
  target: 'assets/a.css の .button',
  current: '背景色 #333',
  expected: '背景色 #d00',
  unclear: [],
}

function world(on: any) {
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
}

test('修正依頼の判定', () => {
  expect(isFixRequest('ボタンの色を赤に変えて')).toBe(true)
  expect(isFixRequest('サムネイルを 24px に小さくして')).toBe(true)
  expect(isFixRequest('レビューの指摘を対応して')).toBe(true)
  expect(isFixRequest('please fix the header')).toBe(true)
  expect(isFixRequest('git log を見せて')).toBe(false)
  expect(isFixRequest('この関数はどこにある？')).toBe(false)
})

test('Bash の書き込み判定', () => {
  expect(isBashWrite("sed -i '' 's/a/b/' x.css")).toBe(true)
  expect(isBashWrite('echo a > x.txt')).toBe(true)
  expect(isBashWrite('cat <<EOF >> x.md')).toBe(true)
  expect(isBashWrite('git apply p.diff')).toBe(true)
  expect(isBashWrite('ls 2>/dev/null')).toBe(false)
  expect(isBashWrite('grep a b > /dev/null')).toBe(false)
  expect(isBashWrite('cmd 2>&1 | head')).toBe(false)
  expect(isBashWrite('node -e "x => 1"')).toBe(false)
  expect(isBashWrite('git status')).toBe(false)
})

test('記述子の番号を付けたファイルへのリダイレクトも書き込みと判定する', () => {
  expect(isBashWrite('printf changed 1> output.txt')).toBe(true)
  expect(isBashWrite('cat source.txt 1>> output.txt')).toBe(true)
  expect(isBashWrite('cmd 2> err.log')).toBe(true)
  expect(isBashWrite('cmd &> all.log')).toBe(true)
  expect(isBashWrite('echo hi>out.txt')).toBe(true)
  expect(isBashWrite('echo a > "$out"')).toBe(true)
  expect(isBashWrite('cmd >&2')).toBe(false)
  expect(isBashWrite('cmd 1>&2')).toBe(false)
  expect(isBashWrite('cmd &>/dev/null')).toBe(false)
  expect(isBashWrite('diff <(sort a) b')).toBe(false)
})

test('引数やヒアドキュメントの中の語・記号では書き込みと判定しない', () => {
  expect(isBashWrite('cat src/patch.ts')).toBe(false)
  expect(isBashWrite('rg patch src')).toBe(false)
  expect(isBashWrite('rg tee src')).toBe(false)
  expect(isBashWrite('rg "a > b" src')).toBe(false)
  expect(isBashWrite('echo $(cat patch.txt)')).toBe(false)
  expect(isBashWrite("git log --grep 'sed -i'")).toBe(false)
  expect(isBashWrite("cat <<'EOF' | head\na > b\npatch\nEOF")).toBe(false)
  expect(isBashWrite("cat <<'EOF' > x.md\nbody\nEOF")).toBe(true)
})

test('コマンドの位置にある書き込みコマンドを判定する', () => {
  expect(isBashWrite('ls && patch -p1 < p.diff')).toBe(true)
  expect(isBashWrite('FOO=1 sed -i s/a/b/ x')).toBe(true)
  expect(isBashWrite('sudo /usr/bin/sed --in-place=.bak s/a/b/ x')).toBe(true)
  expect(isBashWrite('perl -pi -e s/a/b/ x')).toBe(true)
  expect(isBashWrite('echo a | tee x.txt')).toBe(true)
  expect(isBashWrite('git -C repo apply p.diff')).toBe(true)
  expect(isBashWrite('git checkout -- a.css')).toBe(true)
  expect(isBashWrite('git checkout main')).toBe(false)
  expect(isBashWrite('sed -n 1,10p x')).toBe(false)
})

test('確認ツールの入力の判定', () => {
  const prompt = 'えっと、ボタンの色を 赤に変えて ほしい'
  expect(judgeSpec(readSpec(spec), prompt).ok).toBe(true)
  expect(judgeSpec(readSpec({ ...spec, expected: '' }), prompt).text).toContain('expected')
  expect(judgeSpec(readSpec({ ...spec, quote: '青にして' }), prompt).text).toContain('quote')
  const unclear = judgeSpec(readSpec({ ...spec, unclear: ['どの赤か'] }), prompt)
  expect(unclear.ok).toBe(false)
  expect(unclear.text).toContain('どの赤か')
  expect(guidance).toContain('AskUserQuestion')
})

test('修正依頼の直後は編集を止め、確認ツールで解禁する', async ($, on) => {
  world(on)
  await submit($, 'ボタンの色を赤に変えて')
  expect((await edit($)).deny).toContain('AskUserQuestion')
  expect((await $.tool.call({ tool: 'Bash', command: 'echo a > x.css' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git status' })).deny).toBeUndefined()

  await confirm($, { ...spec, unclear: ['どの赤か'] })
  expect((await edit($)).deny).toBeDefined()

  const r = await confirm($, spec)
  expect(JSON.stringify(r.result)).toContain('確認した修正内容')
  expect((await edit($)).deny).toBeUndefined()
})

test('AskUserQuestion に回答があれば解禁する', async ($, on) => {
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', { tool: /^AskUserQuestion$/ }, () => ({ result: { answers: { 'どの赤？': '#d00' } } }))
  on('tool.call', () => ({ result: 'ok' }))
  await submit($, 'ボタンの色を赤に変えて')
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect((await edit($)).deny).toBeUndefined()
})

test('修正依頼でないプロンプトでは止めず、通知では状態を変えない', async ($, on) => {
  world(on)
  await submit($, 'README を読んで')
  expect((await edit($)).deny).toBeUndefined()

  await submit($, 'ボタンの色を赤に変えて')
  await submit($, 'バックグラウンドのタスクが終わった', 'task-notification')
  expect((await edit($)).deny).toBeDefined()
})

test('サブエージェントの編集には親へ返すよう伝える', async ($, on) => {
  world(on)
  await submit($, 'ボタンの色を赤に変えて')
  expect((await edit($, 'a1')).deny).toContain('親のエージェント')
})
