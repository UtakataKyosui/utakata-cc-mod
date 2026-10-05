// 評価の実行とレポート生成。
//   bun run evals/local-llm/run.ts mock   [--strategy oracle] [--trials 3] [--out evals/local-llm/out/mock.jsonl]
//   bun run evals/local-llm/run.ts ollama [--url http://localhost:11434] [--models a,b] [--trials 3] [--warmth cold|warm|observe] [--out ...]
//   bun run evals/local-llm/run.ts report <records.jsonl>... [--out report.md] [--chars-per-token 4]
//   bun run evals/local-llm/run.ts template --case <id> --condition <off|auto|always>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type EvalCase, loadCases } from './cases'
import { type MockHttp, type Strategy, STRATEGIES, mockOllama } from './mock-ollama'
import { WARM_MODES, type WarmMode, createControl } from './ollama-control'
import { renderReport } from './report'
import { type Config, DEFAULT_CONFIG, runMatrix } from './runner'
import { type Condition, type EvalRecord, CONDITIONS, SCHEMA_VERSION, parseRecords } from './schema'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const die = (msg: string): never => {
  console.error(msg)
  process.exit(2)
}

const pickCases = (): EvalCase[] => {
  const ids = flag('cases')?.split(',').map(s => s.trim())
  const all = loadCases()
  if (ids === undefined) return all
  const missing = ids.filter(id => !all.some(c => c.id === id))
  if (missing.length > 0) die(`未知のケース: ${missing.join(', ')}`)
  return all.filter(c => ids.includes(c.id))
}

const pickConditions = (): Condition[] => {
  const v = flag('conditions')?.split(',').map(s => s.trim())
  if (v === undefined) return [...CONDITIONS]
  const bad = v.filter(x => !CONDITIONS.includes(x as Condition))
  if (bad.length > 0) die(`未知の条件: ${bad.join(', ')}`)
  return v as Condition[]
}

const trials = (): number => {
  const n = Number(flag('trials') ?? 3)
  return Number.isInteger(n) && n >= 1 ? n : die('--trials は 1 以上の整数')
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  console.error(`書き出した: ${path}`)
}

const jsonl = (rs: readonly EvalRecord[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n'
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const realHttp = (): MockHttp => async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init?.body })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

async function main() {
  if (cmd === 'mock') {
    const strategy = (flag('strategy') ?? 'oracle') as Strategy
    if (!STRATEGIES.includes(strategy)) die(`--strategy は ${STRATEGIES.join(' / ')}`)
    const runId = `mock-${strategy}-${stamp()}`
    const records = await runMatrix({
      cases: pickCases(), conditions: pickConditions(), trials: trials(), runId, source: 'mock',
      httpFor: c => mockOllama(strategy, c).http, localModels: [`mock:${strategy}`],
    })
    const out = flag('out') ?? `evals/local-llm/out/${runId}.jsonl`
    write(out, jsonl(records))
    console.log(renderReport(records))
    return
  }
  if (cmd === 'ollama') {
    const url = (flag('url') ?? String(DEFAULT_CONFIG.ollamaUrl)).replace(/\/+$/, '')
    const models = flag('models') ?? String(DEFAULT_CONFIG.models).replace('mock-a,mock-b', 'tev1:4b,nimble')
    const warmth = (flag('warmth') ?? 'observe') as WarmMode
    if (!WARM_MODES.includes(warmth)) die(`--warmth は ${WARM_MODES.join(' / ')}`)
    const version = await fetch(`${url}/api/version`).then(r => r.json() as Promise<{ version?: string }>).then(j => j.version ?? null, () => null)
    if (version === null) die(`${url} の ollama に接続できない。起動とモデルの取得を確認すること`)
    const config: Config = { ...DEFAULT_CONFIG, ollamaUrl: url, models }
    const modelList = models.split(',').map(s => s.trim())
    const control = createControl({ url, models: modelList })
    const runId = `ollama-${warmth}-${stamp()}`
    const records = await runMatrix({
      cases: pickCases(), conditions: pickConditions(), trials: trials(), runId, source: 'ollama',
      httpFor: () => realHttp(), config, warmthFor: () => control.prepare(warmth),
      localModels: modelList, ollamaVersion: version,
    })
    write(flag('out') ?? `evals/local-llm/out/${runId}.jsonl`, jsonl(records))
    console.log(renderReport(records))
    return
  }
  if (cmd === 'report') {
    const files = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1]?.startsWith('--') ?? false))
    if (files.length === 0) die('使い方: report <records.jsonl>... [--out report.md] [--chars-per-token N]')
    const parsed = files.map(f => parseRecords(readFileSync(f, 'utf8')))
    const cpt = flag('chars-per-token')
    const md = renderReport(parsed.flatMap(p => p.records), { charsPerToken: cpt === undefined ? undefined : Number(cpt), invalid: parsed.flatMap((p, i) => p.errors.map(e => `${files[i]}: ${e}`)) })
    const out = flag('out')
    if (out === undefined) console.log(md)
    else write(out, md)
    return
  }
  if (cmd === 'template') {
    const c = loadCases().find(x => x.id === flag('case')) ?? die('--case にケース ID を指定する')
    const condition = flag('condition') as Condition
    if (!CONDITIONS.includes(condition)) die(`--condition は ${CONDITIONS.join(' / ')}`)
    const rec: EvalRecord = {
      schemaVersion: SCHEMA_VERSION, source: 'manual', runId: 'manual-YYYYMMDD', caseId: c!.id, kind: c!.kind, condition, trial: 1,
      warmth: { ollama: 'unknown', claudeCache: 'unknown' },
      environment: { claudeModel: null, localModels: [], ollamaUrl: null, ollamaVersion: null, config: { llmMode: condition }, pluginVersions: {}, platform: `${process.platform}-${process.arch}`, runtime: 'claude-code ?' },
      claude: { usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: 'unavailable', note: '/budget status から転記する。取得できなければ理由を書く' }, deliveredChars: 0, estimatedInputTokens: null, estimateMethod: null },
      timing: { totalMs: 0, localLlmMs: 0 },
      localLlm: { attempted: false, calls: 0, applied: false, fallback: false, reasons: [] },
      followUps: { count: 0, chars: 0, steps: [] },
      accuracy: { required: c!.required.length, firstPassFound: 0, firstPassMissed: c!.required.map(r => r.id), finalMissed: c!.required.map(r => r.id), passed: false, distractorsReturned: 0 },
      notes: null,
    }
    console.log(JSON.stringify(rec))
    return
  }
  die('使い方: run.ts mock | ollama | report | template (詳細は evals/local-llm/README.md)')
}

await main()
