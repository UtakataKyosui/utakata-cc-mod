export type Config = { databaseId: string | undefined; maxChars: number; maxPages: number }

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

export const readConfig = (options: Record<string, unknown> | undefined): Config => {
  const id = typeof options?.databaseId === 'string' ? normalizeId(options.databaseId) : undefined
  return {
    databaseId: id,
    maxChars: clamp(options?.maxChars, 30000, 1000, 200000),
    maxPages: clamp(options?.maxPages, 5, 1, 50),
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi

/** URL・32 桁の 16 進数・ダッシュ付き UUID のいずれからも、ダッシュ付き UUID を取り出す。 */
export const normalizeId = (input: unknown): string | undefined => {
  if (typeof input !== 'string') return undefined
  // `?v=` 以降はビューの ID なので、ページ・データベースの ID とは別に切り落とす
  const path = input.trim().split(/[?#]/)[0] ?? ''
  const dashed = path.match(UUID)
  if (dashed !== null) return dashed[dashed.length - 1]!.toLowerCase()
  const hex = path.match(HEX32)
  if (hex === null) return undefined
  const h = hex[hex.length - 1]!.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** `ntn api` の argv。本文は stdin から渡す (`-d` に改行入りの JSON を直接渡すと ntn が固まる)。 */
export const apiArgs = (path: string, method: 'GET' | 'POST' | 'PATCH', hasBody: boolean): string[] => [
  'ntn', 'api', path, '-X', method, ...(hasBody ? ['-d', '@-'] : []),
]

export const pagesGetArgs = (pageId: string): string[] => ['ntn', 'pages', 'get', pageId]

export type NotionProperty = { type: string; name?: string; [k: string]: unknown }
export type Schema = Record<string, NotionProperty>

export const titlePropertyName = (schema: Schema): string | undefined =>
  Object.entries(schema).find(([, p]) => p.type === 'title')?.[0]

export const searchBody = (query: string | undefined, limit: number, cursor?: string) => ({
  filter: { property: 'object', value: 'page' },
  ...(query === undefined || query.trim() === '' ? {} : { query: query.trim() }),
  page_size: Math.min(100, limit),
  ...(cursor === undefined ? {} : { start_cursor: cursor }),
})

export const queryBody = (opts: { filter?: unknown; sorts?: unknown; limit: number; cursor?: string }) => ({
  ...(opts.filter === undefined ? {} : { filter: opts.filter }),
  sorts: opts.sorts ?? [{ timestamp: 'last_edited_time', direction: 'descending' }],
  page_size: Math.min(100, opts.limit),
  ...(opts.cursor === undefined ? {} : { start_cursor: opts.cursor }),
})

export const titleContains = (titleProp: string, text: string) => ({ property: titleProp, title: { contains: text } })

export const normalizeTitle = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** タイトルに揺れがあっても同じ題名として扱う。 */
export const sameTitle = (a: string, b: string): boolean => normalizeTitle(a) === normalizeTitle(b)

/** rich_text 1 要素の上限は 2000 文字。 */
export const richText = (text: string): { text: { content: string } }[] => {
  const chunks: { text: { content: string } }[] = []
  for (let i = 0; i < text.length; i += 2000) chunks.push({ text: { content: text.slice(i, i + 2000) } })
  return chunks
}

const READ_ONLY = new Set([
  'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'verification', 'button',
])

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(s => s !== '') : [String(v)]

/** 平易な値を、プロパティの型に合わせた Notion の値に変える。null は値のクリア。 */
export const toPropertyValue = (name: string, type: string, value: unknown): unknown => {
  if (READ_ONLY.has(type)) throw new Error(`プロパティ「${name}」(${type}) は読み取り専用で書き込めない`)
  const bad = (hint: string): never => {
    throw new Error(`プロパティ「${name}」(${type}) の値が不正: ${hint}`)
  }
  if (value === null) {
    if (type === 'title') return bad('title は空にできない')
    if (type === 'rich_text') return { rich_text: [] }
    if (type === 'multi_select') return { multi_select: [] }
    if (type === 'relation') return { relation: [] }
    if (type === 'files') return { files: [] }
    if (type === 'people') return { people: [] }
    return { [type]: null }
  }
  switch (type) {
    case 'title':
    case 'rich_text':
      return { [type]: richText(String(value)) }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? { number: n } : bad('数値を渡す')
    }
    case 'select':
    case 'status':
      return { [type]: { name: String(value) } }
    case 'multi_select':
      return { multi_select: asList(value).map(name => ({ name })) }
    case 'checkbox':
      return value === true || value === 'true' ? { checkbox: true } : value === false || value === 'false' ? { checkbox: false } : bad('true / false を渡す')
    case 'date': {
      const [start, end] = String(value).split('/')
      return { date: { start: start!.trim(), ...(end === undefined || end.trim() === '' ? {} : { end: end.trim() }) } }
    }
    case 'url':
    case 'email':
    case 'phone_number':
      return { [type]: String(value) }
    case 'relation':
      return {
        relation: asList(value).map(v => {
          const id = normalizeId(v)
          return id === undefined ? bad(`関連先のページ ID が読み取れない: ${v}`) : { id }
        }),
      }
    default:
      return bad('この型は未対応')
  }
}

/** { プロパティ名: 平易な値 } をスキーマに照らして Notion の properties にする。 */
export const buildProperties = (schema: Schema, values: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const prop = schema[name]
    if (prop === undefined) throw new Error(`プロパティ「${name}」は存在しない。使えるのは: ${Object.keys(schema).join(', ')}`)
    out[name] = toPropertyValue(name, prop.type, value)
  }
  return out
}

type Rich = { plain_text?: string }[]
const plain = (r: unknown): string => (Array.isArray(r) ? (r as Rich).map(t => t.plain_text ?? '').join('') : '')

/** 一覧表示用に、プロパティの値を 1 行の文字列にする。空なら undefined。 */
export const showProperty = (p: any): string | undefined => {
  const v = p?.[p?.type]
  switch (p?.type) {
    case 'title':
    case 'rich_text':
      return plain(v) || undefined
    case 'select':
    case 'status':
      return v?.name
    case 'multi_select':
      return v?.length ? v.map((o: { name: string }) => o.name).join(', ') : undefined
    case 'number':
    case 'url':
    case 'email':
    case 'phone_number':
      return v === null || v === undefined ? undefined : String(v)
    case 'checkbox':
      return v === true ? 'true' : 'false'
    case 'date':
      return v?.start === undefined ? undefined : v.end ? `${v.start} → ${v.end}` : v.start
    case 'people':
      return v?.length ? v.map((u: { name?: string; id: string }) => u.name ?? u.id).join(', ') : undefined
    case 'relation':
      return v?.length ? `${v.length} 件` : undefined
    case 'created_time':
    case 'last_edited_time':
      return typeof v === 'string' ? v : undefined
    default:
      return undefined
  }
}

export type PageSummary = { id: string; url: string; title: string; edited: string; props: [string, string][] }

export const summarizePage = (page: any): PageSummary => {
  const props: [string, string][] = []
  let title = ''
  for (const [name, p] of Object.entries<any>(page?.properties ?? {})) {
    if (p?.type === 'title') title = plain(p.title)
    else {
      const s = showProperty(p)
      if (s !== undefined) props.push([name, s])
    }
  }
  return { id: page?.id ?? '', url: page?.url ?? '', title, edited: page?.last_edited_time ?? '', props }
}

export const formatPages = (pages: readonly PageSummary[], more: boolean): string => {
  if (pages.length === 0) return '該当するページは見つからなかった。'
  const lines = pages.flatMap(p => [
    `- ${p.title || '(無題)'}`,
    `  id: ${p.id}`,
    `  url: ${p.url}`,
    `  更新: ${p.edited}`,
    ...p.props.map(([k, v]) => `  ${k}: ${v.length > 120 ? `${v.slice(0, 120)}…` : v}`),
  ])
  return [`${pages.length} 件${more ? ' (まだ続きがある。query や filter を絞るか limit を増やす)' : ''}`, ...lines].join('\n')
}

export const formatSchema = (schema: Schema): string =>
  Object.entries(schema)
    .map(([name, p]) => {
      const options = ((p[p.type] as { options?: { name: string }[] } | undefined)?.options ?? []).map(o => o.name)
      return `- ${name} (${p.type})${options.length > 0 ? `: ${options.join(' / ')}` : ''}`
    })
    .join('\n')

export type ContentMode = 'append' | 'edit' | 'replace'
export type Edit = { old_str: string; new_str: string; replace_all?: boolean }

/** `PATCH /v1/pages/{id}/markdown` の本文。子ページ・子データベースの削除は常に許可しない。 */
export const markdownBody = (mode: ContentMode, input: { content?: string; edits?: readonly Edit[] }): object => {
  switch (mode) {
    case 'append':
      return { type: 'insert_content', insert_content: { content: input.content ?? '', position: { type: 'end' } } }
    case 'replace':
      return { type: 'replace_content', replace_content: { new_str: input.content ?? '', allow_deleting_content: false } }
    case 'edit':
      return {
        type: 'update_content',
        update_content: {
          content_updates: (input.edits ?? []).map(e => ({
            old_str: e.old_str,
            new_str: e.new_str,
            ...(e.replace_all === true ? { replace_all_matches: true } : {}),
          })),
          allow_deleting_content: false,
        },
      }
  }
}

export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n... 全 ${text.length} 文字のうち先頭 ${max} 文字のみ。`

export const snapshotName = (iso: string, pageId: string): string => `${iso.replace(/[:.]/g, '-')}-${pageId}.md`

export const SNAPSHOT_DIR = '.claude/notion-snapshots'

export const guidance = [
  'Notion のナレッジベースが使える。次のツールで読み書きする。',
  '- mcp__notion-knowledge__find_knowledge: 記録済みの知識を探す (title の部分一致、filter、sorts)',
  '- mcp__notion-knowledge__read_knowledge: ページ本文を Markdown で読む',
  '- mcp__notion-knowledge__knowledge_schema: データベースのプロパティ (名前・型・選択肢) を調べる',
  '- mcp__notion-knowledge__record_knowledge: 新しいページを作る。同じ題名があれば作らず既存を返す',
  '- mcp__notion-knowledge__revise_knowledge: 既存ページのプロパティと本文 (append / edit / replace) を更新する',
  '使い方の方針:',
  '- 調べ物や設計判断に入る前に、find_knowledge で既存の知識を確認し、関係するページは read_knowledge で読んでから答える',
  '- 次のような、後で役に立つ知識が得られたら記録する: 決定とその理由、原因を突き止めた不具合、自明でない罠や制約、調査の結論',
  '- 作る前に find_knowledge で同じ話題がないか確認する。あれば record_knowledge ではなく revise_knowledge で追記・修正する',
  '- 記録には根拠 (出典の URL、確認したコマンドや日付) を添える。推測は推測と書く',
  '- 一時的なメモ、会話の経緯、コードを読めば分かることは記録しない',
].join('\n')
