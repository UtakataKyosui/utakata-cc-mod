// 実プラグインを同じ模擬エンジンに載せた組み合わせ検証。
//   bun test ./tests/integration/combinations.itest.ts
import { describe, expect, test } from 'bun:test'
import { boot, ids } from './harness'
import { ANSWER, BROKEN, COMPACT, CTX, FINDER, GOAL, NOTION, ROUTER, RUST, SC, installed, notionWorld, ollamaOk, writesOf } from './fixtures'

const DONE = { messages: [{ role: 'user', text: '要約', toolUses: [] }], tokensBefore: 130000, tokensAfter: 8000 }
const NO_URL = { tool: 'Write', file_path: '/repo/report.md', content: '出典のない調査メモ' }
const WITH_URL = { ...NO_URL, content: '調査メモ\n出典: https://example.com/doc' }

describe('ctxpack-fetch と source-citation', () => {
  test('source-citation を外側にすると、fetch_page で調べた後の出典なし書き込みを拒否する', async () => {
    const h = await boot([SC, CTX], { proc: installed(['ctxpack'], argv => (argv[0] === 'ctxpack' ? { exitCode: 0, stdout: '# ページ', stderr: '' } : undefined as never)) })
    await h.start()
    expect(h.tools).toEqual(['fetch_page'])
    expect(ids(await h.compose())).toEqual(['base', 'ctxpack-fetch:guidance', 'source-citation:guidance'])

    expect((await h.toolCall(NO_URL)).deny).toBeUndefined()

    const fetched = await h.toolCall({ tool: 'mcp__ctxpack-fetch__fetch_page', url: 'https://example.com' })
    expect(fetched.result).toContain('# ページ')
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
    expect((await h.toolCall(WITH_URL)).deny).toBeUndefined()
  })

  test('WebFetch は ctxpack-fetch に拒否されても、外側の source-citation には調査として数えられる', async () => {
    const h = await boot([SC, CTX], { proc: installed(['ctxpack']) })
    await h.start()
    const r = await h.toolCall({ tool: 'WebFetch', url: 'https://example.com' })
    expect(r.deny).toContain('fetch_page')
    expect(r.reached).toBe(0)
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
  })

  test('ctxpack-fetch を外側にしても、fetch_page の呼び出しが履歴に残るので出典なしの書き込みを拒否する', async () => {
    const h = await boot([CTX, SC], { proc: installed(['ctxpack'], () => ({ exitCode: 0, stdout: '# ページ', stderr: '' })) })
    await h.start()
    expect((await h.toolCall(NO_URL)).deny).toBeUndefined()
    await h.toolCall({ tool: 'mcp__ctxpack-fetch__fetch_page', url: 'https://example.com' })
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
    expect((await h.toolCall(WITH_URL)).deny).toBeUndefined()
  })

  test('ctxpack が無いと fetch_page は登録されず、WebFetch は通って source-citation が調査として数える', async () => {
    const h = await boot([SC, CTX], { proc: installed([]) })
    await h.start()
    expect(h.tools).toEqual([])
    expect(ids(await h.compose())).toEqual(['base', 'source-citation:guidance'])
    expect((await h.toolCall({ tool: 'WebFetch', url: 'https://example.com' })).reached).toBe(1)
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
  })

  test('ctxpack が失敗しても deny は fetch_page だけに留まり、source-citation の規則は残る', async () => {
    const h = await boot([SC, CTX], { proc: installed(['ctxpack'], () => ({ exitCode: 2, stdout: '', stderr: 'timeout' })) })
    await h.start()
    const r = await h.toolCall({ tool: 'mcp__ctxpack-fetch__fetch_page', url: 'https://example.com' })
    expect(r.deny).toContain('ctxpack failed')
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
    expect(ids(await h.compose())).toContain('source-citation:guidance')
  })
})

describe('goal-orchestrator と subagent-router', () => {
  const route = { model: 'haiku', effort: 'low' }

  test('/goal の手順書は prompt.submit に 1 回だけ載り、SubAgent の起動は ollama の判断で model が決まる', async () => {
    const h = await boot([GOAL, ROUTER], { http: ollamaOk(route) })
    await h.start()
    await h.command('goal', 'API を作り直す')
    const first = await h.submit('続きをやって')
    expect(first.context).toHaveLength(1)
    expect(first.context[0]).toContain('API を作り直す')
    expect((await h.submit('もう一度')).context).toBeUndefined()

    const spawned = await h.spawn()
    expect(spawned.seen[0].model).toBe('haiku')
    expect(h.httpUrls[0]).toContain('/api/chat')
    expect(h.toasts.some(t => t.startsWith('subagent-router:'))).toBe(true)
  })

  test('ollama が止まっていても SubAgent は model 未指定のまま起動し、/goal の手順書は影響を受けない', async () => {
    const h = await boot([GOAL, ROUTER], { http: () => { throw new Error('ECONNREFUSED') } })
    await h.command('goal', 'API を作り直す')
    const spawned = await h.spawn()
    expect(spawned.seen[0].model).toBeUndefined()
    expect(h.logs.some(l => l.includes('failed'))).toBe(true)
    expect((await h.submit('続けて')).context?.[0]).toContain('API を作り直す')
  })

  test('ollama が応答しないときは timeoutSeconds で見切り、全モデル失敗後にそのまま起動する', async () => {
    const h = await boot([GOAL, ROUTER], { http: () => new Promise(() => {}) })
    const pending = h.spawn()
    await h.advance(30_000)
    await h.advance(30_000)
    const spawned = await pending
    expect(spawned.seen[0].model).toBeUndefined()
    expect(h.httpUrls).toHaveLength(2)
  })

  test('model 指定済みや fork の起動は ollama に問い合わせない', async () => {
    const h = await boot([GOAL, ROUTER], { http: ollamaOk(route) })
    await h.spawn({ model: 'opus' })
    await h.spawn({ fork: true })
    expect(h.httpUrls).toHaveLength(0)
  })
})

describe('auto-compact と notion-knowledge', () => {
  const OPTS = { http: ollamaOk(), usagePercent: () => 70 }

  test('回答の終了後に Compaction と Notion への記録の両方が走る', async () => {
    let compacted = 0
    const h = await boot([COMPACT, NOTION()], { ...OPTS, proc: notionWorld(), compact: () => (compacted++, DONE) })
    await h.submit('database の query 方法を調べて')
    await h.complete(ANSWER)
    await h.advance(1000)
    expect(compacted).toBe(1)
    expect(writesOf(h.procs)).toHaveLength(1)
    expect(h.toasts.join()).toContain('auto-compact')
    expect(h.toasts.join()).toContain('notion-knowledge')
  })

  test('ntn が使えなくても Compaction は行われ、Notion には書かれない', async () => {
    let compacted = 0
    const h = await boot([COMPACT, NOTION()], { ...OPTS, proc: notionWorld({ ntnUp: false }), compact: () => (compacted++, DONE) })
    await h.submit('database の query 方法を調べて')
    await h.complete(ANSWER)
    await h.advance(1000)
    expect(compacted).toBe(1)
    expect(writesOf(h.procs)).toHaveLength(0)
  })

  test('Compaction が毎回拒否されても Notion への記録は完了し、使用率が低ければ Compaction しない', async () => {
    let attempts = 0
    const h = await boot([COMPACT, NOTION()], { ...OPTS, proc: notionWorld(), compact: () => { attempts++; throw new Error('rejected') } })
    await h.submit('database の query 方法を調べて')
    await h.complete(ANSWER)
    await h.advance(10_000)
    expect(attempts).toBe(5)
    expect(writesOf(h.procs)).toHaveLength(1)

    const low = await boot([COMPACT, NOTION()], { ...OPTS, usagePercent: () => 20, proc: notionWorld() })
    await low.submit('database の query 方法を調べて')
    await low.complete(ANSWER)
    await low.advance(1000)
    expect(writesOf(low.procs)).toHaveLength(1)
    expect(low.toasts.join()).not.toContain('auto-compact')
  })

  test('ollama が止まっていると記録せず、auto-compact は影響を受けない', async () => {
    let compacted = 0
    const h = await boot([COMPACT, NOTION()], { usagePercent: () => 70, http: () => ({ ok: false, status: 500, text: '' }), proc: notionWorld(), compact: () => (compacted++, DONE) })
    await h.submit('database の query 方法を調べて')
    await h.complete(ANSWER)
    await h.advance(1000)
    expect(compacted).toBe(1)
    expect(writesOf(h.procs)).toHaveLength(0)
  })
})

describe('hook の順序・context・拒否・タイムアウト・依存先停止', () => {
  test('prompt.compose の section は先に載せたプラグインほど後ろに積まれ、載せる順を変えると逆になる', async () => {
    const world = { proc: installed(['ctxpack', 'fd', 'rg', 'eza', 'bat']) }
    const a = await boot([SC, CTX, FINDER], world)
    const b = await boot([FINDER, CTX, SC], world)
    await a.start()
    await b.start()
    expect(ids(await a.compose())).toEqual(['base', 'code-finder:guidance', 'ctxpack-fetch:guidance', 'source-citation:guidance'])
    expect(ids(await b.compose())).toEqual(['base', 'source-citation:guidance', 'ctxpack-fetch:guidance', 'code-finder:guidance'])
  })

  test('prompt.submit の context は複数プラグインの追加がすべて残る', async () => {
    const h = await boot([GOAL, NOTION()], { proc: notionWorld(), http: ollamaOk() })
    await h.command('goal', 'API を作り直す')
    const r = await h.submit('databases の query が 404 になる')
    expect(r.context).toHaveLength(2)
    expect(r.context.join('\n')).toContain('API を作り直す')
    expect(r.context.join('\n')).toContain('本文 of p1')
  })

  test('外側の deny は内側のプラグインにも下層にも届かず、ほかのツールの呼び出しには及ばない', async () => {
    const h = await boot([RUST, SC], { proc: installed(['eza', 'bat', 'fd', 'rg']) })
    const denied = await h.toolCall({ tool: 'Bash', command: 'cat README.md' })
    expect(denied.deny).toContain('bat')
    expect(denied.reached).toBe(0)
    expect((await h.toolCall({ tool: 'Bash', command: 'bat README.md' })).reached).toBe(1)
    expect((await h.toolCall({ tool: 'Read', file_path: '/repo/README.md' })).reached).toBe(1)
  })

  test('例外を投げるプラグインが外側にいても、ほかのプラグインの hook は動く', async () => {
    const h = await boot([BROKEN, SC, GOAL], { proc: installed([]) })
    await h.command('goal', 'API を作り直す')
    expect(ids(await h.compose())).toEqual(['base', 'source-citation:guidance'])
    expect((await h.submit('続けて')).context?.[0]).toContain('API を作り直す')
    await h.toolCall({ tool: 'WebSearch', query: 'x' })
    expect((await h.toolCall(NO_URL)).deny).toContain('出典')
    expect(h.skipped.length).toBeGreaterThan(0)
  })

  test('外部ツールがすべて無い環境でも、依存のないプラグインは通常どおり動く', async () => {
    const h = await boot([SC, CTX, FINDER, RUST, ROUTER, NOTION(), GOAL, COMPACT], { proc: installed([]) })
    await h.start()
    expect(h.tools).toEqual([])
    expect(ids(await h.compose())).toEqual(['base', 'source-citation:guidance'])
    expect((await h.toolCall({ tool: 'Bash', command: 'cat a' })).reached).toBe(1)
    expect((await h.spawn()).seen[0].model).toBeUndefined()
    expect((await h.submit('databases の query が 404 になる')).context).toBeUndefined()
    await h.command('goal', 'API を作り直す')
    expect((await h.submit('続けて')).context?.[0]).toContain('API を作り直す')
  })
})
