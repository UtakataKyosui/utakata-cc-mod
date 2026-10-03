import { test, expect } from 'claude-code/testing'
import { buildBody, buildRequest, parseDecision, pickCandidates, readConfig, tick } from './policy'

test('設定の既定値と不正値の丸め', () => {
  const cfg = readConfig({ models: ' nimble , ,tev1:4b ', timeoutSeconds: 999, ollamaUrl: 'http://h:1/' })
  expect(cfg.models).toEqual(['nimble', 'tev1:4b'])
  expect(cfg.timeoutMs).toBe(120_000)
  expect(cfg.ollamaUrl).toBe('http://h:1')
  expect(readConfig({}).models).toEqual(['tev1:4b', 'nimble'])
})

test('決定モデルの応答を検証する', () => {
  expect(parseDecision('{"model":"sonnet","effort":"high"}')).toEqual({ model: 'sonnet', effort: 'high' })
  expect(parseDecision('{"model":"gpt","effort":"high"}')).toBeUndefined()
  expect(parseDecision('{"model":"haiku"}')).toBeUndefined()
  expect(parseDecision('not json')).toBeUndefined()
})

test('リクエストに JSON スキーマと keep_alive が入る', () => {
  const body = JSON.parse(buildBody(readConfig({}), 'nimble', buildRequest({ subagentType: 'Explore', description: 'd', prompt: 'p' })))
  expect(body.model).toBe('nimble')
  expect(body.format.required).toEqual(['model', 'effort'])
  expect(body.keep_alive).toBe('1m')
  expect(body.messages[0].content).toContain('agent type: Explore')
})

test('失敗したモデルは一定回数飛ばし、全部飛ばす場合は最後を試す', () => {
  const cd = new Map<string, number>([['nimble', 2]])
  const models = ['nimble', 'tev1:4b', 'tev1:0.8b']
  expect(pickCandidates(models, cd)).toEqual(['tev1:4b', 'tev1:0.8b'])
  tick(cd)
  expect(pickCandidates(models, cd)).toEqual(['tev1:4b', 'tev1:0.8b'])
  tick(cd)
  expect(pickCandidates(models, cd)).toEqual(models)
  const all = new Map(models.map(m => [m, 3] as const))
  expect(pickCandidates(models, all)).toEqual(['tev1:0.8b'])
})
