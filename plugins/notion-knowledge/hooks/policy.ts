export type Config = {
  databaseId: string | undefined
  autoRecord: boolean
  ollamaUrl: string
  models: string[]
  timeoutMs: number
  keepAlive: string
  catalogSize: number
  maxPages: number
  maxChars: number
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

export const readConfig = (o: Record<string, unknown> | undefined): Config => {
  const models =
    typeof o?.models === 'string'
      ? o.models
          .split(',')
          .map(s => s.trim())
          .filter(s => s !== '')
      : []
  return {
    databaseId: typeof o?.databaseId === 'string' ? normalizeId(o.databaseId) : undefined,
    autoRecord: !(o?.autoRecord === false || o?.autoRecord === 'false'),
    ollamaUrl: (typeof o?.ollamaUrl === 'string' && o.ollamaUrl !== '' ? o.ollamaUrl : 'http://localhost:11434').replace(/\/+$/, ''),
    models: models.length > 0 ? models : ['tev1:4b'],
    timeoutMs: clamp(o?.timeoutSeconds, 40, 5, 180) * 1000,
    keepAlive: typeof o?.keepAlive === 'string' && o.keepAlive !== '' ? o.keepAlive : '5m',
    catalogSize: clamp(o?.catalogSize, 100, 10, 300),
    maxPages: clamp(o?.maxPages, 3, 1, 10),
    maxChars: clamp(o?.maxChars, 12000, 1000, 60000),
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi

/** URL・32 桁の 16 進数・ダッシュ付き UUID のいずれからも、ダッシュ付き UUID を取り出す。 */
export const normalizeId = (input: unknown): string | undefined => {
  if (typeof input !== 'string') return undefined
  // `?v=` 以降はビューの ID なので切り落とす
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

export type NotionProperty = { type: string; [k: string]: unknown }

export const titlePropertyName = (schema: Record<string, NotionProperty>): string | undefined =>
  Object.entries(schema).find(([, p]) => p.type === 'title')?.[0]

export const queryBody = (limit: number, filter?: unknown) => ({
  ...(filter === undefined ? {} : { filter }),
  sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
  page_size: Math.min(100, limit),
})

export const titleContains = (titleProp: string, text: string) => ({ property: titleProp, title: { contains: text } })

export const normalizeTitle = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** 全角半角・大文字小文字・空白の違いを無視して、同じ題名か判定する。 */
export const sameTitle = (a: string, b: string): boolean => normalizeTitle(a) === normalizeTitle(b)

/** rich_text 1 要素の上限は 2000 文字。 */
export const richText = (text: string): { text: { content: string } }[] => {
  const chunks: { text: { content: string } }[] = []
  for (let i = 0; i < text.length; i += 2000) chunks.push({ text: { content: text.slice(i, i + 2000) } })
  return chunks
}

export type Entry = { id: string; title: string; url: string; hint: string }

type Rich = { plain_text?: string }[]
const plain = (r: unknown): string => (Array.isArray(r) ? (r as Rich).map(t => t.plain_text ?? '').join('') : '')

/** ページから、題名と、分類の手がかりになるタグ類 (select / multi_select) を取り出す。 */
export const toEntry = (page: any): Entry => {
  let title = ''
  const hints: string[] = []
  for (const p of Object.values<any>(page?.properties ?? {})) {
    if (p?.type === 'title') title = plain(p.title)
    else if (p?.type === 'multi_select') hints.push(...(p.multi_select ?? []).map((o: { name: string }) => o.name))
    else if (p?.type === 'select' && p.select?.name) hints.push(p.select.name)
  }
  return { id: page?.id ?? '', title, url: page?.url ?? '', hint: hints.join(', ') }
}

const TITLE_LIMIT = 80

/** モデルには UUID ではなく 1 始まりの番号を見せる。 */
export const formatCatalog = (entries: readonly Entry[]): string =>
  entries.length === 0
    ? '(なし)'
    : entries
        .map((e, i) => `[${i + 1}] ${(e.title || '(無題)').slice(0, TITLE_LIMIT)}${e.hint === '' ? '' : ` (${e.hint})`}`)
        .join('\n')

const PROMPT_LIMIT = 3000
const ANSWER_LIMIT = 4000

export const SELECT_SCHEMA = {
  type: 'object',
  properties: { relevant: { type: 'array', items: { type: 'integer' } } },
  required: ['relevant'],
}

export const buildSelectPrompt = (prompt: string, entries: readonly Entry[], max: number): string =>
  [
    'あなたはナレッジベースの検索係。ユーザーの依頼に答えるのに役立ちそうな既存ナレッジを、一覧から選ぶ。',
    '',
    'ルール:',
    '- 依頼の主題・技術・固有名詞に関係するナレッジだけを選ぶ。関係が薄いものは選ばない',
    `- 最大 ${max} 件。該当がなければ空の配列`,
    '- 挨拶・雑談・一般的な質問では選ばない',
    '- 番号だけを relevant に入れる',
    '',
    'ナレッジ一覧:',
    formatCatalog(entries),
    '',
    '依頼:',
    prompt.slice(0, PROMPT_LIMIT),
  ].join('\n')

export const parseSelection = (text: string, count: number, max: number): number[] => {
  try {
    const v = (JSON.parse(text) as { relevant?: unknown }).relevant
    if (!Array.isArray(v)) return []
    const picked = [...new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= count))]
    return picked.slice(0, max).map(n => n - 1)
  } catch {
    return []
  }
}

/** create と判断された内容が、既存ナレッジと同じ話題かを聞く。答えは SELECT_SCHEMA で受ける。 */
export const buildDuplicatePrompt = (title: string, content: string, entries: readonly Entry[]): string =>
  [
    '新しく記録しようとしているナレッジが、既存のナレッジ一覧のどれかと同じ話題か判定する。',
    '',
    'ルール:',
    '- 主題 (技術・製品・問題) が同じなら、細部が違っても同じ話題とみなし、その番号を 1 つだけ relevant に入れる',
    '- どれとも主題が違うときだけ、空の配列にする',
    '',
    '既存のナレッジ一覧:',
    formatCatalog(entries),
    '',
    '新しいナレッジ:',
    `題名: ${title}`,
    content.slice(0, 1500),
  ].join('\n')

export type Decision =
  | { action: 'none' }
  | { action: 'create'; title: string; content: string }
  | { action: 'append'; target: number; content: string }

export const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['none', 'create', 'append'] },
    target: { type: 'integer' },
    title: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['action', 'target', 'title', 'content'],
}

export const buildRecordPrompt = (prompt: string, answer: string, entries: readonly Entry[]): string =>
  [
    'あなたはナレッジ記録係。ユーザーの依頼と AI の回答を読み、今後も役立つ知識が含まれるか判断する。',
    '',
    '記録する: 決定とその理由、原因を突き止めた不具合、自明でない罠や制約、調査の結論、再利用できる手順',
    '記録しない: 挨拶・雑談、作業の途中経過、コードを読めば分かること、一般常識、秘密情報 (キー・トークン・パスワード・個人情報)',
    '',
    'action:',
    '- none: 記録しない。target は 0、title と content は空文字',
    '- append: 一覧に題名の近い・同じ話題のナレッジがある。target にその番号、content に追記する内容だけを書く。title は空文字',
    '- create: 一覧のどれとも話題が違う新しい知識。title に題名、content に書く。target は 0',
    '',
    'content の書き方:',
    '- 回答に書かれた具体的な事実 (値・コマンド・エラー・理由・手順) を省略せず、箇条書きで写す',
    '- 題名の言い換えや、抽象的な要約だけにしない',
    '- 根拠の URL が回答にあれば残す',
    '一覧にある内容の言い直しや重複は記録しない。迷ったら none。',
    '',
    '既存のナレッジ一覧:',
    formatCatalog(entries),
    '',
    '依頼:',
    prompt.slice(0, PROMPT_LIMIT),
    '',
    '回答:',
    answer.slice(0, ANSWER_LIMIT),
  ].join('\n')

const MIN_CONTENT = 60

export const parseRecord = (text: string, count: number): Decision => {
  try {
    const v = JSON.parse(text) as { action?: unknown; target?: unknown; title?: unknown; content?: unknown }
    const content = typeof v.content === 'string' ? v.content.trim() : ''
    if (v.action === 'create' && typeof v.title === 'string' && v.title.trim() !== '' && content.length >= MIN_CONTENT) {
      return { action: 'create', title: v.title.trim().slice(0, 100), content }
    }
    if (v.action === 'append' && Number.isInteger(v.target) && (v.target as number) >= 1 && (v.target as number) <= count && content.length >= MIN_CONTENT) {
      return { action: 'append', target: (v.target as number) - 1, content }
    }
  } catch {
    // 不正な応答は記録しない扱いにする
  }
  return { action: 'none' }
}

/** 秘密情報らしい文字列。見つかったら記録しない。 */
const SECRET = /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}|secret_[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,}/i

export const looksSensitive = (text: string): boolean => SECRET.test(text)

/** 取得・記録の対象にしない短い入力やコマンド。 */
export const isTrivial = (text: string, min: number): boolean => text.trim().startsWith('/') || text.trim().length < min

export const MIN_PROMPT_CHARS = 8
export const MIN_ANSWER_CHARS = 200

export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n... 全 ${text.length} 文字のうち先頭 ${max} 文字のみ。`

/** 取得したページを、上限に収まるよう均等に切り詰めて 1 つの文脈にする。 */
export const buildContext = (pages: readonly { title: string; url: string; body: string }[], maxChars: number): string => {
  const each = Math.floor(maxChars / Math.max(1, pages.length))
  return [
    '## 関連するナレッジ (Notion)',
    'ユーザーのナレッジベースから、この依頼に関係しそうなページを取得した。役に立つ場合だけ参考にし、古い可能性がある点は現状と照らして確認すること。',
    ...pages.map(p => `\n### ${p.title || '(無題)'}\n${p.url}\n\n${clipText(p.body.trim(), each)}`),
  ].join('\n')
}

export const buildChatBody = (cfg: Config, model: string, format: object, content: string): string =>
  JSON.stringify({
    model,
    stream: false,
    think: false,
    format,
    keep_alive: cfg.keepAlive,
    options: { temperature: 0 },
    messages: [{ role: 'user', content }],
  })

export const FAILURE_BACKOFF_MS = 60_000
