import { test, expect, mock } from 'claude-code/testing'
import {
  NARROW_MAX_PICK, clip, fdArgs, formatNarrowed, formatResult, guidance, narrowCandidates, narrowPrompt, purposeOf, readConfig, rgArgs,
  shouldNarrow, validPick,
} from './policy'

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

test('LLM 設定は既定で off、purpose と raw は rg の引数に影響しない', () => {
  expect(readConfig(undefined).llm.mode).toBe('off')
  expect(readConfig({ llmMode: 'AUTO', maxInputChars: 1 }).llm).toMatchObject({ mode: 'auto', maxInputChars: 500 })
  const base = { pattern: 'x', path: 'src', context: 1 }
  expect(rgArgs({ ...base, purpose: '認証の入口', raw: true })).toEqual(rgArgs(base))
  expect(purposeOf({ pattern: 'x', purpose: ' 認証 ' })).toBe('認証')
  expect(purposeOf({ pattern: 'x', purpose: '認証', raw: true })).toBeUndefined()
  expect(purposeOf({ pattern: 'x', purpose: '  ' })).toBeUndefined()
  expect(purposeOf({ pattern: 'x' })).toBeUndefined()
})

const RESULT = ['a.ts:1:const login = 1', 'b.ts:2:const loginAll = 2', 'c.ts:3:// login helper', 'd.ts:4:login()']
const STATS = { total: 4, clipped: false, maxResults: 200, maxInputChars: 12000 }

test('候補の検証: 存在しない ID・範囲外・重複・0 件・多すぎる選択は拒否する', () => {
  const cands = narrowCandidates(RESULT.join('\n'))
  expect(cands.map(c => c.text)).toEqual(RESULT)
  expect(validPick([1, 4], cands)).toBe(true)
  expect(validPick([5], cands)).toBe(false)
  expect(validPick([0], cands)).toBe(false)
  expect(validPick([2, 2], cands)).toBe(false)
  expect(validPick([], cands)).toBe(false)
  expect(validPick(['1'], cands)).toBe(false)
  expect(validPick('1', cands)).toBe(false)
  const many = narrowCandidates(Array.from({ length: NARROW_MAX_PICK + 1 }, (_, i) => `f.ts:${i + 1}:x`).join('\n'))
  expect(validPick(many.map(c => c.id), many)).toBe(false)
})

test('絞り込み結果: 原文の行を元の順序で並べ、除外件数・上限・切り詰めの有無を明示する', () => {
  const cands = narrowCandidates(RESULT.join('\n'))
  const out = formatNarrowed(cands, [4, 1], STATS)
  expect(out.split('\n').slice(0, 2)).toEqual([RESULT[0], RESULT[3]])
  expect(out).toContain('4 行のうち 2 行を返した (除外 2 行')
  expect(out).toContain(`返却上限 ${NARROW_MAX_PICK} 行`)
  expect(out).toContain('入力上限 12000 文字')
  expect(out).toContain('検索自体の切り詰め: なし')
  expect(out).toContain('raw: true')
  expect(formatNarrowed(cands, [1], { ...STATS, total: 900, clipped: true, maxResults: 200 })).toContain('全 900 行のうち先頭 200 行だけ')
  expect(narrowPrompt('認証', 'login', cands)).toContain('[2] b.ts:2:const loginAll = 2')
})

test('auto の条件は結果の規模だけで決まる', () => {
  expect(shouldNarrow(narrowCandidates(RESULT.join('\n')))).toBe(false)
  expect(shouldNarrow(narrowCandidates(Array.from({ length: 30 }, (_, i) => `f.ts:${i}:x`).join('\n')))).toBe(true)
  expect(shouldNarrow(narrowCandidates(`a.ts:1:${'x'.repeat(3000)}`))).toBe(true)
})

type Fetched = { body: { messages: { content: string }[] } }

const setup = (on: any, rg: string, reply: (prompt: string) => string | undefined) => {
  mock.clock(on)
  const prompts: string[] = []
  const argvs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    argvs.push(e.argv)
    return { value: { exitCode: rg === '' ? 1 : 0, stdout: rg, stderr: '' } }
  })
  on('http.fetch', (_$: unknown, e: { init?: { body?: string } }) => {
    const prompt = (JSON.parse(e.init!.body!) as Fetched['body']).messages.at(-1)!.content
    prompts.push(prompt)
    const content = reply(prompt)
    return content === undefined
      ? { value: { ok: false, status: 500, headers: {}, text: '' } }
      : { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ message: { content } }) } }
  })
  on('ui.log', () => ({ value: undefined }))
  return { prompts, argvs }
}

const search = ($: any, input: object) => $.tool.call({ tool: 'mcp__code-finder__search_code', pattern: 'login', ...input })
const BIG = Array.from({ length: 40 }, (_, i) => `src/m${i}.ts:${i + 1}:const login${i} = ${i}`)
const ALWAYS = { options: { llmMode: 'always' } }
const AUTO = { options: { llmMode: 'auto' } }

test('off: purpose があっても通信せず、既存の検索結果をそのまま返す', async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[1]}')
  const r = await search($, { purpose: '認証の入口' })
  expect(r.result).toBe(BIG.join('\n'))
  expect(prompts).toHaveLength(0)
})

test('always: 選ばれた ID の行だけを検索結果の原文から返す', ALWAYS, async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[40,3]}')
  const r = await search($, { purpose: '認証の入口' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('調査目的: 認証の入口')
  expect(r.result.split('\n').slice(0, 2)).toEqual([BIG[2], BIG[39]])
  expect(r.result).toContain('候補 40 行のうち 2 行を返した (除外 38 行')
  expect(r.result).toContain('検索自体の切り詰め: なし')
})

test('関連箇所が結果の末尾にあっても選べる。似た名前の無関係な候補は含めない', ALWAYS, async ($: any, on: any) => {
  const rg = ['src/loginLog.ts:1:logLogin()', 'src/loginLogger.ts:2:class LoginLogger {}', 'src/auth.ts:10:function login(user) {']
  setup(on, rg.join('\n'), () => '{"ids":[3]}')
  const r = await search($, { purpose: 'ログイン処理の本体' })
  expect(r.result.split('\n')[0]).toBe(rg[2])
  expect(r.result).not.toContain('LoginLogger')
})

test('LLM が書き換えた引用や理由は結果に入らない', ALWAYS, async ($: any, on: any) => {
  setup(on, BIG.join('\n'), () => '{"ids":[2],"quote":"src/evil.ts:1:改変","reason":"勝手な説明"}')
  const r = await search($, { purpose: '目的' })
  expect(r.result.split('\n')[0]).toBe(BIG[1])
  expect(r.result).not.toContain('evil')
  expect(r.result).not.toContain('勝手な説明')
})

test('不正な選択 (存在しない ID・重複・空) は既存の結果に戻る', ALWAYS, async ($: any, on: any) => {
  let reply = ''
  const { prompts } = setup(on, BIG.join('\n'), () => reply)
  for (const bad of ['{"ids":[99]}', '{"ids":[1,1]}', '{"ids":[]}', '{"ids":["a"]}', 'not json']) {
    reply = bad
    const r = await search($, { purpose: '目的' })
    expect(r.result.startsWith(BIG.join('\n'))).toBe(true)
    expect(r.result).toContain('絞り込みは行わず')
    expect(prompts.length).toBeGreaterThan(0)
  }
})

test('ollama の失敗・入力上限超過でも既存の結果に戻り、throw しない', ALWAYS, async ($: any, on: any) => {
  setup(on, BIG.join('\n'), () => undefined)
  const failed = await search($, { purpose: '目的' })
  expect(failed.result.startsWith(BIG.join('\n'))).toBe(true)
  expect(failed.result).toContain('絞り込みは行わず')
})

test('入力上限を超える結果は送らず、既存の結果に戻る', { options: { llmMode: 'always', maxInputChars: 500 } }, async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[1]}')
  const r = await search($, { purpose: '目的' })
  expect(prompts).toHaveLength(0)
  expect(r.result.startsWith(BIG.join('\n'))).toBe(true)
  expect(r.result).toContain('input_too_large')
})

test('auto: 小規模な結果は LLM を呼ばず既存の結果をそのまま返し、大規模なら絞り込む', AUTO, async ($: any, on: any) => {
  const small = setup(on, RESULT.join('\n'), () => '{"ids":[1]}')
  expect((await search($, { purpose: '目的' })).result).toBe(RESULT.join('\n'))
  expect(small.prompts).toHaveLength(0)
})

test('auto: 大規模な結果は絞り込む', AUTO, async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[5]}')
  const r = await search($, { purpose: '目的' })
  expect(prompts).toHaveLength(1)
  expect(r.result.split('\n')[0]).toBe(BIG[4])
})

test('raw: true や purpose なしでは絞り込まない', ALWAYS, async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[1]}')
  expect((await search($, { purpose: '目的', raw: true })).result).toBe(BIG.join('\n'))
  expect((await search($, {})).result).toBe(BIG.join('\n'))
  expect(prompts).toHaveLength(0)
})

test('検索自体の切り詰め (maxResults) と LLM による除外を区別して伝える', { options: { llmMode: 'always', maxResults: 10 } }, async ($: any, on: any) => {
  const { prompts } = setup(on, BIG.join('\n'), () => '{"ids":[10]}')
  const r = await search($, { purpose: '目的' })
  expect(prompts[0]).toContain('[10] ')
  expect(prompts[0]).not.toContain('[11] ')
  expect(r.result.split('\n')[0]).toBe(BIG[9])
  expect(r.result).toContain('全 40 行のうち先頭 10 行だけ')
  expect(r.result).toContain('除外 9 行')
})

test('一致なしは purpose があっても LLM を呼ばない', ALWAYS, async ($: any, on: any) => {
  const { prompts } = setup(on, '', () => '{"ids":[1]}')
  expect((await search($, { purpose: '目的' })).result).toContain('見つからなかった')
  expect(prompts).toHaveLength(0)
})
