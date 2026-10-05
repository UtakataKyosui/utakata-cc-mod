export type Config = { maxChars: number }

export const readConfig = (options: Record<string, unknown> | undefined): Config => {
  const n = Number(options?.maxChars)
  return { maxChars: Number.isFinite(n) ? Math.min(400000, Math.max(1000, Math.trunc(n))) : 60000 }
}

export type FetchPageInput = {
  url: string
  query?: string
}

/** http(s) の URL だけを通す。`-` で始まる値がオプションとして解釈されるのを防ぐ。 */
export const isHttpUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export const ctxpackArgs = (input: FetchPageInput): string[] => [
  'ctxpack',
  input.url,
  ...(input.query === undefined || input.query.trim() === '' ? [] : ['--query', input.query.trim()]),
]

export const clipText = (stdout: string, max: number): string =>
  stdout.length <= max
    ? stdout
    : `${stdout.slice(0, max)}\n... 全 ${stdout.length} 文字のうち先頭 ${max} 文字のみ。query で関連部分を絞ること。`

export const denyText = 'WebFetch は使えない。代わりに mcp__ctxpack-fetch__fetch_page に url を渡して Web ページを取得すること。'

export const guidance = [
  'Web ページの内容を読むときは WebFetch ではなく mcp__ctxpack-fetch__fetch_page (ctxpack) を使う。',
  '- ノイズを除いた Markdown が返るので、トークンを節約できる',
  '- 探したい話題が決まっているときは query に渡すと、関連するセクションが先頭に来る',
].join('\n')
