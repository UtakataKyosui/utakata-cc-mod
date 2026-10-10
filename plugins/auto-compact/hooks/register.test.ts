import { test, expect, mock } from 'claude-code/testing'
import {
  HANDOFF_RULE,
  buildDocument,
  fileName,
  instructionsFor,
  isDueAtTurnEnd,
  readConfig,
  shouldCompactAtTurnEnd,
  shouldCompactOnIdle,
  ttlFromLabel,
  ttlFromResume,
} from './policy'

test('閾値以上のときだけターン終了時に Compaction する', () => {
  expect(shouldCompactAtTurnEnd(65, 65)).toBe(true)
  expect(shouldCompactAtTurnEnd(64, 65)).toBe(false)
  expect(shouldCompactAtTurnEnd(undefined, 65)).toBe(false)
  expect(shouldCompactOnIdle(29, 30)).toBe(false)
  expect(shouldCompactOnIdle(30, 30)).toBe(true)
})

test('設定の既定値と TTL の分換算', () => {
  const cfg = readConfig({ cacheTtlMinutes: '60', saveMode: 'bogus' })
  expect(cfg.ttlMs).toBe(3_600_000)
  expect(cfg.threshold).toBe(65)
  expect(cfg.saveMode).toBe('summary')
  expect(readConfig({}).saveDir).toBe('.claude/compactions')
})

test('保存文書に要約とメタ情報が入る', () => {
  const doc = buildDocument({
    iso: '2026-10-04T00:00:00.000Z',
    sessionId: 's1',
    trigger: 'plugin',
    tokensBefore: 130000,
    tokensAfter: 8000,
    summary: ' 要約本文 ',
    before: [{ role: 'user', text: '質問', tools: ['Bash'] }],
  })
  expect(doc).toContain('130000 → 8000')
  expect(doc).toContain('要約本文')
  expect(doc).toContain('### user [ツール: Bash]')
  expect(fileName('2026-10-04T00:00:00.000Z')).toBe('2026-10-04T00-00-00-000Z.md')
})

const setup = ($: any, on: any, percentRef: { v: number | undefined }, calls: string[], writes: Record<string, string>) => {
  const clock = mock.clock(on)
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: percentRef.v }, rateLimits: [] } }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.id', () => ({ value: 'sess' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes[e.path] = e.text
    return { value: undefined }
  })
  on('session.compact', () => {
    calls.push('compact')
    return { messages: [{ role: 'user', text: '要約です', toolUses: [] }], tokensBefore: 130000, tokensAfter: 8000 }
  })
  return clock
}

const complete = ($: any, extra: object = {}) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra })

test('ターン終了時に使用率が閾値以上なら Compaction して要約を保存する', async ($, on) => {
  const calls: string[] = []
  const writes: Record<string, string> = {}
  const clock = setup($, on, { v: 70 }, calls, writes)

  await complete($)
  await clock.advance(1000)

  expect(calls).toEqual(['compact'])
  const file = Object.keys(writes).find(p => p.endsWith('.md'))
  expect(file?.startsWith('/proj/.claude/compactions/')).toBe(true)
  expect(writes[file!]).toContain('要約です')
  expect(writes['/proj/.claude/compactions/.gitignore']).toBe('*\n')
})

test('閾値未満では Compaction しない', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 50 }, calls, {})

  await complete($)
  await clock.advance(1000)

  expect(calls).toEqual([])
})

test('サブエージェントのターンでは Compaction しない', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 90 }, calls, {})

  await complete($, { agentId: 'sub' })
  await clock.advance(1000)

  expect(calls).toEqual([])
})

test('キャッシュ TTL 経過後に下限以上なら Compaction する', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 40 }, calls, {})

  await complete($)
  await clock.advance(1000)
  expect(calls).toEqual([])
  await clock.advance(5 * 60_000)

  expect(calls).toEqual(['compact'])
})

test('次のターン開始でキャッシュ失効タイマーが止まる', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 40 }, calls, {})

  await complete($)
  await clock.advance(1000)
  await $.turn.start({ turnId: 't2' })
  await clock.advance(10 * 60_000)

  expect(calls).toEqual([])
})

test('再開時の経過時間と失効の有無から TTL を絞る', () => {
  expect(ttlFromResume(600, true)).toBe(300_000)
  expect(ttlFromResume(600, false)).toBe(3_600_000)
  expect(ttlFromResume(120, false)).toBeUndefined()
  expect(ttlFromResume(7200, true)).toBeUndefined()
  expect(ttlFromResume(undefined, true)).toBeUndefined()
  expect(ttlFromLabel('1h')).toBe(3_600_000)
  expect(ttlFromLabel('x')).toBeUndefined()
})

test('キャッシュが失効した状態で再開し、使用率が下限以上なら Compaction する', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: undefined }, calls, {})

  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 900,
    prompt_cache_likely_expired: true,
    context_tokens: 100000,
  })
  await clock.advance(1000)

  expect(calls).toEqual(['compact'])
})

test('キャッシュが生きている再開では Compaction しない', async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: undefined }, calls, {})

  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 120,
    prompt_cache_likely_expired: false,
    context_tokens: 100000,
  })
  await clock.advance(1000)

  expect(calls).toEqual([])
})

test('ターン終了時の判定は triggerMode ごとに変わる', () => {
  const at = (options: object, turns: number, percent: number | undefined) => isDueAtTurnEnd(readConfig(options), turns, percent)
  expect(at({}, 1, 64)).toBe(false)
  expect(at({}, 1, 65)).toBe(true)
  expect(at({ triggerMode: 'turns', everyNTurns: 3 }, 2, 99)).toBe(false)
  expect(at({ triggerMode: 'turns', everyNTurns: 3 }, 3, 0)).toBe(true)
  expect(at({ triggerMode: 'every' }, 1, undefined)).toBe(true)
})

test('triggerMode と handoff の既定値と不正値', () => {
  expect(readConfig({})).toMatchObject({ triggerMode: 'threshold', everyNTurns: 3, handoff: true })
  expect(readConfig({ triggerMode: 'bogus', handoff: 'off' })).toMatchObject({ triggerMode: 'threshold', handoff: false })
})

test('Agent への規則と要約の指示に必要な項目が入る', () => {
  for (const word of ['gh issue create', 'README', 'commit', '## Handoff', 'Done', 'Result', 'Next', 'Refs']) {
    expect(HANDOFF_RULE).toContain(word)
  }
  expect(instructionsFor(readConfig({}))).toContain('## Handoff')
  expect(instructionsFor(readConfig({}))).toContain('<next>')
  expect(instructionsFor(readConfig({ handoff: 'off' }))).not.toContain('<next>')
  expect(instructionsFor(readConfig({ handoff: 'off' }))).not.toContain('## Handoff')
})

test('every では使用率が低くても毎ターン Compaction する', { options: { triggerMode: 'every' } }, async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 5 }, calls, {})

  await complete($)
  await clock.advance(1000)
  await complete($)
  await clock.advance(1000)

  expect(calls).toEqual(['compact', 'compact'])
})

test('turns では指定ターン数ごとに Compaction する', { options: { triggerMode: 'turns', everyNTurns: 2 } }, async ($, on) => {
  const calls: string[] = []
  const clock = setup($, on, { v: 5 }, calls, {})

  await complete($)
  await clock.advance(1000)
  expect(calls).toEqual([])
  await complete($)
  await clock.advance(1000)
  expect(calls).toEqual(['compact'])
})
