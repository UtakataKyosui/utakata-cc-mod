import { test, expect, mock } from 'claude-code/testing'
import { PROFILES, buildLines, hostAllowedStatus, llmModeOf, llmModesOf, planFor, readConfig, render } from './policy'

const LLM_PLUGINS = ['code-finder', 'ctxpack-fetch', 'verification-gate', 'change-review']

test('local-llm プロファイルは standard と同じ plugin で、llmMode を auto 以上にすることを期待する', () => {
  expect(PROFILES['local-llm'].plugins).toEqual(PROFILES.standard.plugins)
  expect(PROFILES['local-llm'].expectLlm).toBe(true)
  expect(PROFILES['local-llm'].summary).toContain('未測定')
  expect(planFor('local-llm').expectLlm).toBe(true)
  expect(planFor('standard').expectLlm).toBe(false)
})

test('llmMode は設定が無ければ off、大文字小文字を無視し、不正な値は off', () => {
  const cfg = {
    'code-finder@m': { options: { llmMode: 'AUTO' } },
    'ctxpack-fetch': { options: { llmMode: ' always ' } },
    'verification-gate@m': { options: { llmMode: 'sometimes' } },
    'change-review@m': { options: {} },
  }
  expect(llmModeOf(cfg, 'code-finder')).toBe('auto')
  expect(llmModeOf(cfg, 'ctxpack-fetch')).toBe('always')
  expect(llmModeOf(cfg, 'verification-gate')).toBe('off')
  expect(llmModeOf(cfg, 'change-review')).toBe('off')
  expect(llmModeOf(undefined, 'code-finder')).toBe('off')
  expect(llmModesOf(cfg, false)).toEqual(Object.fromEntries(LLM_PLUGINS.map(n => [n, 'unknown'])))
})

test('ollama は llmMode が off 以外の plugin があるときだけ要る。常に使う plugin は従来どおり', () => {
  const off = llmModesOf({}, true)
  expect(planFor('standard', off).ollama).toBe(false)
  expect(planFor('local-llm', off).ollama).toBe(false)
  expect(planFor('standard', { ...off, 'code-finder': 'auto' }).ollama).toBe(true)
  expect(planFor('standard', { ...off, 'change-review': 'always' }).ollama).toBe(true)
  expect(planFor('standard').ollama).toBe(false)
  expect(planFor('full', off).ollama).toBe(true)
  expect(planFor('minimal', { ...off, 'code-finder': 'auto' }).ollama).toBe(false)
})

test('trust-boundary の allowedHosts は trust-boundary と同じ規則で照合し、設定が無ければ既定の許可先で判定する', () => {
  const tb = (allowedHosts: string) => ({ 'trust-boundary@m': { options: { allowedHosts } } })
  expect(hostAllowedStatus(undefined, 'http://localhost:11434')).toBe('ok')
  expect(hostAllowedStatus({}, 'http://127.0.0.1:11434')).toBe('ok')
  expect(hostAllowedStatus({}, 'http://[::1]:11434')).toBe('ok')
  expect(hostAllowedStatus({}, 'http://gpu.lan:11434')).toBe('missing')
  expect(hostAllowedStatus(tb('localhost, GPU.lan'), 'http://gpu.lan:11434')).toBe('ok')
  expect(hostAllowedStatus(tb('lan'), 'http://gpu.lan:11434')).toBe('ok')
  expect(hostAllowedStatus(tb('localhost'), 'http://gpu.lan:11434')).toBe('missing')
  expect(hostAllowedStatus(tb(''), 'http://localhost:11434')).toBe('ok')
  expect(hostAllowedStatus({}, 'not a url')).toBe('unknown')
})

test('buildLines は llmMode ごとの行を出し、local-llm では off を不足にする。llmMode を読めなければ確認不可', () => {
  const probes = { cli: {}, ollama: 'ok' as const, models: {}, notionAuth: 'ok' as const, notionDatabase: 'ok' as const, enabled: {} }
  const cfg = readConfig(undefined)
  const modes = { ...llmModesOf({}, true), 'code-finder': 'auto' as const }
  const local = buildLines(planFor('local-llm', modes), probes, cfg).filter(l => l.label.startsWith('ローカルLLM設定'))
  expect(local).toHaveLength(4)
  expect(local.find(l => l.label.endsWith('code-finder'))).toMatchObject({ status: 'ok', note: 'llmMode=auto' })
  expect(local.find(l => l.label.endsWith('ctxpack-fetch'))?.status).toBe('missing')
  const standard = buildLines(planFor('standard', modes), probes, cfg).filter(l => l.label.startsWith('ローカルLLM設定'))
  expect(standard.every(l => l.status === 'ok')).toBe(true)
  const unknown = buildLines(planFor('standard', llmModesOf(undefined, false)), probes, cfg).filter(l => l.label.startsWith('ローカルLLM設定'))
  expect(unknown.every(l => l.status === 'unknown')).toBe(true)
  expect(render('local-llm', local)).toContain('[不足] ローカルLLM設定 ctxpack-fetch')
})

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const setup = (on: any, world: { models: string[]; settings: object | 'fail'; ollama?: 'up' | 'down' }) => {
  const clock = mock.clock(on)
  on('process.run', () => ok())
  on('http.fetch', () =>
    world.ollama === 'down'
      ? { value: { ok: false, status: 500, headers: {}, text: '' } }
      : { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ models: world.models.map(name => ({ name })) }) } },
  )
  on('settings.read', () => (world.settings === 'fail' ? Promise.reject(new Error('no settings')) : { value: world.settings }))
  return clock
}

test('/harness standard は llmMode が全部 off なら ollama を診断しない', async ($: any, on: any) => {
  setup(on, { models: [], settings: { enabledPlugins: {}, pluginConfigs: { 'code-finder@m': { options: { llmMode: 'off' } } } } })
  const { text } = await $.command.run({ command: 'harness', args: 'standard' })
  expect(text).toContain('[OK] ローカルLLM設定 code-finder - llmMode=off')
  expect(text).not.toContain('ollama')
})

test('/harness standard は llmMode が auto の plugin があれば、ollama の接続・モデル・allowedHosts を診断する', async ($: any, on: any) => {
  setup(on, {
    models: ['tev1:4b'],
    settings: { enabledPlugins: {}, pluginConfigs: { 'code-finder@m': { options: { llmMode: 'auto' } }, 'trust-boundary@m': { options: { allowedHosts: 'api.notion.com' } } } },
  })
  const { text } = await $.command.run({ command: 'harness', args: 'standard' })
  expect(text).toContain('[OK] ローカルLLM設定 code-finder - llmMode=auto')
  expect(text).toContain('[OK] ollama 接続 (http://localhost:11434) - 使うプラグイン: code-finder(llmMode=auto)')
  expect(text).toContain('[OK] ollama モデル tev1:4b')
  expect(text).toContain('[不足] ollama モデル nimble')
  expect(text).toContain('[不足] trust-boundary の allowedHosts に localhost を含む')
})

test('/harness local-llm は off の plugin を不足にし、settings を読めなければ llmMode と ollama の要否を確認不可にする', async ($: any, on: any) => {
  setup(on, { models: [], settings: 'fail' })
  const { text } = await $.command.run({ command: 'harness', args: 'local-llm' })
  expect(text).toContain('プロファイル local-llm')
  expect(text).toContain('[確認不可] ローカルLLM設定 code-finder')
  expect(text).not.toContain('ollama 接続')
})

test('/harness の案内に local-llm が含まれ、未知の名前は案内だけ返す', async ($: any, on: any) => {
  setup(on, { models: [], settings: {} })
  expect((await $.command.run({ command: 'harness', args: 'huge' })).text).toContain('minimal / standard / full / local-llm')
})
