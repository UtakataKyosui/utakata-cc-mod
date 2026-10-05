import { test, expect } from 'claude-code/testing'
import {
  apiArgs, buildProperties, clipText, formatPages, guidance, markdownBody, normalizeId, queryBody, readConfig, richText, sameTitle,
  searchBody, snapshotName, summarizePage, titlePropertyName, toPropertyValue,
} from './policy'

const ID = '3d26285e-fd22-801e-9174-000b98258a86'

test('ID は URL・32 桁・ダッシュ付きのいずれからも揃える', () => {
  expect(normalizeId(ID)).toBe(ID)
  expect(normalizeId('3d26285efd22801e9174000b98258a86')).toBe(ID)
  expect(normalizeId('https://www.notion.so/ws/Title-3d26285efd22801e9174000b98258a86?v=0123456789abcdef0123456789abcdef')).toBe(ID)
  expect(normalizeId(`https://www.notion.so/${ID.toUpperCase()}#frag`)).toBe(ID)
  expect(normalizeId('not an id')).toBeUndefined()
  expect(normalizeId(undefined)).toBeUndefined()
})

test('設定の丸め', () => {
  expect(readConfig(undefined)).toEqual({ databaseId: undefined, maxChars: 30000, maxPages: 5 })
  expect(readConfig({ databaseId: ` ${ID} `, maxChars: 1, maxPages: 999 })).toEqual({ databaseId: ID, maxChars: 1000, maxPages: 50 })
  expect(readConfig({ databaseId: '' }).databaseId).toBeUndefined()
})

test('ntn api の引数と本文', () => {
  expect(apiArgs('v1/pages', 'POST', true)).toEqual(['ntn', 'api', 'v1/pages', '-X', 'POST', '-d', '@-'])
  expect(apiArgs('v1/pages/x', 'GET', false)).toEqual(['ntn', 'api', 'v1/pages/x', '-X', 'GET'])
  expect(searchBody(' ', 500)).toEqual({ filter: { property: 'object', value: 'page' }, page_size: 100 })
  expect(searchBody('rust', 10, 'c1')).toMatchObject({ query: 'rust', page_size: 10, start_cursor: 'c1' })
  expect(queryBody({ limit: 20 }).sorts).toEqual([{ timestamp: 'last_edited_time', direction: 'descending' }])
  expect(queryBody({ filter: { a: 1 }, sorts: [], limit: 5, cursor: 'c' })).toEqual({ filter: { a: 1 }, sorts: [], page_size: 5, start_cursor: 'c' })
})

const schema = {
  名前: { type: 'title' },
  タグ: { type: 'multi_select' },
  種別: { type: 'select' },
  確認日: { type: 'date' },
  済: { type: 'checkbox' },
  点数: { type: 'number' },
  メモ: { type: 'rich_text' },
  更新: { type: 'last_edited_time' },
}

test('プロパティ値の変換', () => {
  expect(titlePropertyName(schema)).toBe('名前')
  expect(buildProperties(schema, { タグ: 'a, b', 種別: 'メモ', 確認日: '2026-10-06/2026-10-07', 済: 'true', 点数: '3', メモ: null })).toEqual({
    タグ: { multi_select: [{ name: 'a' }, { name: 'b' }] },
    種別: { select: { name: 'メモ' } },
    確認日: { date: { start: '2026-10-06', end: '2026-10-07' } },
    済: { checkbox: true },
    点数: { number: 3 },
    メモ: { rich_text: [] },
  })
  expect(toPropertyValue('種別', 'select', null)).toEqual({ select: null })
  expect(() => buildProperties(schema, { ない: 'x' })).toThrow('使えるのは')
  expect(() => buildProperties(schema, { 更新: 'x' })).toThrow('読み取り専用')
  expect(() => buildProperties(schema, { 点数: 'abc' })).toThrow('数値')
  expect(() => buildProperties(schema, { 済: 'yes' })).toThrow('true / false')
})

test('rich_text は 2000 文字で分ける', () => {
  expect(richText('a'.repeat(4500)).map(t => t.text.content.length)).toEqual([2000, 2000, 500])
})

test('本文更新のリクエストは子の削除を許可しない', () => {
  expect(markdownBody('append', { content: 'x' })).toEqual({ type: 'insert_content', insert_content: { content: 'x', position: { type: 'end' } } })
  expect(markdownBody('replace', { content: 'x' })).toEqual({ type: 'replace_content', replace_content: { new_str: 'x', allow_deleting_content: false } })
  expect(markdownBody('edit', { edits: [{ old_str: 'a', new_str: 'b', replace_all: true }, { old_str: 'c', new_str: 'd' }] })).toEqual({
    type: 'update_content',
    update_content: {
      content_updates: [{ old_str: 'a', new_str: 'b', replace_all_matches: true }, { old_str: 'c', new_str: 'd' }],
      allow_deleting_content: false,
    },
  })
})

test('題名の同一判定と整形', () => {
  expect(sameTitle('Ｒｕｓｔ  入門 ', 'rust 入門')).toBe(true)
  expect(sameTitle('Rust', 'Rust 入門')).toBe(false)
  const page = {
    id: ID,
    url: 'https://notion.so/x',
    last_edited_time: '2026-10-05T00:00:00.000Z',
    properties: {
      名前: { type: 'title', title: [{ plain_text: 'Rust' }, { plain_text: '入門' }] },
      タグ: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
      空: { type: 'select', select: null },
    },
  }
  expect(summarizePage(page)).toEqual({ id: ID, url: 'https://notion.so/x', title: 'Rust入門', edited: '2026-10-05T00:00:00.000Z', props: [['タグ', 'a, b']] })
  expect(formatPages([], false)).toContain('見つからなかった')
  expect(formatPages([summarizePage(page)], true)).toContain('まだ続きがある')
  expect(clipText('abcdef', 3)).toContain('全 6 文字')
  expect(snapshotName('2026-10-06T01:02:03.456Z', ID)).toBe(`2026-10-06T01-02-03-456Z-${ID}.md`)
  expect(guidance).toContain('record_knowledge')
})

type Call = { argv: readonly string[]; stdin: string | undefined }

const setup = (on: any, respond: (argv: readonly string[], stdin: string | undefined) => { exitCode?: number; stdout?: string; stderr?: string }) => {
  const calls: Call[] = []
  const writes: Record<string, string> = {}
  on('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const r = respond(e.argv, e.init?.stdin)
    return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes[e.path] = e.text
    return { value: undefined }
  })
  return { calls, writes }
}

const DS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const DB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const dsJson = JSON.stringify({ object: 'data_source', title: [{ plain_text: 'ナレッジ' }], properties: { 名前: { type: 'title' }, タグ: { type: 'multi_select' } } })
const dbJson = JSON.stringify({ object: 'database', data_sources: [{ id: DS, name: 'ナレッジ' }] })
const path = (argv: readonly string[]) => argv[2] ?? ''

test('record_knowledge: 同じ題名があれば作らず、なければ data source に作る', async ($: any, on: any) => {
  let existing: object[] = [{ object: 'page', id: ID, url: 'u', last_edited_time: 't', properties: { 名前: { type: 'title', title: [{ plain_text: 'Rust 入門' }] } } }]
  const { calls } = setup(on, argv => {
    if (path(argv) === `v1/databases/${DB}`) return { stdout: dbJson }
    if (path(argv) === `v1/data_sources/${DS}`) return { stdout: dsJson }
    if (path(argv) === `v1/data_sources/${DS}/query`) return { stdout: JSON.stringify({ results: existing }) }
    if (path(argv) === 'v1/pages') return { stdout: JSON.stringify({ id: 'new-id', url: 'new-url' }) }
    return { exitCode: 1, stderr: 'unexpected' }
  })
  const record = (title: string) =>
    $.tool.call({ tool: 'mcp__notion-knowledge__record_knowledge', title, content: '本文', properties: { タグ: ['a'] }, database_id: DB })

  const dup = await record('ｒｕｓｔ 入門')
  expect(dup.result).toContain('作成していない')
  expect(calls.some(c => path(c.argv) === 'v1/pages')).toBe(false)

  existing = []
  const created = await record('新しい知識')
  expect(created.result).toContain('new-id')
  const post = calls.find(c => path(c.argv) === 'v1/pages')!
  expect(post.argv).toContain('@-')
  expect(JSON.parse(post.stdin!)).toEqual({
    parent: { type: 'data_source_id', data_source_id: DS },
    properties: { タグ: { multi_select: [{ name: 'a' }] }, 名前: { title: [{ text: { content: '新しい知識' } }] } },
    markdown: '本文',
  })
})

test('record_knowledge: 存在しないプロパティと複数 data source は書き込み前に止める', async ($: any, on: any) => {
  let sources: object[] = [{ id: DS }, { id: DB, name: '別' }]
  const { calls } = setup(on, argv => {
    if (path(argv) === `v1/databases/${DB}`) return { stdout: JSON.stringify({ data_sources: sources }) }
    if (path(argv) === `v1/data_sources/${DS}`) return { stdout: dsJson }
    return { exitCode: 1, stderr: 'unexpected' }
  })
  const multi = await $.tool.call({ tool: 'mcp__notion-knowledge__record_knowledge', title: 't', database_id: DB })
  expect(multi.deny).toContain('data_source_id で選ぶ')

  sources = [{ id: DS }]
  const bad = await $.tool.call({ tool: 'mcp__notion-knowledge__record_knowledge', title: 't', database_id: DB, properties: { ない: 'x' } })
  expect(bad.deny).toContain('存在しない')
  expect(calls.some(c => path(c.argv) === 'v1/pages')).toBe(false)
})

test('revise_knowledge: replace は退避してから置換し、入力が足りなければ書き込まない', async ($: any, on: any) => {
  const { calls, writes } = setup(on, argv => {
    if (argv[1] === 'pages') return { stdout: '---\n名前: x\n---\n旧本文' }
    if (path(argv) === `v1/pages/${ID}/markdown`) return { stdout: JSON.stringify({ markdown: '新本文', unknown_block_ids: [] }) }
    return { exitCode: 1, stderr: 'unexpected' }
  })
  const revise = (input: object) => $.tool.call({ tool: 'mcp__notion-knowledge__revise_knowledge', page_id: ID, ...input })

  expect((await revise({})).deny).toContain('properties か mode')
  expect((await revise({ mode: 'replace' })).deny).toContain('content が必要')
  expect((await revise({ mode: 'edit', edits: [{ old_str: '', new_str: 'x' }] })).deny).toContain('old_str')
  expect(calls).toHaveLength(0)

  const r = await revise({ mode: 'replace', content: '新本文' })
  expect(r.deny).toBeUndefined()
  expect(r.result).toContain('全文を置換した')
  expect(Object.keys(writes).sort()).toEqual([
    expect.stringMatching(/^\/proj\/\.claude\/notion-snapshots\/.*\.md$/),
    '/proj/.claude/notion-snapshots/.gitignore',
  ].sort())
  expect(Object.values(writes)).toContain('---\n名前: x\n---\n旧本文')
  const patch = calls.find(c => path(c.argv) === `v1/pages/${ID}/markdown`)!
  expect(JSON.parse(patch.stdin!).replace_content.allow_deleting_content).toBe(false)
  // 退避 (pages get) が置換 (PATCH) より先
  expect(calls.findIndex(c => c.argv[1] === 'pages')).toBeLessThan(calls.indexOf(patch))
})

test('revise_knowledge: 退避に失敗したら置換しない', async ($: any, on: any) => {
  const { calls } = setup(on, argv => (argv[1] === 'pages' ? { exitCode: 1, stderr: 'boom' } : { stdout: '{}' }))
  const r = await $.tool.call({ tool: 'mcp__notion-knowledge__revise_knowledge', page_id: ID, mode: 'replace', content: 'x' })
  expect(r.deny).toContain('boom')
  expect(calls.some(c => path(c.argv).endsWith('/markdown'))).toBe(false)
})

test('find_knowledge: データベース未指定ならワークスペース検索、指定なら題名の部分一致で続きも辿る', async ($: any, on: any) => {
  const row = (n: number) => ({ object: 'page', id: `id-${n}`, url: 'u', last_edited_time: 't', properties: { 名前: { type: 'title', title: [{ plain_text: `p${n}` }] } } })
  const { calls } = setup(on, (argv, stdin) => {
    if (path(argv) === 'v1/search') return { stdout: JSON.stringify({ results: [row(0)], has_more: false }) }
    if (path(argv) === `v1/databases/${DB}`) return { stdout: dbJson }
    if (path(argv) === `v1/data_sources/${DS}`) return { stdout: dsJson }
    if (path(argv) === `v1/data_sources/${DS}/query`) {
      const first = JSON.parse(stdin!).start_cursor === undefined
      return { stdout: JSON.stringify(first ? { results: [row(1)], has_more: true, next_cursor: 'c2' } : { results: [row(2)], has_more: false }) }
    }
    return { exitCode: 1, stderr: 'unexpected' }
  })
  const ws = await $.tool.call({ tool: 'mcp__notion-knowledge__find_knowledge', query: 'p' })
  expect(ws.result).toContain('p0')
  expect(JSON.parse(calls[0]!.stdin!).filter).toEqual({ property: 'object', value: 'page' })

  const db = await $.tool.call({ tool: 'mcp__notion-knowledge__find_knowledge', query: 'p', database_id: DB })
  expect(db.result).toContain('2 件')
  const queries = calls.filter(c => path(c.argv) === `v1/data_sources/${DS}/query`)
  expect(queries).toHaveLength(2)
  expect(JSON.parse(queries[0]!.stdin!).filter).toEqual({ property: '名前', title: { contains: 'p' } })
  expect(JSON.parse(queries[1]!.stdin!).start_cursor).toBe('c2')
})

test('ntn の失敗は deny で返す', async ($: any, on: any) => {
  setup(on, () => ({ exitCode: 1, stderr: 'unauthorized' }))
  expect((await $.tool.call({ tool: 'mcp__notion-knowledge__read_knowledge', page_id: ID })).deny).toContain('unauthorized')
  expect((await $.tool.call({ tool: 'mcp__notion-knowledge__read_knowledge', page_id: 'zzz' })).deny).toContain('page_id')
})
