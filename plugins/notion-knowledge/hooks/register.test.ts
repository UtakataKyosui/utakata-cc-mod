import { test, expect, mock } from 'claude-code/testing'
import {
  apiArgs, buildContext, buildDuplicatePrompt, buildRecordPrompt, buildSelectPrompt, clipText, formatCatalog, isTrivial,
  looksSensitive, normalizeId, parseRecord, parseSelection, readConfig, richText, sameTitle, toEntry,
} from './policy'

const ID = '3d26285e-fd22-801e-9174-000b98258a86'

test('ID は URL・32 桁・ダッシュ付きのいずれからも揃える', () => {
  expect(normalizeId(ID)).toBe(ID)
  expect(normalizeId('3d26285efd22801e9174000b98258a86')).toBe(ID)
  expect(normalizeId('https://www.notion.so/ws/Title-3d26285efd22801e9174000b98258a86?v=0123456789abcdef0123456789abcdef')).toBe(ID)
  expect(normalizeId(`https://www.notion.so/${ID.toUpperCase()}#frag`)).toBe(ID)
  expect(normalizeId('not an id')).toBeUndefined()
})

test('設定の既定値と丸め', () => {
  const d = readConfig(undefined)
  expect(d).toMatchObject({ databaseId: undefined, autoRecord: true, models: ['tev1:4b'], timeoutMs: 40000, catalogSize: 100, maxPages: 3 })
  expect(readConfig({ databaseId: ID, autoRecord: false, models: ' a, b ,', catalogSize: 9999, maxPages: 0, ollamaUrl: 'http://h:1/' })).toMatchObject({
    databaseId: ID, autoRecord: false, models: ['a', 'b'], catalogSize: 300, maxPages: 1, ollamaUrl: 'http://h:1',
  })
})

test('ntn api の引数と補助関数', () => {
  expect(apiArgs('v1/pages', 'POST', true)).toEqual(['ntn', 'api', 'v1/pages', '-X', 'POST', '-d', '@-'])
  expect(apiArgs('v1/pages/x', 'GET', false)).toEqual(['ntn', 'api', 'v1/pages/x', '-X', 'GET'])
  expect(richText('a'.repeat(4500)).map(t => t.text.content.length)).toEqual([2000, 2000, 500])
  expect(sameTitle('Ｒｕｓｔ  入門 ', 'rust 入門')).toBe(true)
  expect(sameTitle('Rust', 'Rust 入門')).toBe(false)
  expect(clipText('abcdef', 3)).toContain('全 6 文字')
})

const page = (id: string, title: string, tags: string[] = []) => ({
  object: 'page',
  id,
  url: `https://notion.so/${id}`,
  properties: {
    名前: { type: 'title', title: [{ plain_text: title }] },
    タグ: { type: 'multi_select', multi_select: tags.map(name => ({ name })) },
    種別: { type: 'select', select: { name: '手順' } },
  },
})

test('一覧は番号で見せ、選択結果は範囲内の重複しない番号だけ通す', () => {
  const entries = [toEntry(page('a', 'Rust 入門', ['Rust'])), toEntry(page('b', 'Notion メモ'))]
  expect(entries[0]).toMatchObject({ id: 'a', title: 'Rust 入門', hint: 'Rust, 手順' })
  expect(formatCatalog(entries)).toBe('[1] Rust 入門 (Rust, 手順)\n[2] Notion メモ (手順)')
  expect(formatCatalog([])).toBe('(なし)')
  expect(parseSelection('{"relevant":[2,2,0,9,1.5,"1",1]}', 2, 3)).toEqual([1, 0])
  expect(parseSelection('{"relevant":[1,2]}', 2, 1)).toEqual([0])
  expect(parseSelection('not json', 2, 3)).toEqual([])
  expect(buildSelectPrompt('依頼', entries, 3)).toContain('[2] Notion メモ')
  expect(buildRecordPrompt('依頼', '回答', entries)).toContain('回答')
  expect(buildDuplicatePrompt('題', '本文', entries)).toContain('題名: 題')
})

test('記録の判断は検証を通ったものだけ採用する', () => {
  const body = 'x'.repeat(80)
  expect(parseRecord(JSON.stringify({ action: 'create', target: 0, title: ' 題名 ', content: body }), 3)).toEqual({ action: 'create', title: '題名', content: body })
  expect(parseRecord(JSON.stringify({ action: 'create', target: 0, title: '', content: body }), 3).action).toBe('none')
  expect(parseRecord(JSON.stringify({ action: 'create', target: 0, title: 't', content: '短い' }), 3).action).toBe('none')
  expect(parseRecord(JSON.stringify({ action: 'append', target: 2, title: '', content: body }), 3)).toEqual({ action: 'append', target: 1, content: body })
  expect(parseRecord(JSON.stringify({ action: 'append', target: 4, title: '', content: body }), 3).action).toBe('none')
  expect(parseRecord('{', 3).action).toBe('none')
})

test('秘密情報らしいものと短い入力は対象外', () => {
  expect(looksSensitive('token: abcdef123456')).toBe(true)
  expect(looksSensitive('key sk-abcdefghijklmnopqrstu')).toBe(true)
  expect(looksSensitive('ghp_abcdefghijklmnopqrstuvwx')).toBe(true)
  expect(looksSensitive('data source の使い方')).toBe(false)
  expect(isTrivial('/goal x', 3)).toBe(true)
  expect(isTrivial('hi', 8)).toBe(true)
  expect(isTrivial('Rust の借用について', 8)).toBe(false)
  expect(buildContext([{ title: 'A', url: 'u', body: 'x'.repeat(100) }], 1000)).toContain('### A')
})

const DS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const DB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CATALOG = [page('p1', 'Notion API の data source 移行メモ', ['Notion']), page('p2', 'Rust の借用', ['Rust'])]

type Call = { argv: readonly string[]; stdin: string | undefined }

const setup = (on: any, models: (prompt: string) => string, opts: { catalog?: object[]; modelOk?: boolean } = {}) => {
  const clock = mock.clock(on)
  const calls: Call[] = []
  const toasts: string[] = []
  const asked: string[] = []
  on('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[1] === 'whoami') return out('me')
    if (e.argv[1] === 'pages') return out(`本文 of ${e.argv[3]}`)
    const p = e.argv[2]
    if (p === `v1/databases/${DB}`) return out(JSON.stringify({ data_sources: [{ id: DS }] }))
    if (p === `v1/data_sources/${DS}`) return out(JSON.stringify({ properties: { 名前: { type: 'title' } } }))
    if (p === `v1/data_sources/${DS}/query`) return out(JSON.stringify({ results: JSON.parse(e.init!.stdin!).filter === undefined ? (opts.catalog ?? CATALOG) : [] }))
    if (p === 'v1/pages' || p?.endsWith('/markdown')) return out('{}')
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected ${p}` } }
  })
  on('http.fetch', (_$: unknown, e: { init?: { body?: string } }) => {
    if (opts.modelOk === false) return { value: { ok: false, status: 500, headers: {}, text: '' } }
    const content = JSON.parse(e.init!.body!).messages[0].content as string
    asked.push(content)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ message: { content: models(content) } }) } }
  })
  on('ui.toast', (_$: unknown, e: { text?: string; message?: string }) => {
    toasts.push(e.text ?? e.message ?? '')
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  return { clock, calls, toasts, asked }
}

const OPTS = { options: { databaseId: DB } }
const writes = (calls: Call[]) => calls.filter(c => c.argv[2] === 'v1/pages' || c.argv[2]?.endsWith('/markdown'))
const complete = ($: any, answer: string, extra: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra })

test('プロンプトに関係するナレッジを tev に選ばせ、本文を context に添付する', OPTS, async ($: any, on: any) => {
  const { toasts, asked } = setup(on, () => '{"relevant":[1]}')
  const r = await $.prompt.submit({ text: 'databases の query が 404 になる' })
  expect(asked[0]).toContain('[1] Notion API の data source 移行メモ')
  expect(r.context?.[0]).toContain('本文 of p1')
  expect(r.context?.[0]).toContain('### Notion API の data source 移行メモ')
  expect(toasts.join()).toContain('1 件のナレッジを添付')
})

test('該当なし・短い入力・コマンド・割り込み中の送信では何も添付しない', OPTS, async ($: any, on: any) => {
  const { asked } = setup(on, () => '{"relevant":[]}')
  expect((await $.prompt.submit({ text: 'databases の query が 404 になる' })).context).toBeUndefined()
  expect(asked).toHaveLength(1)
  await $.prompt.submit({ text: 'おはよう' })
  await $.prompt.submit({ text: '/goal 長い目標の文面です' })
  await $.prompt.submit({ text: '割り込みの長い文面です', turnId: 't1' })
  expect(asked).toHaveLength(1)
})

test('database 未設定なら何もしない', async ($: any, on: any) => {
  const { calls, asked } = setup(on, () => '{"relevant":[1]}')
  expect((await $.prompt.submit({ text: '長い文面のプロンプトです' })).context).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(asked).toHaveLength(0)
})

test('ollama が失敗してもプロンプトはそのまま通り、失敗後はしばらく問い合わせない', OPTS, async ($: any, on: any) => {
  const { calls } = setup(on, () => '{}', { modelOk: false })
  const fetches = () => calls.filter(c => c.argv[2] === `v1/data_sources/${DS}/query`).length
  expect((await $.prompt.submit({ text: '長い文面のプロンプトです' })).context).toBeUndefined()
  expect((await $.prompt.submit({ text: '二つ目の長い文面です' })).context).toBeUndefined()
  expect(fetches()).toBe(1)
})

test('記録: 新しい知識は tev の判断で新規ページになり、秘密情報は書かれない', OPTS, async ($: any, on: any) => {
  const body = '- data_sources[] の id を取り、POST /v1/data_sources/{id}/query を呼ぶ\n- [0] を決め打ちしない'
  const decide = (prompt: string) =>
    prompt.startsWith('新しく記録しようとしている')
      ? '{"relevant":[]}'
      : prompt.startsWith('あなたはナレッジ記録係')
        ? JSON.stringify({ action: 'create', target: 0, title: 'Notion の query 手順', content: body })
        : '{"relevant":[]}'
  const { clock, calls, toasts } = setup(on, decide)

  await $.prompt.submit({ text: 'database の query 方法を調べて' })
  await complete($, 'あ'.repeat(300))
  await clock.advance(10)

  const [post] = writes(calls)
  expect(post!.argv[2]).toBe('v1/pages')
  expect(JSON.parse(post!.stdin!)).toMatchObject({
    parent: { type: 'data_source_id', data_source_id: DS },
    properties: { 名前: { title: [{ text: { content: 'Notion の query 手順' } }] } },
  })
  expect(JSON.parse(post!.stdin!).markdown).toContain(body)
  expect(toasts.join()).toContain('新規に記録した')
})

test('記録: 既存と同じ話題なら新規作成せず追記し、none・秘密情報・サブエージェントは書かない', OPTS, async ($: any, on: any) => {
  const body = '- 具体的な事実を十分な長さで書いた追記内容。keep_alive を 0 にすると応答直後にアンロードされる。既定は 5 分で、環境変数 OLLAMA_KEEP_ALIVE でも指定できる'
  let mode: 'create' | 'none' | 'secret' = 'create'
  const { clock, calls } = setup(on, prompt => {
    if (prompt.startsWith('新しく記録しようとしている')) return '{"relevant":[1]}'
    if (mode === 'none') return JSON.stringify({ action: 'none', target: 0, title: '', content: '' })
    return JSON.stringify({ action: 'create', target: 0, title: '新題', content: mode === 'secret' ? `token: abcdef123456 ${body}` : body })
  })

  await $.prompt.submit({ text: '最初の長い質問の文面です' })
  await complete($, 'あ'.repeat(300))
  await clock.advance(10)
  const [patch] = writes(calls)
  expect(patch!.argv[2]).toBe('v1/pages/p1/markdown')
  expect(JSON.parse(patch!.stdin!).insert_content.content).toContain('### 新題')
  expect(JSON.parse(patch!.stdin!).insert_content.position).toEqual({ type: 'end' })

  mode = 'none'
  await $.prompt.submit({ text: '二つ目の長い質問の文面です' })
  await complete($, 'あ'.repeat(300))
  mode = 'secret'
  await $.prompt.submit({ text: '三つ目の長い質問の文面です' })
  await complete($, 'あ'.repeat(300))
  await $.prompt.submit({ text: '四つ目の長い質問の文面です' })
  await complete($, 'あ'.repeat(300), { agentId: 'sub' })
  await complete($, '短い回答')
  await clock.advance(10)
  expect(writes(calls)).toHaveLength(1)
})
