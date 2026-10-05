import { type LlmConfig, buildBody as buildLlmBody, pickCandidates, readLlmConfig, tick } from './local-llm'

export { pickCandidates, tick }

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type RouteModel = (typeof MODELS)[number]
export type RouteEffort = (typeof EFFORTS)[number]
export type Decision = { model: RouteModel; effort: RouteEffort }

export type Config = {
  ollamaUrl: string
  models: string[]
  timeoutMs: number
  skipTurns: number
  keepAlive: string
  llm: LlmConfig
}

export const readConfig = (o: Record<string, unknown> | undefined): Config => {
  const llm = readLlmConfig(o, { mode: 'always' })
  const skip = typeof o?.skipTurns === 'number' && Number.isFinite(o.skipTurns) ? Math.min(50, Math.max(0, o.skipTurns)) : 5
  return {
    ollamaUrl: llm.ollamaUrl,
    models: llm.models,
    timeoutMs: llm.timeoutMs,
    skipTurns: skip,
    keepAlive: llm.keepAlive,
    // 既存どおり全モデルを順に試す。待ち時間の上限は全モデル分のタイムアウトの合計
    llm: { ...llm, mode: 'always', maxAttempts: llm.models.length, totalTimeoutMs: llm.timeoutMs * llm.models.length, maxInputChars: Infinity, maxOutputChars: Infinity },
  }
}

export const SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string', enum: [...MODELS] },
    effort: { type: 'string', enum: [...EFFORTS] },
  },
  required: ['model', 'effort'],
}

const PROMPT_LIMIT = 4000

export const buildRequest = (task: { subagentType: string; description: string; prompt: string }) =>
  [
    'SubAgent に任せるタスクを読み、実行に適した model と effort を選ぶ。',
    '',
    'model:',
    '- haiku: 検索・ファイルの場所探し・要約・機械的な小さい編集',
    '- sonnet: 通常の実装・調査・レビュー・テスト作成',
    '- opus: 設計判断・原因不明のデバッグ・多数のファイルにまたがる変更',
    '',
    'effort:',
    '- low: 迷う余地のない作業',
    '- medium: 通常の作業',
    '- high: 慎重な推論が要る作業',
    '- xhigh, max: 難度が高く、失敗の代償が大きい作業だけ',
    '',
    '例:',
    '- README の場所を探す -> haiku / low',
    '- 関数に引数を1つ追加してテストを直す -> sonnet / medium',
    '- 認証基盤の設計を見直して移行計画を立てる -> opus / high',
    '',
    'タスク:',
    `agent type: ${task.subagentType}`,
    `description: ${task.description}`,
    `prompt:\n${task.prompt.slice(0, PROMPT_LIMIT)}`,
  ].join('\n')

export const toDecision = (v: unknown): Decision | undefined => {
  const d = v as { model?: unknown; effort?: unknown } | null
  const model = MODELS.find(m => m === d?.model)
  const effort = EFFORTS.find(x => x === d?.effort)
  return model !== undefined && effort !== undefined ? { model, effort } : undefined
}

export const parseDecision = (text: string): Decision | undefined => {
  try {
    return toDecision(JSON.parse(text))
  } catch {
    return undefined
  }
}

export const buildBody = (cfg: Config, model: string, content: string) => buildLlmBody(cfg, model, { prompt: content, schema: SCHEMA })
