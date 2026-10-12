export type Config = { transcriptDir: string; reportDir: string; days: number; ollamaUrl: string; draftModel: string; judgeModel: string }

export type Prompt = { sessionId: string; at: number; text: string }

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : fallback

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)

export const readConfig = (options: Record<string, unknown> | undefined): Config => ({
  transcriptDir: str(options?.transcriptDir, '~/.claude/projects'),
  reportDir: str(options?.reportDir, 'reports'),
  days: num(options?.days, 7, 1, 365),
  ollamaUrl: str(options?.ollamaUrl, 'http://localhost:11434').replace(/\/+$/, ''),
  draftModel: str(options?.draftModel, 'gemma4:e4b'),
  judgeModel: str(options?.judgeModel, 'tev1:4b'),
})

export const parseDays = (args: unknown, fallback: number): number => {
  const m = /^\s*(\d+)\s*$/.exec(typeof args === 'string' ? args : '')
  return m ? num(Number(m[1]), fallback, 1, 365) : fallback
}

export const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path

export const resolveDir = (root: string, dir: string): string => (dir.startsWith('/') ? dir : `${root.replace(/\/$/, '')}/${dir}`)

/** 会話ログに混ざる、利用者が書いていないユーザーメッセージの先頭。 */
const SYSTEM_PREFIX = /^(<(command-|local-command|system-reminder|task-notification)|Caveat:|\[Request interrupted)/

/** 会話ログ (JSONL) の1行から、利用者が手で送ったプロンプトを取り出す。 */
export const parsePromptLine = (line: string): Prompt | undefined => {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (row?.type !== 'user' || row.isSidechain === true || row.isMeta === true) return undefined
  const content = row.message?.content
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((b: any) => b?.type === 'tool_result')) return undefined
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  } else return undefined
  text = text.trim()
  if (text === '' || SYSTEM_PREFIX.test(text)) return undefined
  const at = Date.parse(row.timestamp)
  if (!Number.isFinite(at)) return undefined
  return { sessionId: typeof row.sessionId === 'string' ? row.sessionId : 'unknown', at, text }
}

export const LARGE_CHARS = 20_000
export const DRIP_PROMPTS = 20

const DEICTIC = /^(それ|これ|あれ|さっき|先ほど|上記|同じ|続けて|お願い|やって|よろしく|ok|はい|resolve)/i
const TARGET = /(https?:\/\/|\/[\w.-]+\/|\.\w{1,5}\b|#\d+|`|PR|Issue)/

export const isFragment = (text: string): boolean => !text.startsWith('/') && [...text].length <= 3 && !/^(はい|いいえ|ok|no|yes|y|n|1|2|3)$/i.test(text)

/** 短く、対象を指す語 (パス・URL・番号) を含まない指示語プロンプト。 */
export const isDeictic = (text: string): boolean => !text.startsWith('/') && [...text].length <= 30 && DEICTIC.test(text) && !TARGET.test(text)

export const isLarge = (text: string): boolean => [...text].length >= LARGE_CHARS

export type Analysis = {
  from: number
  to: number
  total: number
  sessions: number
  median: number
  mean: number
  max: number
  fragments: Prompt[]
  deictic: Prompt[]
  large: Prompt[]
  drips: { sessionId: string; count: number }[]
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export const analyze = (all: Prompt[], from: number, to: number): Analysis => {
  const prompts = all.filter(p => p.at >= from && p.at <= to).sort((a, b) => a.at - b.at)
  const lengths = prompts.map(p => [...p.text].length)
  const bySession = new Map<string, number>()
  for (const p of prompts) bySession.set(p.sessionId, (bySession.get(p.sessionId) ?? 0) + 1)
  return {
    from,
    to,
    total: prompts.length,
    sessions: bySession.size,
    median: median(lengths),
    mean: lengths.length === 0 ? 0 : Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
    max: lengths.reduce((a, b) => Math.max(a, b), 0),
    fragments: prompts.filter(p => isFragment(p.text)),
    deictic: prompts.filter(p => isDeictic(p.text)),
    large: prompts.filter(p => isLarge(p.text)),
    drips: [...bySession]
      .filter(([, count]) => count >= DRIP_PROMPTS)
      .map(([sessionId, count]) => ({ sessionId, count }))
      .sort((a, b) => b.count - a.count),
  }
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const clip = (text: string, n = 40): string => {
  const one = text.replace(/\s+/g, ' ')
  return [...one].length > n ? `${[...one].slice(0, n).join('')}…` : one
}

const examples = (ps: Prompt[]): string =>
  ps
    .slice(0, 5)
    .map(p => `- 「${clip(p.text)}」`)
    .join('\n')

export const reportFileName = (now: number): string => `${day(now)}-prompt-analysis.md`

export const renderReport = (a: Analysis): string => {
  const out: string[] = [
    `# プロンプト分析（${day(a.from)}〜${day(a.to)}）`,
    '',
    'Claude Code の会話ログに残る手打ちプロンプトを、機械的な基準で集計した。',
    '',
    '## データ概要',
    '',
    `- プロンプト数: ${a.total}件（${a.sessions}セッション）`,
    `- 文字数: 中央値${a.median}、平均${a.mean}、最大${a.max}`,
    '',
    '## 改善ポイント',
    '',
  ]
  const points: string[] = []
  if (a.drips.length > 0)
    points.push(
      [
        `### 要件の小出し（${a.drips.length}セッション）`,
        '',
        `1セッションで${DRIP_PROMPTS}件以上送ったセッション。指示を1件ずつ足している可能性がある。`,
        '',
        ...a.drips.slice(0, 5).map(d => `- セッション ${d.sessionId.slice(0, 8)}: ${d.count}件`),
        '',
        '対策: 文書・実装系のタスクは最初に、目的・対象・含める項目・含めない項目・完了条件を1プロンプトで渡す。',
      ].join('\n'),
    )
  if (a.deictic.length > 0)
    points.push(
      [
        `### 指示語だけのプロンプト（${a.deictic.length}件）`,
        '',
        examples(a.deictic),
        '',
        '対策: 対象（ファイルパス、PR番号）と完了条件を1行添える。/compact や /clear の直後は特に文脈が失われる。',
      ].join('\n'),
    )
  if (a.large.length > 0)
    points.push(
      [
        `### 肥大したプロンプト（${a.large.length}件、${LARGE_CHARS}文字以上）`,
        '',
        examples(a.large),
        '',
        '対策: diff やログの全文を貼らず、パスや範囲を渡して読ませる。自動生成されたものは生成元でサイズに上限を設ける。',
      ].join('\n'),
    )
  if (a.fragments.length > 0)
    points.push(
      [
        `### 誤送信の疑い（${a.fragments.length}件）`,
        '',
        examples(a.fragments),
        '',
        '対策: 書きかけで送ったターンは無駄になり、断片をエージェントが解釈して動くおそれもある。',
      ].join('\n'),
    )
  out.push(points.length > 0 ? points.join('\n\n') : '機械的な基準に該当するプロンプトはなかった。')
  return `${out.join('\n')}\n`
}

export const summaryText = (a: Analysis, path: string): string =>
  [
    `${a.total}件のプロンプト（${a.sessions}セッション）を分析した。`,
    `小出し候補${a.drips.length}セッション / 指示語${a.deictic.length}件 / 肥大${a.large.length}件 / 誤送信の疑い${a.fragments.length}件`,
    `レポート: ${path}`,
  ].join('\n')

export const HELP = [
  '/retrospective [日数]          会話ログのプロンプトを分析し、レポートを書き出す',
  '/retrospective improve [日数]  分析に加えて、ローカル LLM に改善案を作らせる',
  '/retrospective help            この説明を表示する',
].join('\n')
