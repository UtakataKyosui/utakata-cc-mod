export type SaveMode = 'off' | 'summary' | 'full'

export type Config = {
  threshold: number
  ttlMs: number
  idleMinPercent: number
  saveMode: SaveMode
  saveDir: string
}

export const COOLDOWN_TURNS = 3

export const readConfig = (options: Readonly<Record<string, unknown>>): Config => {
  const num = (key: string, fallback: number) => {
    const v = Number(options[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const mode = options.saveMode
  return {
    threshold: num('threshold', 65),
    ttlMs: num('cacheTtlMinutes', 5) * 60_000,
    idleMinPercent: num('idleMinPercent', 30),
    saveMode: mode === 'off' || mode === 'full' ? mode : 'summary',
    saveDir: typeof options.saveDir === 'string' && options.saveDir !== '' ? options.saveDir : '.claude/compactions',
  }
}

export const shouldCompactAtTurnEnd = (percent: number | undefined, threshold: number) =>
  percent !== undefined && percent >= threshold

export const shouldCompactOnIdle = (percent: number | undefined, floor: number) =>
  percent !== undefined && percent >= floor

export const resolveDir = (root: string, dir: string) => (dir.startsWith('/') ? dir : `${root}/${dir}`)

export const fileName = (iso: string) => `${iso.replace(/[:.]/g, '-')}.md`

export type Turn = { role: string; text: string; tools: readonly string[] }

export type DocInput = {
  iso: string
  sessionId: string
  trigger: string
  tokensBefore: number | undefined
  tokensAfter: number | undefined
  summary: string
  before: readonly Turn[] | undefined
}

export const buildDocument = (d: DocInput) => {
  const lines = [
    '# Compaction 記録',
    '',
    `- 日時: ${d.iso}`,
    `- セッション: ${d.sessionId}`,
    `- トリガー: ${d.trigger}`,
    `- トークン数: ${d.tokensBefore ?? '不明'} → ${d.tokensAfter ?? '不明'}`,
    '',
    '## 要約',
    '',
    d.summary.trim() === '' ? '(要約を取得できなかった)' : d.summary.trim(),
  ]
  if (d.before !== undefined) {
    lines.push('', '## Compaction 前の会話', '')
    for (const t of d.before) {
      const tools = t.tools.length > 0 ? ` [ツール: ${t.tools.join(', ')}]` : ''
      lines.push(`### ${t.role}${tools}`, '', t.text.trim() === '' ? '(テキストなし)' : t.text.trim(), '')
    }
  }
  return lines.join('\n') + '\n'
}
