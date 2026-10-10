export type SaveMode = 'off' | 'summary' | 'full'

export type TriggerMode = 'threshold' | 'turns' | 'every'

export type Config = {
  triggerMode: TriggerMode
  everyNTurns: number
  handoff: boolean
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
  const triggerMode = options.triggerMode
  return {
    triggerMode: triggerMode === 'turns' || triggerMode === 'every' ? triggerMode : 'threshold',
    everyNTurns: Math.round(num('everyNTurns', 3)),
    handoff: options.handoff !== 'off',
    threshold: num('threshold', 65),
    ttlMs: num('cacheTtlMinutes', 5) * 60_000,
    idleMinPercent: num('idleMinPercent', 30),
    saveMode: mode === 'off' || mode === 'full' ? mode : 'summary',
    saveDir: typeof options.saveDir === 'string' && options.saveDir !== '' ? options.saveDir : '.claude/compactions',
  }
}

export const shouldCompactAtTurnEnd = (percent: number | undefined, threshold: number) =>
  percent !== undefined && percent >= threshold

export const isDueAtTurnEnd = (cfg: Config, turnsSinceCompact: number, percent: number | undefined) => {
  if (cfg.triggerMode === 'every') return true
  if (cfg.triggerMode === 'turns') return turnsSinceCompact >= cfg.everyNTurns
  return shouldCompactAtTurnEnd(percent, cfg.threshold)
}

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

const TTL_5M = 5 * 60_000
const TTL_1H = 60 * 60_000

export const ttlFromLabel = (label: string | undefined) =>
  label === '5m' ? TTL_5M : label === '1h' ? TTL_1H : undefined

// TTL は 5分か1時間のどちらか。再開時の経過時間と失効の有無から、どちらかに絞れるときだけ返す
export const ttlFromResume = (gapSec: number | undefined, expired: boolean | undefined) => {
  if (gapSec === undefined || expired === undefined) return undefined
  const gapMs = gapSec * 1000
  if (expired && gapMs < TTL_1H) return TTL_5M
  if (!expired && gapMs > TTL_5M) return TTL_1H
  return undefined
}

export const HANDOFF_RULE = [
  'このセッションは自動で Compaction される。会話に残る保証があるのは、末尾の Handoff ブロックだけである。会話の外に書き出していない情報は失われうる。',
  '',
  'ターンを終える前に、後に残すべきものを会話の外へ書き出す。',
  '- Issue: 具体的で着手可能な後続タスク・バグ・未決事項は GitHub Issue にする（gh issue create）。先に既存 Issue を検索し、一致するものがあれば重複させずコメントで足す。憶測や、このターンで解決したものは作らない。',
  '- ドキュメント: 後から読む人に必要な設計判断・制約・手順・調査結果は、リポジトリのドキュメント（README、docs/、ADR、コードコメント）に書く。既存ページがあれば更新する。',
  '- コード: 完了した作業は意味のある単位で commit する。記録されていない未コミットの状態を残さない。',
  '対象は目の前のタスクに限る。リモートが無い、または gh が使えないときは、Issue の文面をドキュメントに書き、その旨を伝える。',
  '',
  '最終回答の末尾には、次のブロックを短く具体的に付ける。ブロックの後には何も書かない。',
  '',
  '## Handoff',
  '- Done: このターンで実施したこと。',
  '- Result: 動くようになった・確認できたこと。失敗したこと・未検証のこと。',
  '- Next: 次にやること。ユーザーの未対応の依頼を含む。',
  '- Refs: このターンで書いた・触れたパス、ブランチ、commit、Issue/PR 番号、ドキュメントのページ。',
].join('\n')

export const INSTRUCTIONS_PLAIN =
  '進行中のタスク、決定事項、未解決の問題、変更したファイルと次にやることを優先して残す'

export const INSTRUCTIONS_HANDOFF = [
  '残すのは Done / Result / Next / Refs の4項目だけにして、簡潔にまとめる。',
  "会話中に '## Handoff' ブロックがあれば、直近のものを正本にする。Refs はそのまま引き継ぎ、Next が依存する Issue/PR 番号・ブランチ・パス・commit を足す。",
  '前回の要約の Next のうち未完了のものは引き継ぎ、完了したものは落とす。',
  'それ以外（ファイルの中身、ツール出力、調査の経緯、推論）は捨てる。',
  'すべてコードベース、ドキュメント、Issue、PR から辿り直せる前提にする。',
].join('\n')

export const instructionsFor = (cfg: Config) => (cfg.handoff ? INSTRUCTIONS_HANDOFF : INSTRUCTIONS_PLAIN)
