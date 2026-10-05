import type { Register } from 'claude-code'
import {
  type Config, type ContentMode, type Edit, type Schema,
  SNAPSHOT_DIR, apiArgs, buildProperties, clipText, formatPages, formatSchema, guidance, markdownBody, normalizeId,
  pagesGetArgs, queryBody, readConfig, richText, sameTitle, searchBody, snapshotName, summarizePage, titleContains,
  titlePropertyName,
} from './policy'

const FIND = 'mcp__notion-knowledge__find_knowledge'
const SCHEMA = 'mcp__notion-knowledge__knowledge_schema'
const READ = 'mcp__notion-knowledge__read_knowledge'
const RECORD = 'mcp__notion-knowledge__record_knowledge'
const REVISE = 'mcp__notion-knowledge__revise_knowledge'

const TIMEOUT_MS = 60_000

type DbInput = { database_id?: string; data_source_id?: string }

let available: Promise<boolean> | undefined

function hasNtn($: any): Promise<boolean> {
  available ??= $.process
    .run(['ntn', 'whoami'], { stdin: '', timeoutMs: 15_000 })
    .then((r: { exitCode: number }) => r.exitCode === 0)
    .catch(() => false)
  return available as Promise<boolean>
}

const errorText = (r: { stderr: string; stdout: string; exitCode: number }): string =>
  clipText(r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`, 600)

/** ntn api を呼び、JSON を返す。本文は stdin から渡す。 */
async function api($: any, path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<any> {
  const r = await $.process.run(apiArgs(path, method, body !== undefined), {
    stdin: body === undefined ? '' : JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
  })
  if (r.exitCode !== 0) throw new Error(`ntn api ${method} ${path} が失敗: ${errorText(r)}`)
  let json: any
  try {
    json = JSON.parse(r.stdout)
  } catch {
    throw new Error(`ntn api ${method} ${path} の応答が JSON ではない: ${clipText(r.stdout, 300)}`)
  }
  if (json?.object === 'error') throw new Error(`Notion API エラー (${json.code}): ${json.message}`)
  return json
}

async function pageMarkdown($: any, pageId: string): Promise<string> {
  const r = await $.process.run(pagesGetArgs(pageId), { stdin: '', timeoutMs: TIMEOUT_MS })
  if (r.exitCode !== 0) throw new Error(`ntn pages get が失敗: ${errorText(r)}`)
  return r.stdout
}

const requirePageId = (v: unknown): string => {
  const id = normalizeId(v)
  if (id === undefined) throw new Error('page_id が読み取れない。ページの URL か ID を渡すこと')
  return id
}

/** データベースから data source を 1 つに決める。複数あるときは候補を示して止める。 */
async function dataSourceOfDatabase($: any, databaseId: string): Promise<string> {
  const db = await api($, `v1/databases/${databaseId}`, 'GET')
  const sources: { id: string; name?: string }[] = db.data_sources ?? []
  if (sources.length === 1) return sources[0]!.id
  if (sources.length === 0) throw new Error(`データベース ${databaseId} に data source がない`)
  throw new Error(
    `データベース ${databaseId} は data source を複数持つ。data_source_id で選ぶこと:\n${sources
      .map(s => `- ${s.name ?? '(無名)'}: ${s.id}`)
      .join('\n')}`,
  )
}

async function dataSourceOf($: any, input: DbInput, cfg: Config, required: true): Promise<string>
async function dataSourceOf($: any, input: DbInput, cfg: Config, required: false): Promise<string | undefined>
async function dataSourceOf($: any, input: DbInput, cfg: Config, required: boolean): Promise<string | undefined> {
  if (input.data_source_id !== undefined) {
    const id = normalizeId(input.data_source_id)
    if (id === undefined) throw new Error('data_source_id が読み取れない')
    return id
  }
  const databaseId = input.database_id === undefined ? cfg.databaseId : normalizeId(input.database_id)
  if (input.database_id !== undefined && databaseId === undefined) throw new Error('database_id が読み取れない')
  if (databaseId === undefined) {
    if (required) throw new Error('対象のデータベースが決まらない。database_id を渡すか、プラグイン設定の databaseId を指定すること')
    return undefined
  }
  return dataSourceOfDatabase($, databaseId)
}

async function schemaOf($: any, dataSourceId: string): Promise<{ schema: Schema; titleProp: string; name: string }> {
  const ds = await api($, `v1/data_sources/${dataSourceId}`, 'GET')
  const schema = (ds.properties ?? {}) as Schema
  const titleProp = titlePropertyName(schema)
  if (titleProp === undefined) throw new Error(`data source ${dataSourceId} にタイトル列がない`)
  const name = Array.isArray(ds.title) ? ds.title.map((t: { plain_text?: string }) => t.plain_text ?? '').join('') : ''
  return { schema, titleProp, name }
}

const asInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

/** ツールの失敗は deny として返す。 */
const guarded = (fn: () => Promise<string>): Promise<{ result: string } | { deny: string }> =>
  fn().then(
    result => ({ result }),
    (e: unknown) => ({ deny: e instanceof Error ? e.message : String(e) }),
  )

const NOTION_PROPS_NOTE =
  'プロパティは { "名前": 値 } で渡す。値は型に合わせる: select / status は文字列、multi_select は文字列の配列、number は数値、checkbox は真偽値、date は "2026-10-06" または "開始/終了"、url / email は文字列、relation はページ ID の配列。null でクリア。'

const DB_PROPERTIES = {
  database_id: { type: 'string', description: '対象データベースの ID または URL。省略するとプラグイン設定の databaseId' },
  data_source_id: { type: 'string', description: 'data source の ID。データベースが複数の data source を持つときに指定する' },
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    if (await hasNtn($)) {
      await $.tool.register({
        name: 'find_knowledge',
        description:
          'Notion のナレッジベースから記録済みのページを探す。query は題名の部分一致。filter / sorts は Notion の data source クエリの形式。データベースが決まらないときはワークスペース全体を題名で検索する。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '題名に含まれる文字列' },
            ...DB_PROPERTIES,
            filter: { type: 'object', description: 'Notion のフィルタ (例: {"property":"タグ","multi_select":{"contains":"Rust"}})。指定すると query より優先する' },
            sorts: { type: 'array', description: 'Notion のソート。省略すると更新日時の新しい順' },
            limit: { type: 'number', description: '返す件数の上限 (既定 20、最大 200)' },
          },
        },
      })
      await $.tool.register({
        name: 'knowledge_schema',
        description: 'ナレッジのデータベースのプロパティ (名前・型・選択肢) を返す。filter の組み立てや properties の指定の前に使う。',
        inputSchema: { type: 'object', properties: { ...DB_PROPERTIES } },
      })
      await $.tool.register({
        name: 'read_knowledge',
        description: 'Notion のページを、プロパティ付きの Markdown として読む。',
        inputSchema: {
          type: 'object',
          properties: { page_id: { type: 'string', description: 'ページの ID または URL' } },
          required: ['page_id'],
        },
      })
      await $.tool.register({
        name: 'record_knowledge',
        description:
          'ナレッジのデータベースに新しいページを作る。同じ題名のページがすでにあれば作らず、既存のページを返す (その場合は revise_knowledge で更新する)。',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'ページの題名' },
            content: { type: 'string', description: '本文 (Markdown)' },
            properties: { type: 'object', description: NOTION_PROPS_NOTE },
            ...DB_PROPERTIES,
          },
          required: ['title'],
        },
      })
      await $.tool.register({
        name: 'revise_knowledge',
        description:
          '既存のページを更新する。properties でプロパティを、mode で本文を変える。mode: append は末尾に追記、edit は edits の old_str を new_str に置換 (old_str は本文と完全一致し、1 か所だけに一致すること)、replace は本文を全文置換 (事前に .claude/notion-snapshots/ へ退避する)。子ページ・子データベースの削除はしない。',
        inputSchema: {
          type: 'object',
          properties: {
            page_id: { type: 'string', description: 'ページの ID または URL' },
            properties: { type: 'object', description: NOTION_PROPS_NOTE },
            mode: { type: 'string', enum: ['append', 'edit', 'replace'] },
            content: { type: 'string', description: 'append / replace で書く Markdown' },
            edits: {
              type: 'array',
              description: 'edit の置換指定',
              items: {
                type: 'object',
                properties: {
                  old_str: { type: 'string' },
                  new_str: { type: 'string' },
                  replace_all: { type: 'boolean', description: '複数箇所に一致してもすべて置換する' },
                },
                required: ['old_str', 'new_str'],
              },
            },
          },
          required: ['page_id'],
        },
      })
    }
    return next(e)
  })

  on('tool.call', { tool: FIND }, async ($, e, next) => {
    const input = e as unknown as DbInput & { query?: string; filter?: unknown; sorts?: unknown; limit?: number }
    return guarded(async () => {
      const limit = asInt(input.limit, 20, 1, 200)
      const query = typeof input.query === 'string' ? input.query.trim() : undefined
      const dsId = await dataSourceOf($, input, cfg, false)

      let fetchPage: (cursor: string | undefined, remaining: number) => Promise<any>
      if (dsId === undefined) {
        fetchPage = (cursor, remaining) => api($, 'v1/search', 'POST', searchBody(query, remaining, cursor))
      } else {
        const filter =
          input.filter ?? (query === undefined || query === '' ? undefined : titleContains((await schemaOf($, dsId)).titleProp, query))
        fetchPage = (cursor, remaining) =>
          api($, `v1/data_sources/${dsId}/query`, 'POST', queryBody({ filter, sorts: input.sorts, limit: remaining, ...(cursor === undefined ? {} : { cursor }) }))
      }

      const pages: any[] = []
      let more = false
      let cursor: string | undefined
      for (let i = 0; i < cfg.maxPages && pages.length < limit; i++) {
        const res = await fetchPage(cursor, limit - pages.length)
        pages.push(...(res.results ?? []).filter((p: { object?: string }) => p.object === 'page'))
        cursor = res.next_cursor ?? undefined
        more = res.has_more === true && cursor !== undefined
        if (!more) break
      }
      return formatPages(pages.slice(0, limit).map(summarizePage), more)
    })
  })

  on('tool.call', { tool: SCHEMA }, async ($, e, next) => {
    const input = e as unknown as DbInput
    return guarded(async () => {
      const dsId = await dataSourceOf($, input, cfg, true)
      const { schema, titleProp, name } = await schemaOf($, dsId)
      return [`データソース: ${name || '(無題)'} (${dsId})`, `タイトル列: ${titleProp}`, formatSchema(schema)].join('\n')
    })
  })

  on('tool.call', { tool: READ }, async ($, e, next) => {
    const input = e as unknown as { page_id?: string }
    return guarded(async () => clipText(await pageMarkdown($, requirePageId(input.page_id)), cfg.maxChars))
  })

  on('tool.call', { tool: RECORD }, async ($, e, next) => {
    const input = e as unknown as DbInput & { title?: string; content?: string; properties?: Record<string, unknown> }
    return guarded(async () => {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      if (title === '') throw new Error('title is required')
      const dsId = await dataSourceOf($, input, cfg, true)
      const { schema, titleProp } = await schemaOf($, dsId)
      const properties = buildProperties(schema, Object.fromEntries(Object.entries(input.properties ?? {}).filter(([k]) => k !== titleProp)))

      const found = await api($, `v1/data_sources/${dsId}/query`, 'POST', queryBody({ filter: titleContains(titleProp, title), limit: 100 }))
      const same = (found.results ?? []).map(summarizePage).filter((p: { title: string }) => sameTitle(p.title, title))
      if (same.length > 0) {
        return `同じ題名のページがすでにあるため、作成していない。内容を足すなら revise_knowledge を使うこと。\n${formatPages(same, false)}`
      }

      try {
        const page = await api($, 'v1/pages', 'POST', {
          parent: { type: 'data_source_id', data_source_id: dsId },
          properties: { ...properties, [titleProp]: { title: richText(title) } },
          ...(input.content === undefined || input.content === '' ? {} : { markdown: input.content }),
        })
        return `作成した: ${title}\nid: ${page.id}\nurl: ${page.url}`
      } catch (err) {
        throw new Error(`${(err as Error).message}\n作成の API に冪等キーはなく、失敗に見えても作られている場合がある。再試行の前に find_knowledge で同じ題名のページを確認すること。`)
      }
    })
  })

  on('tool.call', { tool: REVISE }, async ($, e, next) => {
    const input = e as unknown as {
      page_id?: string
      properties?: Record<string, unknown>
      mode?: ContentMode
      content?: string
      edits?: Edit[]
    }
    return guarded(async () => {
      const pageId = requirePageId(input.page_id)
      const hasProps = input.properties !== undefined && Object.keys(input.properties).length > 0
      const mode = input.mode
      if (mode === undefined && !hasProps) throw new Error('properties か mode のどちらかが必要')
      if (mode !== undefined && !['append', 'edit', 'replace'].includes(mode)) throw new Error('mode は append / edit / replace のいずれか')
      if ((mode === 'append' || mode === 'replace') && (typeof input.content !== 'string' || input.content === '')) {
        throw new Error(`mode: ${mode} には content が必要`)
      }
      if (mode === 'edit' && (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.some(x => typeof x.old_str !== 'string' || x.old_str === '' || typeof x.new_str !== 'string'))) {
        throw new Error('mode: edit には、old_str が空でない edits が必要')
      }

      // 書き込みの前に、プロパティを検証して Notion の形にしておく
      let properties: Record<string, unknown> | undefined
      if (hasProps) {
        const page = await api($, `v1/pages/${pageId}`, 'GET')
        const parent = page.parent ?? {}
        const dsId: string | undefined =
          parent.type === 'data_source_id' ? parent.data_source_id : parent.type === 'database_id' ? await dataSourceOfDatabase($, parent.database_id) : undefined
        if (dsId === undefined) throw new Error('このページはデータベースの行ではないため、プロパティは更新できない')
        properties = buildProperties((await schemaOf($, dsId)).schema, input.properties!)
      }

      const done: string[] = []
      try {
        if (mode !== undefined) {
          let snapshot: string | undefined
          if (mode === 'replace') {
            const dir = `${await $.session.root()}/${SNAPSHOT_DIR}`
            const before = await pageMarkdown($, pageId)
            if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
            snapshot = `${dir}/${snapshotName(new Date().toISOString(), pageId)}`
            await $.fs.write(snapshot, before)
          }
          const res = await api($, `v1/pages/${pageId}/markdown`, 'PATCH', markdownBody(mode, input))
          done.push(`本文: ${mode === 'append' ? '末尾に追記した' : mode === 'replace' ? '全文を置換した' : `${input.edits!.length} 件の置換を適用した`}`)
          if (snapshot !== undefined) done.push(`退避: ${snapshot}`)
          if (Array.isArray(res.unknown_block_ids) && res.unknown_block_ids.length > 0) {
            done.push(`注意: API が読み取れないブロックが ${res.unknown_block_ids.length} 件ある`)
          }
        }
        if (properties !== undefined) {
          await api($, `v1/pages/${pageId}`, 'PATCH', { properties })
          done.push(`プロパティ: ${Object.keys(properties).join(', ')} を更新した`)
        }
      } catch (err) {
        throw new Error(`${(err as Error).message}${done.length > 0 ? `\nここまでに完了: ${done.join(' / ')}` : ''}`)
      }
      return [`更新した: ${pageId}`, ...done.map(d => `- ${d}`)].join('\n')
    })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return (await hasNtn($))
      ? { sections: [...composed.sections, { id: 'notion-knowledge:guidance', text: guidance, scope: 'session' }] }
      : composed
  })
}
