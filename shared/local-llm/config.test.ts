import { describe, expect, test } from 'bun:test'
import { readLlmConfig } from './config'
import userConfig from './user-config.json'

describe('readLlmConfig', () => {
  test('既定は off で、不正値は既定に丸める', () => {
    const d = readLlmConfig(undefined)
    expect(d).toMatchObject({ mode: 'off', ollamaUrl: 'http://localhost:11434', models: ['tev1:4b', 'nimble'], timeoutMs: 30_000, totalTimeoutMs: 60_000, maxAttempts: 2, keepAlive: '1m' })
    expect(readLlmConfig({ llmMode: 'sometimes', timeoutSeconds: 'x', models: ' , ' })).toEqual(d)
  })

  test('範囲と型を丸め、モデルは空白を除いて並べる', () => {
    const c = readLlmConfig({
      llmMode: 'ALWAYS', models: ' a, b ,', timeoutSeconds: 999, totalTimeoutSeconds: 1, maxAttempts: 99.7, maxInputChars: 1, maxOutputChars: 1e9, ollamaUrl: 'http://h:1//', keepAlive: ' 5m ',
    })
    expect(c).toEqual({ mode: 'always', ollamaUrl: 'http://h:1', models: ['a', 'b'], timeoutMs: 120_000, totalTimeoutMs: 5_000, maxAttempts: 10, keepAlive: '5m', maxInputChars: 500, maxOutputChars: 100_000 })
  })

  test('plugin ごとの既定値で差し替えられる', () => {
    expect(readLlmConfig({}, { mode: 'auto', models: ['x'] })).toMatchObject({ mode: 'auto', models: ['x'] })
    expect(readLlmConfig({ llmMode: 'off' }, { mode: 'auto' }).mode).toBe('off')
  })

  test('user-config.json の既定値と範囲が readLlmConfig と一致する', () => {
    const defaults: Record<string, unknown> = Object.fromEntries(Object.entries(userConfig).map(([k, v]) => [k, v.default]))
    expect(readLlmConfig(defaults)).toEqual(readLlmConfig(undefined))
    expect(Object.keys(userConfig).sort()).toEqual(['keepAlive', 'llmMode', 'maxAttempts', 'maxInputChars', 'maxOutputChars', 'models', 'ollamaUrl', 'timeoutSeconds', 'totalTimeoutSeconds'])
    for (const [k, v] of Object.entries(userConfig)) {
      if (!('min' in v)) continue
      const lo = readLlmConfig({ [k]: (v.min as number) - 1 })
      const hi = readLlmConfig({ [k]: (v.max as number) + 1 })
      const at = readLlmConfig({ [k]: v.min })
      const top = readLlmConfig({ [k]: v.max })
      expect(lo).toEqual(at)
      expect(hi).toEqual(top)
    }
  })

  test('subagent-router の既存キーを同じ意味で読む', () => {
    const c = readLlmConfig({ models: ' nimble , ,tev1:4b ', timeoutSeconds: 999, ollamaUrl: 'http://h:1/' })
    expect(c.models).toEqual(['nimble', 'tev1:4b'])
    expect(c.timeoutMs).toBe(120_000)
    expect(c.ollamaUrl).toBe('http://h:1')
  })
})
