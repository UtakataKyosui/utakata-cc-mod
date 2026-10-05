// 評価一式の自動テスト。実 ollama・実 Claude は使わない (通信はモック)。
//   bun test ./evals
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadCases, loadFixture } from './cases'
import { countDistractors, judge, judgeAll, normalize } from './judge'
import { STRATEGIES, mockOllama, parseCandidates } from './mock-ollama'
import { createControl, isLoaded } from './ollama-control'
import { aggregate, renderReport, stat } from './report'
import { runMatrix, runTrial } from './runner'
import { type Condition, type EvalRecord, CONDITIONS, parseRecords, validateRecord } from './schema'

const cases = loadCases()
const byId = (id: string) => cases.find(c => c.id === id)!
const run = (id: string, condition: Condition, strategy: (typeof STRATEGIES)[number] = 'oracle', trial = 1, latencyMs?: number) => {
  const c = byId(id)
  return runTrial({ source: 'mock', c, condition, trial, runId: 'test', http: mockOllama(strategy, c, { latencyMs }).http, localModels: [`mock:${strategy}`] })
}

describe('フィクスチャとケース定義', () => {
  test('検索・Web抽出・ログ抽出の3系統があり、ID は重複しない', () => {
    expect(new Set(cases.map(c => c.kind))).toEqual(new Set(['search', 'web', 'log']))
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
  })

  test('fixture が存在し、必要情報は原文に実在し、誤誘導も原文にある', () => {
    for (const c of cases) {
      expect(existsSync(join(ROOT, c.fixture))).toBe(true)
      expect(c.required.length).toBeGreaterThan(0)
      expect(judge(loadFixture(c), c.required).missed).toEqual([])
      expect(countDistractors(loadFixture(c), c.distractors)).toBe(c.distractors.length)
    }
  })

  test('機密を含まない合成データである (メール・実在らしい URL・パス・鍵らしい値がない)', () => {
    for (const f of readdirSync(join(ROOT, 'fixtures'))) {
      const t = readFileSync(join(ROOT, 'fixtures', f), 'utf8')
      expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
      expect(t).not.toMatch(/\/Users\/|\/home\/|C:\\/)
      expect(t).not.toMatch(/\b(?:sk|ghp|xox[bp])[-_][A-Za-z0-9]{8,}/)
      for (const m of t.matchAll(/https?:\/\/([^\s/)]+)/g)) expect(m[1]).toEndWith('.invalid')
    }
  })

  test('関連箇所は先頭ではなく中間・末尾にある (先頭だけ見ても取れない配置)', () => {
    for (const c of cases.filter(c => c.kind !== 'log' && c.id !== 'search-small')) {
      const t = loadFixture(c)
      const first = c.kind === 'search' ? t.split('\n').slice(0, 3).join('\n') : t.slice(0, 600)
      expect(judge(first, c.required).found).toEqual([])
    }
  })
})

describe('取りこぼしの判定', () => {
  test('空白の違いは無視し、無いものは missed に入る', () => {
    expect(normalize('  a \n  b\t c ')).toBe('a b c')
    const req = [{ id: 'x', text: 'foo  bar' }, { id: 'y', text: 'baz' }]
    expect(judge('foo\nbar と qux', req)).toEqual({ found: ['x'], missed: ['y'] })
    expect(judgeAll(['foo bar', 'baz'], req).missed).toEqual([])
    expect(countDistractors('abc def', ['abc', 'zzz', 'def'])).toBe(2)
  })

  test('モックの候補パーサは続き行を含む候補を読む', () => {
    expect(parseCandidates('前置き\n[1] a\n    b\n[2] c\n[10] d')).toEqual([
      { id: 1, text: 'a\nb' },
      { id: 2, text: 'c' },
      { id: 10, text: 'd' },
    ])
  })
})

describe('plugin 本体を通した off / auto / always (oracle)', () => {
  test('3系統 × 3条件で必要情報が揃い、レコードは形式を満たす', async () => {
    for (const c of cases) {
      for (const condition of CONDITIONS) {
        const r = await run(c.id, condition)
        expect(validateRecord(r)).toEqual([])
        expect(r.accuracy.passed).toBe(true)
        expect(r.environment.config.llmMode).toBe(condition)
      }
    }
  })

  test('off は通信せず、auto は大きい入力だけ、always は小さい入力でも通信する', async () => {
    for (const c of cases) {
      const off = await run(c.id, 'off')
      expect(off.localLlm).toMatchObject({ attempted: false, calls: 0, applied: false, fallback: false })
      const auto = await run(c.id, 'auto')
      const always = await run(c.id, 'always')
      expect(always.localLlm).toMatchObject({ attempted: true, applied: true, fallback: false })
      expect(auto.localLlm.attempted).toBe(c.id !== 'search-small')
    }
  })

  test('絞り込み・抽出が効くと、Claude へ返す文字数は off より少なくなる (配線の確認で、効果の測定ではない)', async () => {
    for (const id of ['search-tail', 'web-tail', 'log-head']) {
      const off = await run(id, 'off')
      const auto = await run(id, 'auto')
      expect(auto.claude.deliveredChars).toBeLessThan(off.claude.deliveredChars)
    }
  })

  test('off では末尾だけを返すログが、先頭や中間の原因を落とし、追加取得が1回要る', async () => {
    for (const id of ['log-head', 'log-middle']) {
      const off = await run(id, 'off')
      expect(off.accuracy.firstPassMissed.length).toBe(byId(id).required.length)
      expect(off.followUps).toMatchObject({ count: 1 })
      expect(off.accuracy.passed).toBe(true)
      const auto = await run(id, 'auto')
      expect(auto.accuracy.firstPassMissed).toEqual([])
      expect(auto.followUps.count).toBe(0)
    }
  })

  test('追加取得の文字数は返却文字数に含まれる', async () => {
    const off = await run('log-head', 'off')
    expect(off.followUps.chars).toBeGreaterThan(0)
    expect(off.claude.deliveredChars).toBeGreaterThan(off.followUps.chars)
  })
})

describe('取りこぼしと失敗時の動作 (戦略を変えたモック)', () => {
  test('head-biased は末尾の必要情報を落とし、raw: true の取り直しで補う', async () => {
    const r = await run('search-similar', 'auto', 'head-biased')
    expect(r.accuracy.firstPassMissed).toEqual(expect.arrayContaining(['definition']))
    expect(r.followUps.count).toBe(1)
    expect(r.followUps.steps[0]).toContain('raw: true')
    expect(r.accuracy.passed).toBe(true)
    expect(r.localLlm.applied).toBe(true)
  })

  test('取り直しでも揃わなければ passed が偽になる (判定ロジックが取りこぼしを見逃さない)', async () => {
    const c = { ...byId('search-tail'), required: [{ id: 'absent', text: '原文に存在しない文字列' }] }
    const r = await runTrial({ source: 'mock', c, condition: 'auto', trial: 1, runId: 't', http: mockOllama('oracle', c).http })
    expect(r.accuracy.passed).toBe(false)
    expect(r.accuracy.finalMissed).toEqual(['absent'])
    expect(validateRecord(r)).toEqual([])
  })

  test('bait-follower は指示文の候補を選び、必要情報を落とす。誤誘導の混入が数えられる', async () => {
    const r = await run('web-injection', 'always', 'bait-follower')
    expect(r.accuracy.firstPassMissed).toEqual(['payload-default'])
    expect(r.accuracy.distractorsReturned).toBe(1)
    expect(r.followUps.steps[0]).toContain('full: true')
    expect(r.accuracy.passed).toBe(true)
  })

  test('down は既存の結果へ戻り (フォールバック)、必要情報は落ちない', async () => {
    for (const id of ['search-tail', 'web-tail']) {
      const r = await run(id, 'always', 'down')
      expect(r.localLlm).toMatchObject({ attempted: true, applied: false, fallback: true })
      expect(r.localLlm.reasons).toContain('http')
      expect(r.accuracy.passed).toBe(true)
      expect(r.followUps.count).toBe(0)
    }
    const log = await run('log-head', 'always', 'down')
    expect(log.localLlm.fallback).toBe(true)
    expect(log.followUps.count).toBe(1)
  })

  test('invalid (存在しない ID) は不正な応答として捨て、既存の結果へ戻る', async () => {
    const r = await run('search-tail', 'always', 'invalid')
    expect(r.localLlm).toMatchObject({ attempted: true, applied: false, fallback: true })
    expect(r.localLlm.reasons).toContain('semantic')
    expect(r.accuracy.passed).toBe(true)
  })

  test('ローカルLLMの待ち時間は通信の所要時間から測る', async () => {
    const r = await run('search-tail', 'auto', 'oracle', 1, 20)
    expect(r.timing.localLlmMs).toBeGreaterThanOrEqual(15)
    expect(r.timing.totalMs).toBeGreaterThanOrEqual(r.timing.localLlmMs)
    expect((await run('search-tail', 'off', 'oracle', 1, 20)).timing.localLlmMs).toBe(0)
  })
})

describe('レコードの形式', () => {
  const base = async () => structuredClone(await run('search-tail', 'auto'))

  test('モック実行の Claude 使用量は null と理由で、実測と区別できる', async () => {
    const r = await base()
    expect(r.claude.usage).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: 'unavailable' })
    expect(r.claude.usage.note).toContain('Claude を使っていない')
    expect(r.claude.estimatedInputTokens).toBeNull()
    expect(r.claude.deliveredChars).toBeGreaterThan(0)
    expect(r.environment.pluginVersions['code-finder']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('不正な値を検出する', async () => {
    const mutate = async (f: (r: any) => void) => {
      const r: any = await base()
      f(r)
      return validateRecord(r)
    }
    expect(await mutate(r => (r.condition = 'sometimes'))).not.toEqual([])
    expect(await mutate(r => (r.trial = 0))).not.toEqual([])
    expect(await mutate(r => (r.claude.usage.note = null))).not.toEqual([])
    expect(await mutate(r => (r.claude.usage.inputTokens = 10))).not.toEqual([])
    expect(await mutate(r => (r.claude.estimatedInputTokens = 100))).not.toEqual([])
    expect(await mutate(r => (r.accuracy.passed = false))).not.toEqual([])
    expect(await mutate(r => (r.localLlm.fallback = true))).not.toEqual([])
    expect(await mutate(r => delete r.timing)).not.toEqual([])
    expect(validateRecord('x')).not.toEqual([])
  })

  test('実測・推計の記録は有効で、欠損には理由が要る', async () => {
    const r: any = await base()
    r.source = 'manual'
    r.claude.usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: null, source: 'measured', note: 'キャッシュ書込は /budget status に出ない' }
    expect(validateRecord(r)).toEqual([])
    r.claude.usage.note = null
    expect(validateRecord(r)).not.toEqual([])
    r.claude.usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'estimated', note: null }
    r.claude.estimatedInputTokens = 100
    r.claude.estimateMethod = '返却文字数 ÷ 4 (仮定)'
    expect(validateRecord(r)).toEqual([])
  })

  test('JSON Lines は有効な行と形式エラーに分けて読む', async () => {
    const good = JSON.stringify(await base())
    const { records, errors } = parseRecords(`${good}\n\n{"x":1}\nnot json\n${good}\n`)
    expect(records).toHaveLength(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('3 行目')
    expect(errors[1]).toContain('4 行目')
  })

  test('同じ入力・戦略なら、時間以外のレコードは再現する', async () => {
    const strip = (r: EvalRecord) => ({ ...r, timing: undefined, runId: undefined })
    expect(strip(await run('web-tail', 'always'))).toEqual(strip(await run('web-tail', 'always')))
  })
})

describe('集計とレポート', () => {
  test('stat は平均・中央値・最小・最大を返す', () => {
    expect(stat([1, 2, 3, 10])).toEqual({ mean: 4, median: 2.5, min: 1, max: 10 })
    expect(stat([])).toEqual({ mean: 0, median: 0, min: 0, max: 0 })
  })

  const matrix = (trials: number, strategy: (typeof STRATEGIES)[number] = 'oracle') =>
    runMatrix({ cases, conditions: CONDITIONS, trials, runId: 'r', source: 'mock', httpFor: c => mockOllama(strategy, c).http, localModels: [`mock:${strategy}`] })

  test('試行を重ねると source・ケース・条件ごとに集計される', async () => {
    const rs = await matrix(3)
    expect(rs).toHaveLength(cases.length * 3 * 3)
    expect(new Set(rs.map(r => r.trial))).toEqual(new Set([1, 2, 3]))
    const gs = aggregate(rs)
    expect(gs).toHaveLength(cases.length * 3)
    const g = gs.find(x => x.caseId === 'log-head' && x.condition === 'off')!
    expect(g).toMatchObject({ trials: 3, passed: 3, firstPassComplete: 0, attempted: 0 })
    expect(g.followUps.mean).toBe(1)
    expect(gs.find(x => x.caseId === 'search-small' && x.condition === 'auto')).toMatchObject({ attempted: 0, applied: 0 })
    expect(gs.find(x => x.caseId === 'search-small' && x.condition === 'always')).toMatchObject({ attempted: 3, applied: 3 })
  })

  test('レポートは必要情報の達成・追加取得・所要時間・フォールバックを示し、モックの比率は出さない', async () => {
    const md = renderReport(await matrix(3))
    expect(md).toContain('# ローカルLLM併用の評価レポート')
    expect(md).toContain('実際の効果の測定ではない')
    expect(md).toContain('| log-head | off | 3 | 3/3 | 0/3 | 1 |')
    expect(md).toContain('総所要 ms')
    expect(md).toContain('ローカルLLM待ち ms')
    expect(md).toContain('通信 / 使用 / フォールバック')
    expect(md).toContain('取得不能')
    expect(md).toContain('算出しない (モック)')
    expect(md).not.toMatch(/\d\.\d\dx/)
    expect(md).not.toContain('試行が 3 回未満')
  })

  test('試行が少ない組には注意書きが付く', async () => {
    expect(renderReport(await matrix(2))).toContain('試行が 3 回未満の組がある')
  })

  test('取りこぼしとフォールバックは集計に出る', async () => {
    const md = renderReport(await matrix(3, 'head-biased'))
    expect(md).toMatch(/\| search-similar \| auto \| 3 \| 3\/3 \| 0\/3 \| 1 \|/)
    const down = aggregate(await matrix(3, 'down')).find(g => g.caseId === 'search-tail' && g.condition === 'always')!
    expect(down).toMatchObject({ attempted: 3, applied: 0, fallback: 3, passed: 3 })
  })

  test('source は混ぜず節を分ける。manual の実測は数値、取得不能は理由付きで出る', async () => {
    const mock = await run('search-tail', 'auto')
    const manual: EvalRecord = structuredClone(mock)
    manual.source = 'manual'
    manual.claude.usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: null, source: 'measured', note: 'キャッシュ書込は取得できなかった' }
    manual.environment.claudeModel = 'claude-x'
    const off: EvalRecord = { ...structuredClone(manual), condition: 'off', claude: { ...manual.claude, deliveredChars: manual.claude.deliveredChars * 10 } }
    const gs = aggregate([mock, manual, off])
    expect(gs.map(g => g.source)).toEqual(['mock', 'manual', 'manual'])
    expect(gs.every(g => g.trials === 1)).toBe(true)
    const md = renderReport([mock, manual, off], { charsPerToken: 4, invalid: ['bad.jsonl: 1 行目: JSON として読めない'] })
    expect(md.indexOf('## mock (モック)')).toBeLessThan(md.indexOf('## manual (実 Claude・手動測定)'))
    expect(md).toContain('| search-tail | auto | 1 / 0 / 0 | 1000 | 200 | 5000 | 取得不能 |')
    expect(md).toContain('0.10x')
    expect(md).toContain('キャッシュ書込は取得できなかった')
    expect(md).toContain('推計トークン (文字数÷4、仮定)')
    expect(md).toContain('## 除外したレコード')
  })

  test('レコードがなければ、その旨だけを出す', () => {
    expect(renderReport([])).toContain('集計できるレコードがない')
  })
})

describe('実時間の clock (実 ollama の経路)', () => {
  test('応答しない ollama は timeoutSeconds で打ち切られ、フォールバックして待ち時間を記録する', async () => {
    const c = byId('search-tail')
    const r = await runTrial({
      source: 'mock', c, condition: 'always', trial: 1, runId: 't', http: () => new Promise(() => {}), realClock: true,
      config: { timeoutSeconds: 5, totalTimeoutSeconds: 5, maxAttempts: 1 },
    })
    expect(r.localLlm).toMatchObject({ attempted: true, applied: false, fallback: true })
    expect(r.localLlm.reasons).toContain('timeout')
    expect(r.timing.localLlmMs).toBeGreaterThanOrEqual(4500)
    expect(r.accuracy.passed).toBe(true)
    expect(validateRecord(r)).toEqual([])
  }, 15_000)
})

describe('条件の順序', () => {
  test('試行ごとに条件の順序を回す', async () => {
    const rs = await runMatrix({ cases: [byId('search-small')], conditions: CONDITIONS, trials: 3, runId: 'r', source: 'mock', httpFor: c => mockOllama('oracle', c).http })
    const order = (t: number) => rs.filter(r => r.trial === t).map(r => r.condition)
    expect(order(1)).toEqual(['off', 'auto', 'always'])
    expect(order(2)).toEqual(['auto', 'always', 'off'])
    expect(order(3)).toEqual(['always', 'off', 'auto'])
  })
})

describe('ollama の cold / warm の操作と観測', () => {
  /** /api/generate と /api/ps だけを持つ ollama の代役。unloadWorks が偽なら keep_alive 0 を無視する。 */
  const fake = (opts: { loaded?: string[]; unloadWorks?: boolean; psWorks?: boolean } = {}) => {
    const state = { loaded: new Set(opts.loaded ?? []), calls: [] as string[] }
    const fetch = async (url: string, init?: { body?: string }) => {
      state.calls.push(url.replace(/^.*\/api/, '/api'))
      if (url.endsWith('/api/ps')) return opts.psWorks === false ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ models: [...state.loaded].map(name => ({ name })) }) }
      const body = JSON.parse(init?.body ?? '{}')
      if (body.keep_alive === 0) {
        if (opts.unloadWorks !== false) state.loaded.delete(body.model)
      } else state.loaded.add(`${body.model}:latest`)
      return { ok: true, json: async () => ({}) }
    }
    return { state, control: createControl({ url: 'http://h', models: ['m1', 'm2'], fetch, wait: async () => {} }) }
  }

  test('モデル名は :latest 付きでも一致する', () => {
    expect(isLoaded(['m1:latest', 'x:7b'], 'm1')).toBe(true)
    expect(isLoaded(['x:7b'], 'm1')).toBe(false)
  })

  test('cold は読み込みを解除し、解除を確かめてから cold と記録する', async () => {
    const { state, control } = fake({ loaded: ['m1', 'm2'] })
    expect(await control.prepare('cold')).toBe('cold')
    expect(state.loaded.size).toBe(0)
  })

  test('cold にできなかった・確かめられなかったときは unknown (申告で cold にしない)', async () => {
    expect(await fake({ loaded: ['m1'], unloadWorks: false }).control.prepare('cold')).toBe('unknown')
    expect(await fake({ psWorks: false }).control.prepare('cold')).toBe('unknown')
  })

  test('warm は先頭のモデルを読み込み、読み込みを確かめてから warm と記録する', async () => {
    const { state, control } = fake()
    expect(await control.prepare('warm')).toBe('warm')
    expect([...state.loaded]).toEqual(['m1:latest'])
    expect(await fake({ psWorks: false }).control.prepare('warm')).toBe('unknown')
  })

  test('observe は操作せず、観測した状態を返す', async () => {
    const cold = fake()
    expect(await cold.control.prepare('observe')).toBe('cold')
    expect(cold.state.calls).toEqual(['/api/ps'])
    expect(await fake({ loaded: ['m1:latest'] }).control.prepare('observe')).toBe('warm')
    expect(await fake({ psWorks: false }).control.prepare('observe')).toBe('unknown')
  })

  test('記録の warmth には観測した状態が入り、off は not_applicable', async () => {
    const rs = await runMatrix({
      cases: [byId('search-small')], conditions: CONDITIONS, trials: 1, runId: 'r', source: 'mock', httpFor: c => mockOllama('oracle', c).http,
      warmthFor: async () => 'cold',
    })
    expect(Object.fromEntries(rs.map(r => [r.condition, r.warmth.ollama]))).toEqual({ off: 'not_applicable', auto: 'cold', always: 'cold' })
  })
})
