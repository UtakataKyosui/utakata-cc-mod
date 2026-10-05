// 計測レコードの集計と Markdown レポート。source (mock / ollama / manual) は混ぜず、別の節にする。
import { type Condition, type EvalRecord, type Source, CONDITIONS, SOURCES } from './schema'

export type Stat = { mean: number; median: number; min: number; max: number }

export const stat = (xs: readonly number[]): Stat => {
  if (xs.length === 0) return { mean: 0, median: 0, min: 0, max: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, median: s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, min: s[0]!, max: s[s.length - 1]! }
}

export type Group = {
  source: Source
  caseId: string
  kind: string
  condition: Condition
  trials: number
  /** 追加取得を含め、必要情報が揃った試行の数。 */
  passed: number
  /** 初回の結果だけで必要情報が揃った試行の数。 */
  firstPassComplete: number
  attempted: number
  applied: number
  fallback: number
  followUps: Stat
  deliveredChars: Stat
  totalMs: Stat
  localLlmMs: Stat
  distractors: number
  usage: { measured: number; estimated: number; unavailable: number; notes: string[]; mean: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } }
}

const meanOrNull = (xs: readonly (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null)
  return v.length === xs.length && v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null
}

const groupOf = (rs: readonly EvalRecord[]): Group => {
  const r0 = rs[0]!
  const u = rs.map(r => r.claude.usage)
  return {
    source: r0.source,
    caseId: r0.caseId,
    kind: r0.kind,
    condition: r0.condition,
    trials: rs.length,
    passed: rs.filter(r => r.accuracy.passed).length,
    firstPassComplete: rs.filter(r => r.accuracy.firstPassMissed.length === 0).length,
    attempted: rs.filter(r => r.localLlm.attempted).length,
    applied: rs.filter(r => r.localLlm.applied).length,
    fallback: rs.filter(r => r.localLlm.fallback).length,
    followUps: stat(rs.map(r => r.followUps.count)),
    deliveredChars: stat(rs.map(r => r.claude.deliveredChars)),
    totalMs: stat(rs.map(r => r.timing.totalMs)),
    localLlmMs: stat(rs.map(r => r.timing.localLlmMs)),
    distractors: rs.reduce((n, r) => n + r.accuracy.distractorsReturned, 0),
    usage: {
      measured: u.filter(x => x.source === 'measured').length,
      estimated: u.filter(x => x.source === 'estimated').length,
      unavailable: u.filter(x => x.source === 'unavailable').length,
      notes: [...new Set(u.map(x => x.note).filter((n): n is string => n !== null))],
      mean: {
        input: meanOrNull(u.map(x => x.inputTokens)),
        output: meanOrNull(u.map(x => x.outputTokens)),
        cacheRead: meanOrNull(u.map(x => x.cacheReadTokens)),
        cacheWrite: meanOrNull(u.map(x => x.cacheWriteTokens)),
      },
    },
  }
}

/** source・ケース・条件ごとの集計。同じ組の試行だけをまとめる。 */
export const aggregate = (records: readonly EvalRecord[]): Group[] => {
  const by = new Map<string, EvalRecord[]>()
  for (const r of records) {
    const k = `${r.source}\0${r.caseId}\0${r.condition}`
    by.set(k, [...(by.get(k) ?? []), r])
  }
  const order = (g: Group) => [SOURCES.indexOf(g.source), g.caseId, CONDITIONS.indexOf(g.condition)] as const
  return [...by.values()].map(groupOf).sort((a, b) => {
    const [sa, ca, oa] = order(a)
    const [sb, cb, ob] = order(b)
    return sa - sb || ca.localeCompare(cb) || oa - ob
  })
}

const SOURCE_NOTE: Record<Source, string> = {
  mock: '通信を模擬した決定的な実行。配線・判定・集計の確認用で、実際の効果の測定ではない。この節の数値を削減率や効果の根拠にしない。',
  ollama: '実 ollama に plugin を通した実行。Claude は使っていないので、Claude の使用量と、Claude が再調査するかどうかは含まない。追加取得は決まった手順で模擬した値。',
  manual: '実 Claude のセッションで人が測って貼った記録。',
}

const SOURCE_LABEL: Record<Source, string> = { mock: 'mock (モック)', ollama: 'ollama (実 ollama・Claude なし)', manual: 'manual (実 Claude・手動測定)' }

const n1 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1))
const frac = (k: number, n: number) => `${k}/${n}`

const tokens = (g: Group, which: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => {
  const v = g.usage.mean[which]
  return v === null ? '取得不能' : `${Math.round(v)}${g.usage.estimated > 0 ? ' (推計含む)' : ''}`
}

export type ReportOptions = {
  /** 指定すると、返却文字数の平均から推計トークンを出す。仮定値であり実測ではない。 */
  charsPerToken?: number
  /** 形式エラーで除外したレコードの説明。 */
  invalid?: readonly string[]
}

export const renderReport = (records: readonly EvalRecord[], opts: ReportOptions = {}): string => {
  const groups = aggregate(records)
  const out: string[] = [
    '# ローカルLLM併用の評価レポート',
    '',
    '> このレポートは測定結果の集計であり、推奨構成や削減率を保証しない。節約の大小だけでなく、必要情報の取りこぼし・追加取得・所要時間と合わせて読む。source が異なる記録は混ぜず、節を分けている。',
    '',
  ]
  if (records.length === 0) out.push('集計できるレコードがない。', '')
  for (const source of SOURCES) {
    const rs = records.filter(r => r.source === source)
    if (rs.length === 0) continue
    const gs = groups.filter(g => g.source === source)
    out.push(`## ${SOURCE_LABEL[source]}`, '', `> ${SOURCE_NOTE[source]}`, '')
    out.push(...environment(rs))
    const few = gs.filter(g => g.trials < 3)
    if (few.length > 0) out.push('', `- 試行が 3 回未満の組がある (${few.map(g => `${g.caseId}/${g.condition}`).join(', ')})。少数の試行では傾向を判断しない。`, '')
    out.push(...table(gs, opts))
    out.push(...usageSection(gs))
  }
  if (opts.invalid !== undefined && opts.invalid.length > 0) out.push('## 除外したレコード', '', ...opts.invalid.map(e => `- ${e}`), '')
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

const uniq = (xs: readonly string[]) => [...new Set(xs)]

const environment = (rs: readonly EvalRecord[]): string[] => {
  const warm = uniq(rs.map(r => `Ollama ${r.warmth.ollama} / Claude キャッシュ ${r.warmth.claudeCache}`))
  const plugins = uniq(rs.flatMap(r => Object.entries(r.environment.pluginVersions).map(([k, v]) => `${k} ${v}`)))
  const claude = uniq(rs.map(r => r.environment.claudeModel ?? '不明 (未使用または未記録)'))
  const trials = Math.max(...rs.map(r => r.trial))
  return [
    '### 環境',
    '',
    `- 実行 ID: ${uniq(rs.map(r => r.runId)).join(', ')}`,
    `- 試行の最大番号: ${trials}`,
    `- ローカルLLMのモデル: ${uniq(rs.flatMap(r => r.environment.localModels)).join(', ')}`,
    `- Claude のモデル: ${claude.join(', ')}`,
    `- ollama: ${uniq(rs.map(r => `${r.environment.ollamaUrl ?? '-'} (version ${r.environment.ollamaVersion ?? '不明'})`)).join(', ')}`,
    `- cold / warm: ${warm.join(' ; ')}`,
    `- plugin: ${plugins.join(', ')}`,
    `- 実行環境: ${uniq(rs.map(r => `${r.environment.platform}, ${r.environment.runtime}`)).join(' ; ')}`,
    '',
  ]
}

const table = (gs: readonly Group[], opts: ReportOptions): string[] => {
  const offChars = new Map(gs.filter(g => g.condition === 'off').map(g => [g.caseId, g.deliveredChars.mean]))
  const head = ['ケース', '条件', '試行', '必要情報の達成', '初回で揃った', '追加取得 (平均)', '返却文字数 (平均)', 'off 比', ...(opts.charsPerToken === undefined ? [] : [`推計トークン (文字数÷${opts.charsPerToken}、仮定)`]), '総所要 ms (平均 / 中央値)', 'ローカルLLM待ち ms (平均)', '通信 / 使用 / フォールバック', '誤誘導の混入']
  const rows = gs.map(g => {
    const off = offChars.get(g.caseId)
    return [
      g.caseId,
      g.condition,
      String(g.trials),
      frac(g.passed, g.trials),
      frac(g.firstPassComplete, g.trials),
      n1(g.followUps.mean),
      n1(g.deliveredChars.mean),
      g.condition === 'off' ? '-' : g.source === 'mock' ? '算出しない (モック)' : off === undefined || off === 0 ? 'off なし' : `${(g.deliveredChars.mean / off).toFixed(2)}x`,
      ...(opts.charsPerToken === undefined ? [] : [g.source === 'mock' ? '算出しない (モック)' : String(Math.round(g.deliveredChars.mean / opts.charsPerToken))]),
      `${n1(g.totalMs.mean)} / ${n1(g.totalMs.median)}`,
      n1(g.localLlmMs.mean),
      `${g.attempted} / ${g.applied} / ${g.fallback}`,
      String(g.distractors),
    ]
  })
  return [
    '### ケース別',
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
    '',
    '- 必要情報の達成: 追加取得を含め、期待する必要情報がすべて揃った試行 / 試行数。初回で揃った: 追加取得なしで揃った試行。',
    '- 返却文字数: Claude へ返したツール結果の文字数 (追加取得を含む計測値)。トークン数ではない。off 比は同じケースの off の平均に対する比。',
    '- 通信 / 使用 / フォールバック: ollama へ通信した試行数 / 結果を返却に使った試行数 / 通信したが使えず既存の動作へ戻った試行数。',
    '',
  ]
}

const usageSection = (gs: readonly Group[]): string[] => {
  const rows = gs.map(g => `| ${g.caseId} | ${g.condition} | ${g.usage.measured} / ${g.usage.estimated} / ${g.usage.unavailable} | ${tokens(g, 'input')} | ${tokens(g, 'output')} | ${tokens(g, 'cacheRead')} | ${tokens(g, 'cacheWrite')} |`)
  const notes = uniq(gs.flatMap(g => g.usage.notes))
  return [
    '### Claude の使用量',
    '',
    '| ケース | 条件 | 実測 / 推計 / 取得不能 (試行数) | 入力 | 出力 | キャッシュ読込 | キャッシュ書込 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    ...(notes.length === 0 ? [] : ['取得不能・欠損の理由:', ...notes.map(n => `- ${n}`), '']),
  ]
}
