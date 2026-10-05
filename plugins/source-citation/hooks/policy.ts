export type Config = { extensions: string[] }

const DEFAULT_EXTENSIONS = ['md', 'mdx', 'txt', 'rst', 'adoc', 'org']

export const readConfig = (options: Record<string, unknown> | undefined): Config => {
  const list =
    typeof options?.extensions === 'string'
      ? options.extensions
          .split(',')
          .map(s => s.trim().replace(/^\./, '').toLowerCase())
          .filter(s => s !== '')
      : []
  return { extensions: list.length > 0 ? list : DEFAULT_EXTENSIONS }
}

/** Web 検索・取得・閲覧を行うツール。MCP は名前から判定する。 */
const RESEARCH_TOOL = /^(WebFetch|WebSearch)$|^mcp__.*(fetch|search|scrape|crawl|browse|navigate|get_page_text|read_page)/i

export const isResearchTool = (tool: string): boolean => RESEARCH_TOOL.test(tool)

/** 会話履歴の assistant メッセージに、調査ツールの tool_use があるか。 */
export const hasResearchInHistory = (messages: unknown): boolean =>
  Array.isArray(messages) &&
  messages.some(
    m =>
      m?.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.some((b: { type?: unknown; name?: unknown }) => b?.type === 'tool_use' && typeof b.name === 'string' && isResearchTool(b.name)),
  )

export const isDocPath = (path: unknown, cfg: Config): boolean => {
  if (typeof path !== 'string') return false
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  return m !== null && cfg.extensions.includes(m[1].toLowerCase())
}

export const hasSource = (text: unknown): boolean => typeof text === 'string' && /https?:\/\/[^\s)>\]]+/i.test(text)

export const denyText = [
  'この会話では Web 調査を行っている。調査結果を書くファイルには出典を併記すること。',
  '- 根拠にした情報ごとに、出典の URL（タイトル付き）を本文中、または末尾の「出典」セクションに書く',
  '- 取得日が分かるなら併記する',
  '- 出典のない情報（推測・自分の知識）は、その旨を明記する',
  '出典を足してから、もう一度書き込むこと。',
].join('\n')

export const guidance = [
  'Web 検索・取得などで情報収集した内容を回答やファイルに書くときは、必ず出典を表記する。',
  '- 回答: 根拠にした情報ごとに出典の URL を添える。末尾に「出典」セクションを置いてよい',
  '- ファイル（調査レポート・技術記事など）: 本文中の引用、または末尾の「出典」セクションに URL を書く。出典のない書き込みは拒否される',
  '- 出典は実際に取得・閲覧したページの URL にする。取得していない URL を作らない',
  '- 出典のない情報（推測・自分の知識）は、その旨を明記する',
].join('\n')
