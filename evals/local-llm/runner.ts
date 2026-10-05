// 1 ケース・1 条件・1 試行を、実際の plugin の register.ts を模擬エンジンに載せて走らせ、計測レコードを作る。
// plugin の挙動 (auto の条件・返却形式・失敗時の戻り方) は plugin 自身のコードに任せ、ここでは再実装しない。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Spec, type World, boot } from '../../tests/integration/harness'
import { installed } from '../../tests/integration/fixtures'
import { type EvalCase, type LogInput, type SearchInput, type WebInput, loadFixture } from './cases'
import { countDistractors, judge, judgeAll } from './judge'
import type { MockHttp } from './mock-ollama'
import { type Condition, type EvalRecord, type Kind, type Source, type Warmth, SCHEMA_VERSION } from './schema'

const REPO = join(import.meta.dir, '../..')

export type Config = Record<string, string | number>

/** 共通基盤の9キーのうち llmMode 以外の既定値。 */
export const DEFAULT_CONFIG: Config = {
  ollamaUrl: 'http://localhost:11434',
  models: 'mock-a,mock-b',
  timeoutSeconds: 30,
  totalTimeoutSeconds: 60,
  maxAttempts: 2,
  keepAlive: '1m',
  maxInputChars: 12000,
  maxOutputChars: 4000,
}

type Harness = Awaited<ReturnType<typeof boot>>
type Reply = { result?: string; deny?: string }

type Adapter = {
  plugin: string
  /** 検証対象 plugin の register.ts。 */
  dir: string
  proc: (c: EvalCase, fixture: string) => World['proc']
  /** session.start のあとの準備。 */
  prepare?: (h: Harness, c: EvalCase) => Promise<void>
  first: (h: Harness, c: EvalCase) => Promise<Reply>
  /** 初回で必要情報が足りなかったときの原文の取り直し。 */
  followUp: { step: string; run: (h: Harness, c: EvalCase, fixture: string) => Promise<Reply> }
  /** ローカルLLMの結果を返却に使ったと分かる目印。plugin の返却文言に基づく。 */
  applied: (text: string) => boolean
}

const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
const fail = { exitCode: 1, stdout: '', stderr: 'unexpected' }
const text = (r: Reply) => r.result ?? r.deny ?? ''

const ADAPTERS: Record<Kind, Adapter> = {
  search: {
    plugin: 'code-finder',
    dir: 'code-finder/hooks/register.ts',
    proc: (_c, fixture) => installed(['fd', 'rg'], argv => (argv[0] === 'rg' ? out(fixture) : fail)),
    first: (h, c) => h.toolCall({ tool: 'mcp__code-finder__search_code', ...(c.input as SearchInput) }),
    followUp: {
      step: 'search_code を raw: true で再実行',
      run: (h, c) => h.toolCall({ tool: 'mcp__code-finder__search_code', ...(c.input as SearchInput), raw: true }),
    },
    applied: t => t.includes('[ローカルLLMによる絞り込み'),
  },
  web: {
    plugin: 'ctxpack-fetch',
    dir: 'ctxpack-fetch/hooks/register.ts',
    proc: (_c, fixture) => installed(['ctxpack'], argv => (argv[0] === 'ctxpack' ? out(fixture) : fail)),
    first: (h, c) => h.toolCall({ tool: 'mcp__ctxpack-fetch__fetch_page', ...(c.input as WebInput) }),
    followUp: {
      step: 'fetch_page を full: true で再実行',
      run: (h, c) => h.toolCall({ tool: 'mcp__ctxpack-fetch__fetch_page', ...(c.input as WebInput), full: true }),
    },
    applied: t => t.includes('抽出: ローカルLLMが'),
  },
  log: {
    plugin: 'verification-gate',
    dir: 'verification-gate/hooks/register.ts',
    proc: (c, fixture) =>
      installed([], argv => (argv.join('\0') === (c.input as LogInput).command.join('\0') ? { exitCode: 1, stdout: '', stderr: fixture } : fail)),
    prepare: async (h, c) => {
      const mem = new Map<string, unknown>()
      h.engine.store = { get: async (k: string) => mem.get(k), set: async (k: string, v: unknown) => void mem.set(k, v) }
      const { id, description, command } = c.input as LogInput
      await h.toolCall({ tool: 'mcp__verification-gate__verify_define', conditions: [{ id, description, command }] })
    },
    first: (h, c) => h.toolCall({ tool: 'mcp__verification-gate__verify_run', id: (c.input as LogInput).id }),
    // verification-gate に全文を返す手段はないため、コマンドを実行し直して全出力を読む操作をそのまま模擬する。
    followUp: { step: '検証コマンドを再実行して全出力を読む (模擬)', run: async (_h, _c, fixture) => ({ result: fixture }) },
    applied: t => t.includes('ローカルLLMが選んだ'),
  },
}

const pluginVersion = (plugin: string): string => {
  try {
    return String(JSON.parse(readFileSync(join(REPO, 'plugins', plugin, '.claude-plugin/plugin.json'), 'utf8')).version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

/** 実時間で動く clock。boot() の模擬 clock は進めない限り sleep が解決せず、タイムアウトが働かない。 */
const realSleep = (timers: Set<ReturnType<typeof setTimeout>>) => (ms: number, o?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => (timers.delete(t), resolve()), ms)
    t.unref?.()
    timers.add(t)
    o?.signal?.addEventListener('abort', () => (clearTimeout(t), timers.delete(t), reject(new Error('aborted'))))
  })

export type TrialOptions = {
  source: Exclude<Source, 'manual'>
  c: EvalCase
  condition: Condition
  trial: number
  runId: string
  /** ollama への通信。モックまたは実通信。 */
  http: MockHttp
  config?: Config
  warmth?: { ollama: Warmth; claudeCache: Warmth }
  localModels?: string[]
  ollamaVersion?: string | null
  /** 実時間の clock で動かす (plugin の timeoutSeconds が働く)。既定は ollama のとき true、モックは false。 */
  realClock?: boolean
}

const NO_CLAUDE: Record<'mock' | 'ollama', string> = {
  mock: 'モック実行のため Claude を使っていない',
  ollama: 'plugin と実 ollama だけの実行で Claude を使っていない。Claude の使用量は手動測定の記録 (source: manual) で取る',
}

export async function runTrial(o: TrialOptions): Promise<EvalRecord> {
  const adapter = ADAPTERS[o.c.kind]
  const fixture = loadFixture(o.c)
  const config: Config = { ...DEFAULT_CONFIG, ...o.config, llmMode: o.condition }

  // 応答しなかった通信 (タイムアウト) は、試行の終わりまでを待ち時間に数える。
  const waits: { t0: number; done?: number }[] = []
  const http: World['http'] = async (url, init) => {
    const w: { t0: number; done?: number } = { t0: Date.now() }
    waits.push(w)
    try {
      return await o.http(url, init)
    } finally {
      w.done = Date.now()
    }
  }

  const spec: Spec = { name: adapter.plugin, dir: adapter.dir, options: config }
  const h = await boot([spec], { proc: adapter.proc(o.c, fixture), http })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  if (o.realClock ?? o.source === 'ollama') h.engine.clock = { ...h.engine.clock, sleep: realSleep(timers) }
  await h.start()
  await adapter.prepare?.(h, o.c)

  const started = Date.now()
  const first = text(await adapter.first(h, o.c))
  const texts = [first]
  const missedFirst = judge(first, o.c.required).missed
  const steps: string[] = []
  let followChars = 0
  if (missedFirst.length > 0) {
    const again = text(await adapter.followUp.run(h, o.c, fixture))
    texts.push(again)
    steps.push(adapter.followUp.step)
    followChars = again.length
  }
  const ended = Date.now()
  const totalMs = ended - started
  for (const t of timers) clearTimeout(t)
  const calls = waits.length
  const waitMs = waits.reduce((n, w) => n + ((w.done ?? ended) - w.t0), 0)

  const finalMissed = judgeAll(texts, o.c.required).missed
  const reasons = h.logs.flatMap(l => [...l.matchAll(/reason=(\w+)/g)].map(m => m[1]!))
  const applied = adapter.applied(first)
  const attempted = calls > 0

  return {
    schemaVersion: SCHEMA_VERSION,
    source: o.source,
    runId: o.runId,
    caseId: o.c.id,
    kind: o.c.kind,
    condition: o.condition,
    trial: o.trial,
    warmth: o.warmth ?? { ollama: 'not_applicable', claudeCache: 'not_applicable' },
    environment: {
      claudeModel: null,
      localModels: o.localModels ?? String(config.models).split(',').map(s => s.trim()),
      ollamaUrl: o.source === 'ollama' ? String(config.ollamaUrl) : null,
      ollamaVersion: o.ollamaVersion ?? null,
      config,
      pluginVersions: { [adapter.plugin]: pluginVersion(adapter.plugin) },
      platform: `${process.platform}-${process.arch}`,
      runtime: `bun ${Bun.version}`,
    },
    claude: {
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: 'unavailable', note: NO_CLAUDE[o.source] },
      deliveredChars: first.length + followChars,
      estimatedInputTokens: null,
      estimateMethod: null,
    },
    timing: { totalMs, localLlmMs: waitMs },
    localLlm: { attempted, calls, applied, fallback: attempted && !applied, reasons },
    followUps: { count: steps.length, chars: followChars, steps },
    accuracy: {
      required: o.c.required.length,
      firstPassFound: o.c.required.length - missedFirst.length,
      firstPassMissed: missedFirst,
      finalMissed,
      passed: finalMissed.length === 0,
      distractorsReturned: countDistractors(first, o.c.distractors),
    },
    notes: null,
  }
}

const rotate = <T>(xs: readonly T[], n: number): T[] => xs.map((_, i) => xs[(i + n) % xs.length]!)

/** 条件の順序は試行ごとに回し、順序の影響を片寄らせない。ローカルLLMを使う条件の前に warmthFor で ollama のモデルの状態を整え、観測した状態を記録する。 */
export async function runMatrix(o: {
  cases: readonly EvalCase[]
  conditions: readonly Condition[]
  trials: number
  runId: string
  source: Exclude<Source, 'manual'>
  httpFor: (c: EvalCase) => MockHttp
  config?: Config
  /** ollama のモデルを cold / warm にして、観測した状態を返す。省略時は not_applicable。 */
  warmthFor?: () => Promise<Warmth>
  localModels?: string[]
  ollamaVersion?: string | null
  realClock?: boolean
}): Promise<EvalRecord[]> {
  const records: EvalRecord[] = []
  for (let trial = 1; trial <= o.trials; trial++)
    for (const c of o.cases)
      for (const condition of rotate(o.conditions, trial - 1)) {
        const ollama: Warmth = condition === 'off' || o.warmthFor === undefined ? 'not_applicable' : await o.warmthFor()
        records.push(
          await runTrial({
            source: o.source, c, condition, trial, runId: o.runId, http: o.httpFor(c), warmth: { ollama, claudeCache: 'not_applicable' },
            config: o.config, localModels: o.localModels, ollamaVersion: o.ollamaVersion, realClock: o.realClock,
          }),
        )
      }
  return records
}
