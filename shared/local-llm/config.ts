export type LlmMode = 'off' | 'auto' | 'always'

export type LlmConfig = {
  mode: LlmMode
  ollamaUrl: string
  models: string[]
  timeoutMs: number
  totalTimeoutMs: number
  maxAttempts: number
  keepAlive: string
  maxInputChars: number
  maxOutputChars: number
}

export const LLM_DEFAULTS: LlmConfig = {
  mode: 'off',
  ollamaUrl: 'http://localhost:11434',
  models: ['tev1:4b', 'nimble'],
  timeoutMs: 30_000,
  totalTimeoutMs: 60_000,
  maxAttempts: 2,
  keepAlive: '1m',
  maxInputChars: 12_000,
  maxOutputChars: 4_000,
}

const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)

/** userConfig を丸め込み込みで解釈する。`defaults` で plugin ごとの既定値を差し替えられる。 */
export const readLlmConfig = (o: Record<string, unknown> | undefined, defaults: Partial<LlmConfig> = {}): LlmConfig => {
  const d = { ...LLM_DEFAULTS, ...defaults }
  const list =
    typeof o?.models === 'string'
      ? o.models
          .split(',')
          .map(s => s.trim())
          .filter(s => s !== '')
      : []
  const mode = typeof o?.llmMode === 'string' ? o.llmMode.trim().toLowerCase() : undefined
  return {
    mode: mode === 'off' || mode === 'auto' || mode === 'always' ? mode : d.mode,
    ollamaUrl: str(o?.ollamaUrl, d.ollamaUrl).replace(/\/+$/, ''),
    models: list.length > 0 ? list : d.models,
    timeoutMs: num(o?.timeoutSeconds, d.timeoutMs / 1000, 5, 120) * 1000,
    totalTimeoutMs: num(o?.totalTimeoutSeconds, d.totalTimeoutMs / 1000, 5, 600) * 1000,
    maxAttempts: Math.floor(num(o?.maxAttempts, d.maxAttempts, 1, 10)),
    keepAlive: str(o?.keepAlive, d.keepAlive),
    maxInputChars: Math.floor(num(o?.maxInputChars, d.maxInputChars, 500, 200_000)),
    maxOutputChars: Math.floor(num(o?.maxOutputChars, d.maxOutputChars, 200, 100_000)),
  }
}
