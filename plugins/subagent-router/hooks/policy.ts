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
}

const DEFAULT_MODELS = ['tev1:4b', 'nimble']

export const readConfig = (o: Record<string, unknown> | undefined): Config => {
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
  const list =
    typeof o?.models === 'string'
      ? o.models
          .split(',')
          .map(s => s.trim())
          .filter(s => s !== '')
      : []
  return {
    ollamaUrl: (typeof o?.ollamaUrl === 'string' && o.ollamaUrl !== '' ? o.ollamaUrl : 'http://localhost:11434').replace(/\/+$/, ''),
    models: list.length > 0 ? list : DEFAULT_MODELS,
    timeoutMs: num(o?.timeoutSeconds, 30, 5, 120) * 1000,
    skipTurns: num(o?.skipTurns, 5, 0, 50),
    keepAlive: typeof o?.keepAlive === 'string' && o.keepAlive !== '' ? o.keepAlive : '1m',
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

export const parseDecision = (text: string): Decision | undefined => {
  try {
    const v = JSON.parse(text) as { model?: unknown; effort?: unknown }
    const model = MODELS.find(m => m === v.model)
    const effort = EFFORTS.find(x => x === v.effort)
    return model !== undefined && effort !== undefined ? { model, effort } : undefined
  } catch {
    return undefined
  }
}

export const buildBody = (cfg: Config, model: string, content: string) =>
  JSON.stringify({
    model,
    stream: false,
    think: false,
    format: SCHEMA,
    keep_alive: cfg.keepAlive,
    options: { temperature: 0 },
    messages: [{ role: 'user', content }],
  })

/** 失敗したモデルを skipTurns 回の起動のあいだ飛ばす。全部飛ばす状況では最後の 1 つを試す。 */
export const pickCandidates = (models: readonly string[], cooldown: ReadonlyMap<string, number>): string[] => {
  const live = models.filter(m => (cooldown.get(m) ?? 0) <= 0)
  const last = models[models.length - 1]
  return live.length > 0 ? live : last === undefined ? [] : [last]
}

export const tick = (cooldown: Map<string, number>) => {
  for (const [k, v] of cooldown) {
    if (v <= 1) cooldown.delete(k)
    else cooldown.set(k, v - 1)
  }
}
