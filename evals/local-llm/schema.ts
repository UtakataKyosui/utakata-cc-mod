// 計測レコードの形式と検証。実測と推計・取得不能を区別して持つ。
export const SCHEMA_VERSION = 1

export const CONDITIONS = ['off', 'auto', 'always'] as const
export type Condition = (typeof CONDITIONS)[number]

export const KINDS = ['search', 'web', 'log'] as const
export type Kind = (typeof KINDS)[number]

/**
 * 記録の出どころ。集計では混ぜない。
 * - mock: 通信を模擬した決定的な実行。配線と判定の確認用で、効果の測定ではない
 * - ollama: 実 ollama に plugin を通した実行。Claude は使わないので Claude の使用量は取得不能
 * - manual: 実 Claude のセッションで人が測って貼った記録
 */
export const SOURCES = ['mock', 'ollama', 'manual'] as const
export type Source = (typeof SOURCES)[number]

export type Warmth = 'cold' | 'warm' | 'not_applicable' | 'unknown'
export const WARMTHS: readonly Warmth[] = ['cold', 'warm', 'not_applicable', 'unknown']

/** Claude のトークン使用量。measured は本体の集計値、estimated は文字数などからの推計、unavailable は取得不能。 */
export type ClaudeUsage = {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  source: 'measured' | 'estimated' | 'unavailable'
  /** source が unavailable のとき、または一部が null のときの理由。 */
  note: string | null
}

export type EvalRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  source: Source
  runId: string
  caseId: string
  kind: Kind
  condition: Condition
  /** 同じ条件の繰り返しの通し番号 (1 始まり)。 */
  trial: number
  warmth: { ollama: Warmth; claudeCache: Warmth }
  environment: {
    claudeModel: string | null
    /** ローカルLLMのモデル。モックは `mock:<戦略>`。 */
    localModels: string[]
    ollamaUrl: string | null
    ollamaVersion: string | null
    /** 実行した plugin の設定 (llmMode と共通基盤の9キー)。 */
    config: Record<string, string | number>
    pluginVersions: Record<string, string>
    platform: string
    runtime: string
  }
  claude: {
    usage: ClaudeUsage
    /** Claude へ返したツール結果の文字数 (追加取得を含む)。計測値。 */
    deliveredChars: number
    /** 文字数からの推計トークン。推計の方法を estimateMethod に書く。 */
    estimatedInputTokens: number | null
    estimateMethod: string | null
  }
  timing: { totalMs: number; localLlmMs: number }
  localLlm: {
    /** ollama へ通信したか。 */
    attempted: boolean
    calls: number
    /** ローカルLLMの結果を実際に返却へ使ったか。 */
    applied: boolean
    /** 通信したが結果を使えず、既存の動作へ戻ったか。 */
    fallback: boolean
    reasons: string[]
  }
  /** 追加取得・再調査。初回の結果で必要情報が足りず、原文を取り直した回数。 */
  followUps: { count: number; chars: number; steps: string[] }
  accuracy: {
    required: number
    firstPassFound: number
    firstPassMissed: string[]
    finalMissed: string[]
    /** 追加取得を含め、必要情報がすべて揃ったか。 */
    passed: boolean
    distractorsReturned: number
  }
  notes: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonNegInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const nullableNonNeg = (v: unknown) => v === null || nonNeg(v)
const nullableStr = (v: unknown) => v === null || typeof v === 'string'
const strArray = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')

/** レコードの形式エラーの一覧。空なら有効。 */
export const validateRecord = (raw: unknown): string[] => {
  if (!isObj(raw)) return ['レコードがオブジェクトでない']
  const errs: string[] = []
  const need = (ok: boolean, msg: string) => void (ok || errs.push(msg))
  need(raw.schemaVersion === SCHEMA_VERSION, `schemaVersion は ${SCHEMA_VERSION}`)
  need(SOURCES.includes(raw.source as Source), `source は ${SOURCES.join(' / ')}`)
  need(typeof raw.runId === 'string' && raw.runId !== '', 'runId が空')
  need(typeof raw.caseId === 'string' && raw.caseId !== '', 'caseId が空')
  need(KINDS.includes(raw.kind as Kind), `kind は ${KINDS.join(' / ')}`)
  need(CONDITIONS.includes(raw.condition as Condition), `condition は ${CONDITIONS.join(' / ')}`)
  need(typeof raw.trial === 'number' && Number.isInteger(raw.trial) && raw.trial >= 1, 'trial は 1 以上の整数')

  const warmth = raw.warmth
  need(isObj(warmth) && WARMTHS.includes(warmth.ollama as Warmth) && WARMTHS.includes(warmth.claudeCache as Warmth), `warmth.ollama / claudeCache は ${WARMTHS.join(' / ')}`)

  const env = raw.environment
  if (!isObj(env)) errs.push('environment がない')
  else {
    need(nullableStr(env.claudeModel), 'environment.claudeModel は文字列か null')
    need(strArray(env.localModels), 'environment.localModels は文字列の配列')
    need(nullableStr(env.ollamaUrl) && nullableStr(env.ollamaVersion), 'environment.ollamaUrl / ollamaVersion は文字列か null')
    need(isObj(env.config) && isObj(env.pluginVersions), 'environment.config / pluginVersions はオブジェクト')
    need(typeof env.platform === 'string' && typeof env.runtime === 'string', 'environment.platform / runtime は文字列')
  }

  const claude = raw.claude
  if (!isObj(claude)) errs.push('claude がない')
  else {
    const u = claude.usage
    if (!isObj(u)) errs.push('claude.usage がない')
    else {
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) need(nullableNonNeg(u[k]), `claude.usage.${k} は非負の数か null`)
      need(u.source === 'measured' || u.source === 'estimated' || u.source === 'unavailable', 'claude.usage.source は measured / estimated / unavailable')
      need(nullableStr(u.note), 'claude.usage.note は文字列か null')
      const values = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(k => u[k])
      if (u.source === 'unavailable') {
        need(values.every(v => v === null), 'unavailable のとき claude.usage の数値はすべて null')
        need(typeof u.note === 'string' && u.note !== '', 'unavailable のとき claude.usage.note に理由を書く')
      }
      if (values.some(v => v === null) && u.source !== 'unavailable') need(typeof u.note === 'string' && u.note !== '', '取得できない値があるとき claude.usage.note に理由を書く')
    }
    need(nonNegInt(claude.deliveredChars), 'claude.deliveredChars は非負の整数')
    need(claude.estimatedInputTokens === null || nonNeg(claude.estimatedInputTokens), 'claude.estimatedInputTokens は非負の数か null')
    need(nullableStr(claude.estimateMethod), 'claude.estimateMethod は文字列か null')
    if (claude.estimatedInputTokens !== null) need(typeof claude.estimateMethod === 'string' && claude.estimateMethod !== '', '推計値には claude.estimateMethod が要る')
  }

  const timing = raw.timing
  need(isObj(timing) && nonNeg(timing.totalMs) && nonNeg(timing.localLlmMs), 'timing.totalMs / localLlmMs は非負の数')

  const llm = raw.localLlm
  if (!isObj(llm)) errs.push('localLlm がない')
  else {
    need(typeof llm.attempted === 'boolean' && typeof llm.applied === 'boolean' && typeof llm.fallback === 'boolean', 'localLlm.attempted / applied / fallback は真偽値')
    need(nonNegInt(llm.calls) && strArray(llm.reasons), 'localLlm.calls は非負の整数、reasons は文字列の配列')
    if (llm.applied === true) need(llm.fallback === false, 'applied と fallback は同時に真にならない')
    if (llm.fallback === true) need(llm.attempted === true, 'fallback は通信した場合だけ真になる')
  }

  const f = raw.followUps
  need(isObj(f) && nonNegInt(f.count) && nonNegInt(f.chars) && strArray(f.steps), 'followUps.count / chars は非負の整数、steps は文字列の配列')

  const a = raw.accuracy
  if (!isObj(a)) errs.push('accuracy がない')
  else {
    need(nonNegInt(a.required) && nonNegInt(a.firstPassFound) && nonNegInt(a.distractorsReturned), 'accuracy.required / firstPassFound / distractorsReturned は非負の整数')
    need(strArray(a.firstPassMissed) && strArray(a.finalMissed), 'accuracy.firstPassMissed / finalMissed は文字列の配列')
    need(typeof a.passed === 'boolean', 'accuracy.passed は真偽値')
    if (typeof a.passed === 'boolean' && strArray(a.finalMissed)) need(a.passed === ((a.finalMissed as string[]).length === 0), 'accuracy.passed は finalMissed が空かどうかと一致する')
  }
  need(nullableStr(raw.notes), 'notes は文字列か null')
  return errs
}

/** JSON Lines を読み、有効なレコードと形式エラーに分ける。 */
export const parseRecords = (text: string): { records: EvalRecord[]; errors: string[] } => {
  const records: EvalRecord[] = []
  const errors: string[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    try {
      const v = JSON.parse(line)
      const errs = validateRecord(v)
      if (errs.length === 0) records.push(v as EvalRecord)
      else errors.push(`${i + 1} 行目: ${errs.join(' / ')}`)
    } catch {
      errors.push(`${i + 1} 行目: JSON として読めない`)
    }
  })
  return { records, errors }
}
