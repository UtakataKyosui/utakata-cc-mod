export type Config = { maxResults: number }

export const readConfig = (options: Record<string, unknown> | undefined): Config => {
  const n = Number(options?.maxResults)
  return { maxResults: Number.isFinite(n) ? Math.min(2000, Math.max(10, Math.trunc(n))) : 200 }
}

export type FindFilesInput = {
  pattern?: string
  path?: string
  extension?: string | string[]
  type?: 'file' | 'directory'
  glob?: boolean
  hidden?: boolean
  max_depth?: number
}

export type SearchCodeInput = {
  pattern: string
  path?: string
  glob?: string
  type?: string
  file_pattern?: string
  ignore_case?: boolean
  fixed?: boolean
  word?: boolean
  files_only?: boolean
  context?: number
  hidden?: boolean
}

const list = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(s => s.replace(/^\./, '')).filter(s => s !== '')

const posInt = (v: number | undefined, max: number): number | undefined =>
  v === undefined || !Number.isFinite(v) || v < 0 ? undefined : Math.min(max, Math.trunc(v))

/** fd の argv。`--` でパターンをオプションから切り離す。 */
export const fdArgs = (input: FindFilesInput): string[] => {
  const depth = posInt(input.max_depth, 50)
  return [
    'fd',
    '--color', 'never',
    ...(input.type === 'directory' ? ['--type', 'd'] : input.type === 'file' ? ['--type', 'f'] : []),
    ...list(input.extension).flatMap(e => ['--extension', e]),
    ...(input.glob === true ? ['--glob'] : []),
    ...(input.hidden === true ? ['--hidden'] : []),
    ...(depth === undefined ? [] : ['--max-depth', String(depth)]),
    '--',
    input.pattern ?? '.',
    ...(input.path === undefined || input.path === '' ? [] : [input.path]),
  ]
}

/** rg の argv。files に絞り込み済みのファイルがあれば検索対象をそれに限る。 */
export const rgArgs = (input: SearchCodeInput, files?: readonly string[]): string[] => {
  const context = posInt(input.context, 20)
  return [
    'rg',
    '--color', 'never',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--max-columns', '300',
    '--max-columns-preview',
    ...(input.files_only === true ? ['--files-with-matches'] : []),
    ...(input.ignore_case === true ? ['--ignore-case'] : []),
    ...(input.fixed === true ? ['--fixed-strings'] : []),
    ...(input.word === true ? ['--word-regexp'] : []),
    ...(input.hidden === true ? ['--hidden'] : []),
    ...(context === undefined || input.files_only === true ? [] : ['--context', String(context)]),
    ...(input.type === undefined || input.type === '' ? [] : ['--type', input.type]),
    ...(input.glob === undefined || input.glob === '' ? [] : ['--glob', input.glob]),
    '--',
    input.pattern,
    ...(files !== undefined ? files : input.path === undefined || input.path === '' ? [] : [input.path]),
  ]
}

/** 出力を行単位で切り詰める。 */
export const clip = (stdout: string, max: number): { text: string; total: number; clipped: boolean } => {
  const lines = stdout.split('\n').filter(l => l !== '')
  return { text: lines.slice(0, max).join('\n'), total: lines.length, clipped: lines.length > max }
}

export const formatResult = (stdout: string, max: number, noun: string): string => {
  const { text, total, clipped } = clip(stdout, max)
  if (total === 0) return `${noun}は見つからなかった。`
  return clipped ? `${text}\n... 全 ${total} 行のうち先頭 ${max} 行のみ。パターンや path を絞ること。` : text
}

export const guidance = (hasFd: boolean, hasRg: boolean): string | undefined => {
  const lines = [
    ...(hasFd ? ['- ファイル・ディレクトリを名前で探すときは mcp__code-finder__find_files (fd)'] : []),
    ...(hasRg
      ? [
          '- コードや文字列の出現箇所を探すときは mcp__code-finder__search_code (ripgrep)',
          ...(hasFd ? ['- 「このファイル群の中から探す」ときは search_code の file_pattern でファイル名を絞る'] : []),
        ]
      : []),
  ]
  return lines.length === 0
    ? undefined
    : ['特定のファイルやコードを探すときは、まず次の検索ツールを使う。', ...lines].join('\n')
}
