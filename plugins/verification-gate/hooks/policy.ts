export type Config = { defaultTimeoutMs: number; outputTailChars: number }

export const readConfig = (options: Record<string, unknown> | undefined): Config => {
  const num = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
  return {
    defaultTimeoutMs: num(options?.defaultTimeoutSec, 300, 5, 600) * 1000,
    outputTailChars: num(options?.outputTailChars, 2000, 0, 20000),
  }
}

/** 受け入れ条件。command はシェルを介さない argv。 */
export type Condition = { id: string; description: string; command: string[]; timeoutMs: number }

export type Outcome = 'passed' | 'failed' | 'timeout' | 'error'

/** 実行の記録。出力本文は保存しない。fingerprint は実行時点の変更状態で、取得できなければ null。 */
export type Run = {
  outcome: Outcome
  exitCode: number | null
  at: string
  durationMs: number
  fingerprint: string | null
  detail?: string
}

export type Entry = { condition: Condition; last?: Run; baseline?: Run }

export type Verdict =
  | 'passed'
  | 'failed'
  | 'regression'
  | 'preexisting'
  | 'timeout'
  | 'unverifiable'
  | 'stale'
  | 'unknown-state'
  | 'unrun'

export const MAX_CONDITIONS = 20
const ID = /^[A-Za-z0-9_-]{1,40}$/

export const parseConditions = (raw: unknown, defaultTimeoutMs: number): { conditions: Condition[]; error?: string } => {
  if (!Array.isArray(raw) || raw.length === 0) return { conditions: [], error: 'conditions は 1 件以上の配列で渡すこと' }
  if (raw.length > MAX_CONDITIONS) return { conditions: [], error: `conditions は ${MAX_CONDITIONS} 件まで` }
  const conditions: Condition[] = []
  for (const item of raw as Record<string, unknown>[]) {
    const id = item?.id
    const command = item?.command
    if (typeof id !== 'string' || !ID.test(id)) return { conditions: [], error: 'id は英数字・_・- の 40 文字以内にすること' }
    if (conditions.some(c => c.id === id)) return { conditions: [], error: `id が重複している: ${id}` }
    if (!Array.isArray(command) || command.length === 0 || command.some(a => typeof a !== 'string' || a === '') || command[0] === '') {
      return { conditions: [], error: `${id}: command は空でない文字列の配列 (argv、シェルを介さない) で渡すこと` }
    }
    const sec = item.timeout_sec
    const timeoutMs = typeof sec === 'number' && sec > 0 ? Math.min(600, Math.max(1, sec)) * 1000 : defaultTimeoutMs
    const description = typeof item.description === 'string' && item.description.trim() !== '' ? item.description.trim() : id
    conditions.push({ id, description, command: command as string[], timeoutMs })
  }
  return { conditions }
}

/** 非暗号用の FNV-1a。変更状態の比較にだけ使う。 */
export const fnv1a = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export const fingerprintOf = (parts: readonly string[]): string => fnv1a(parts.join('\u0000'))

/** 実行時点の変更状態と現在の変更状態から、条件の判定を決める。 */
export const verdictOf = (entry: Entry, currentFingerprint: string | null): Verdict => {
  const run = entry.last
  if (run === undefined) return 'unrun'
  if (run.outcome === 'timeout') return 'timeout'
  if (run.outcome === 'error') return 'unverifiable'
  if (run.outcome === 'failed') {
    const base = entry.baseline
    if (base === undefined) return 'failed'
    if (base.outcome === 'passed') return 'regression'
    return base.outcome === 'failed' && base.exitCode === run.exitCode ? 'preexisting' : 'failed'
  }
  if (run.fingerprint === null || currentFingerprint === null) return 'unknown-state'
  return run.fingerprint === currentFingerprint ? 'passed' : 'stale'
}

const LABEL: Record<Verdict, string> = {
  passed: '成功',
  failed: '失敗 (既存の失敗かは不明。ベースライン未記録)',
  regression: '失敗 (今回の変更による。ベースラインでは成功していた)',
  preexisting: '失敗 (既存の失敗。ベースラインでも同じ終了コードで失敗していた)',
  timeout: 'タイムアウト (未検証)',
  unverifiable: '検証不可',
  stale: '再変更あり (成功後に変更されたため未検証)',
  'unknown-state': '変更状態を取得できず、再変更の有無を判断できない (未検証)',
  unrun: '未実行',
}

export const labelOf = (v: Verdict): string => LABEL[v]

export type Report = { entry: Entry; verdict: Verdict }

/** 完了とみなせるのは全条件が成功のときだけ。既存の失敗は成功に数えない。 */
export const overall = (reports: readonly Report[]): 'empty' | 'verified' | 'blocked' =>
  reports.length === 0 ? 'empty' : reports.every(r => r.verdict === 'passed') ? 'verified' : 'blocked'

export const formatReport = (reports: readonly Report[]): string => {
  if (reports.length === 0) return '受け入れ条件が登録されていない。verify_define で登録すること。'
  const lines = reports.map(({ entry, verdict }) => {
    const run = entry.last
    const meta = run === undefined ? '' : ` [exit ${run.exitCode ?? '-'}, ${run.at}, ${run.durationMs}ms]`
    const reason = run?.detail !== undefined && (verdict === 'unverifiable' || verdict === 'timeout') ? `\n    理由: ${run.detail}` : ''
    return `- ${entry.condition.id} (${entry.condition.description}): ${labelOf(verdict)}${meta}\n    $ ${entry.condition.command.join(' ')}${reason}`
  })
  const state = overall(reports)
  const head =
    state === 'verified'
      ? '全条件が、現在の変更状態で成功している。'
      : '未検証または失敗の条件がある。完了と報告せず、下記を実行・修正するか、検証できない理由をユーザーへ示すこと。'
  return `${head}\n${lines.join('\n')}`
}

export const tail = (text: string, n: number): string => {
  const t = text.trim()
  return n <= 0 ? '' : t.length <= n ? t : `…${t.slice(t.length - n)}`
}

export const guidance = [
  'タスクの完了を報告する前に、受け入れ条件を検証コマンドの実行結果で裏付けること。',
  '- 作業の開始時に verify_define で受け入れ条件と検証コマンド (argv) を登録する。リポジトリが使っている既存のテストランナーを使い、TDD や全件テストは強制しない',
  '- 既存の失敗と区別したいときは、変更する前に verify_run の baseline を true にして実行しておく',
  '- 変更を終えたら verify_run で実行し、verify_status で判定を確認する。成功後にファイルを変えたら再実行が必要になる',
  '- 失敗・未実行・タイムアウト・再変更・検証不可の条件を成功として報告しない。検証できないときは理由をユーザーへ示す',
  '- このプラグインは完了報告を止められない。判定は自分で守ること',
].join('\n')
