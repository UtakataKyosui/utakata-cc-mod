import { test, expect } from 'claude-code/testing'
import {
  CONFLICTS, MARKETPLACE, NEEDS, isManaged, localJevUrlOf, missingRefusal, ollamaUrlOf, optionsOf, readConfig, renderStatus, staticRefusal,
} from './policy'

const allOk = (name: string) => {
  const need = NEEDS[name] ?? {}
  return {
    cmds: Object.fromEntries((need.cmds ?? []).map(c => [c, true])),
    ollama: { 'http://localhost:11434': true },
    localJev: { 'http://127.0.0.1:8080': true },
  }
}

test('既定値: 競合の片方を止め、自動無効化は on、待ちは2秒', () => {
  const cfg = readConfig({})
  expect([...cfg.disabled].sort()).toEqual(['advanced-rust-cli', 'subagent-router'])
  expect(cfg.autoDisable).toBe(true)
  expect(cfg.probeTimeoutMs).toBe(2000)
  expect(readConfig({ autoDisable: 'off', probeTimeoutSeconds: 999, disabled: ' a , ,b' })).toEqual({
    disabled: new Set(['a', 'b']), autoDisable: false, probeTimeoutMs: 30000,
  })
})

test('管理対象はこの marketplace から入った表にあるプラグインだけ', () => {
  expect(isManaged('stack-pr', `stack-pr@${MARKETPLACE}`)).toBe(true)
  expect(isManaged('stack-pr', 'stack-pr@utakata-cc-mod')).toBe(false)
  expect(isManaged('stack-pr', 'stack-pr@inline')).toBe(false)
  expect(isManaged('unknown', `unknown@${MARKETPLACE}`)).toBe(false)
  expect(isManaged('utakata-all-in-one', `utakata-all-in-one@${MARKETPLACE}`)).toBe(false)
})

test('disabled に書いたものと、競合の既定で切る側を止める', () => {
  const cfg = readConfig({})
  expect(staticRefusal('advanced-rust-cli', cfg)).toContain('disabled')
  expect(staticRefusal('bash-hints', cfg)).toBeUndefined()
  // disabled を空にすると、競合の判定で切る側が止まる
  const none = readConfig({ disabled: '' })
  for (const [keep, drop] of CONFLICTS) {
    expect(staticRefusal(drop, none)).toContain(keep)
    expect(staticRefusal(keep, none)).toBeUndefined()
  }
  // 残す側を disabled にすれば、もう片方を使える
  const swap = readConfig({ disabled: 'bash-hints' })
  expect(staticRefusal('advanced-rust-cli', swap)).toBeUndefined()
  expect(staticRefusal('bash-hints', swap)).toContain('disabled')
})

test('依存が揃っていれば通し、足りないものを理由に並べる', () => {
  for (const name of Object.keys(NEEDS)) {
    const opts = (NEEDS[name]?.options ?? []).reduce<Record<string, unknown>>((o, k) => ({ ...o, [k]: 'x' }), {})
    expect(missingRefusal(name, opts, allOk(name))).toBeUndefined()
  }
  const r = missingRefusal('notion-knowledge', {}, { cmds: {}, ollama: {}, localJev: {} })
  expect(r).toContain('コマンド ntn')
  expect(r).toContain('設定 databaseId')
  expect(r).toContain('ollama (http://localhost:11434)')
  expect(missingRefusal('code-finder', {}, { cmds: { fd: true, rg: false }, ollama: {}, localJev: {} })).toBe('依存が見つからないため無効化した: コマンド rg')
  expect(missingRefusal('goal-orchestrator', {}, { cmds: {}, ollama: {}, localJev: {} })).toBeUndefined()
})

test('URL はそのプラグインの設定を優先し、末尾の / を落とす', () => {
  expect(ollamaUrlOf({})).toBe('http://localhost:11434')
  expect(ollamaUrlOf({ ollamaUrl: 'http://gpu:11434/' })).toBe('http://gpu:11434')
  expect(localJevUrlOf({ endpoint: '' })).toBe('http://127.0.0.1:8080')
  const probes = { cmds: {}, ollama: { 'http://gpu:11434': true }, localJev: {} }
  expect(missingRefusal('subagent-router', { ollamaUrl: 'http://gpu:11434' }, probes)).toBeUndefined()
  expect(missingRefusal('subagent-router', {}, probes)).toContain('http://localhost:11434')
})

test('pluginConfigs は name@marketplace を name より優先して読む', () => {
  const pc = {
    'notion-knowledge': { options: { databaseId: 'plain' } },
    [`notion-knowledge@${MARKETPLACE}`]: { options: { databaseId: 'scoped' } },
    'stack-pr': { options: { maxLines: 1 } },
  }
  expect(optionsOf(pc, 'notion-knowledge')).toEqual({ databaseId: 'scoped' })
  expect(optionsOf(pc, 'stack-pr')).toEqual({ maxLines: 1 })
  expect(optionsOf(pc, 'code-finder')).toEqual({})
  expect(optionsOf(undefined, 'code-finder')).toEqual({})
})

test('一覧は全収録プラグインを並べ、判定の無いものは未判定にする', () => {
  const text = renderStatus([
    { name: 'stack-pr', admitted: true, reason: '' },
    { name: 'code-finder', admitted: false, reason: '依存が見つからないため無効化した: コマンド fd' },
  ], readConfig({}))
  expect(text).toContain(`収録 ${Object.keys(NEEDS).length} 本`)
  expect(text).toContain('- [有効] stack-pr')
  expect(text).toContain('- [無効] code-finder: 依存が見つからないため無効化した: コマンド fd')
  expect(text).toContain('- [未判定] goal-orchestrator')
})
