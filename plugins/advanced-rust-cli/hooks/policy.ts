export type Rule = { from: string; to: string; hint: string }

export const RULES: readonly Rule[] = [
  { from: 'ls', to: 'eza', hint: '例: eza -la --git / eza --tree -L 2' },
  { from: 'cat', to: 'bat', hint: '例: bat -pp FILE (装飾なし) / bat -r 10:20 FILE' },
  { from: 'find', to: 'fd', hint: '例: fd PATTERN [PATH] / fd -e ts / fd -t f' },
  { from: 'grep', to: 'rg', hint: "例: rg -n PATTERN [PATH] / rg -i / rg -g '*.ts'" },
]

export const TOOLS = [...RULES.map(r => r.to), 'zoxide'] as const

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const SEPARATORS = /\|\||&&|[|;&\n]/

/** 各コマンド区間の先頭語を、引用符の中身を無視して取り出す。 */
const segments = (command: string): { head: string; text: string }[] =>
  command
    .replace(QUOTED, "''")
    .split(SEPARATORS)
    .map(text => {
      const head = text.trim().split(/\s+/).find(t => !/^\w+=/.test(t)) ?? ''
      return { head: head.split('/').pop() ?? '', text }
    })

/** ファイル書き出しに使う cat (ヒアドキュメント・リダイレクト) は bat に置き換えられない。 */
const isWriting = (text: string) => text.includes('<<') || text.includes('>')

export const findBlocked = (command: string, available: ReadonlySet<string>): Rule | undefined => {
  for (const { head, text } of segments(command)) {
    const rule = RULES.find(r => r.from === head && available.has(r.to))
    if (rule !== undefined && !(rule.from === 'cat' && isWriting(text))) return rule
  }
  return undefined
}

export const denyText = (rule: Rule) =>
  `advanced-rust-cli: ${rule.from} ではなく ${rule.to} を使うこと。${rule.hint}`

export const guidance = (available: ReadonlySet<string>): string | undefined => {
  const lines = [
    ...RULES.filter(r => available.has(r.to)).map(r => `- ${r.from} の代わりに ${r.to} (${r.hint})`),
    ...(available.has('zoxide')
      ? ['- ディレクトリ名が曖昧なときは、cd の前に zoxide query KEYWORD でパスを解決する']
      : []),
  ]
  return lines.length === 0
    ? undefined
    : ['Bash では標準コマンドではなく Rust 製の代替 CLI を使う。', ...lines].join('\n')
}
