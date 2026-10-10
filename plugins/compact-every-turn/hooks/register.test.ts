import { test, expect } from 'claude-code/testing'
import { HANDOFF_RULE, INSTRUCTIONS, isDue, readConfig } from './policy'

test('設定の既定値と不正値の丸め', () => {
  expect(readConfig({})).toEqual({ mode: 'threshold', thresholdPercent: 30, everyNTurns: 3 })
  expect(readConfig({ mode: 'bogus', thresholdPercent: 500, everyNTurns: 'x' })).toEqual({ mode: 'threshold', thresholdPercent: 99, everyNTurns: 3 })
  expect(readConfig({ mode: 'turns', thresholdPercent: 0, everyNTurns: 0 })).toEqual({ mode: 'turns', thresholdPercent: 1, everyNTurns: 1 })
})

test('threshold は充填率が閾値以上のときだけ圧縮する', () => {
  const cfg = readConfig({ mode: 'threshold', thresholdPercent: 30 })
  expect(isDue(cfg, 1, 29)).toBe(false)
  expect(isDue(cfg, 1, 30)).toBe(true)
  expect(isDue(cfg, 1, undefined)).toBe(false)
})

test('turns は指定ターン数ごとに圧縮する', () => {
  const cfg = readConfig({ mode: 'turns', everyNTurns: 3 })
  expect(isDue(cfg, 2, 99)).toBe(false)
  expect(isDue(cfg, 3, 0)).toBe(true)
})

test('every は常に圧縮する', () => {
  expect(isDue(readConfig({ mode: 'every' }), 1, undefined)).toBe(true)
})

test('Agent への指示と要約の指示に必要な項目が入る', () => {
  for (const word of ['gh issue create', 'README', 'commit', '## Handoff', 'Done', 'Result', 'Next', 'Refs']) {
    expect(HANDOFF_RULE).toContain(word)
  }
  expect(INSTRUCTIONS).toContain('## Handoff')
})
