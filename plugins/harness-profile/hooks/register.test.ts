import { test, expect, mock } from 'claude-code/testing'
import {
  PLUGINS, PROFILES, buildLines, databaseStatus, enabledStatus, hasModel, modelNames, parseProfileArg, planFor, readConfig,
} from './policy'

test('プロファイルは実在するプラグインだけを含み、段階的に広がる', () => {
  const names = PLUGINS.map(p => p.name)
  for (const profile of Object.values(PROFILES)) for (const n of profile.plugins) expect(names).toContain(n)
  expect(PROFILES.standard.plugins).toEqual(expect.arrayContaining([...PROFILES.minimal.plugins]))
  expect(PROFILES.full.plugins).toEqual(expect.arrayContaining([...PROFILES.standard.plugins]))
  expect(PROFILES.full.plugins).toHaveLength(PLUGINS.length)
})

test('診断対象はプロファイルが使うプラグインから決まる', () => {
  expect(planFor('minimal')).toMatchObject({ cli: ['git'], ollama: false, notion: false })
  expect(planFor('standard')).toMatchObject({ cli: ['git', 'fd', 'rg', 'ctxpack'], ollama: false, notion: false })
  expect(planFor('full')).toMatchObject({ ollama: true, notion: true })
  expect(planFor('full').cli).toEqual(expect.arrayContaining(['ntn', 'eza', 'bat']))
})

test('設定の既定値と引数の解釈', () => {
  expect(readConfig(undefined)).toMatchObject({ profile: 'standard', ollamaUrl: 'http://localhost:11434', models: ['tev1:4b', 'nimble'], timeoutMs: 10_000 })
  expect(readConfig({ profile: 'x', ollamaUrl: 'http://h:1/', models: ' a , ,b', timeoutSeconds: 999 })).toMatchObject({
    profile: 'standard', ollamaUrl: 'http://h:1', models: ['a', 'b'], timeoutMs: 60_000,
  })
  expect(parseProfileArg('', 'full')).toBe('full')
  expect(parseProfileArg(' minimal x', 'full')).toBe('minimal')
  expect(parseProfileArg('bogus', 'full')).toBeUndefined()
})

test('settings の読み取りは有無だけを返す', () => {
  expect(enabledStatus({ 'code-finder@utakata-cc-mod': true, 'source-citation': false }, 'code-finder')).toBe('ok')
  expect(enabledStatus({ 'source-citation': false }, 'source-citation')).toBe('missing')
  expect(enabledStatus(undefined, 'code-finder')).toBe('unknown')
  expect(databaseStatus({ 'notion-knowledge@m': { options: { databaseId: 'x' } } })).toBe('ok')
  expect(databaseStatus({ 'notion-knowledge@m': { options: { databaseId: ' ' } } })).toBe('missing')
  expect(databaseStatus(undefined)).toBe('missing')
})

test('ollama のモデル名は :latest 付きでも一致する', () => {
  const names = modelNames('{"models":[{"name":"tev1:4b"},{"name":"nimble:latest"}]}')!
  expect(hasModel(names, 'tev1:4b')).toBe(true)
  expect(hasModel(names, 'nimble')).toBe(true)
  expect(hasModel(names, 'other')).toBe(false)
  expect(modelNames('not json')).toBeUndefined()
})

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const ng = () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const setup = (on: any, world: { cli: string[]; ollama: 'up' | 'down' | 'slow'; models?: string[]; ntn?: boolean; settings?: object | 'fail' }) => {
  const clock = mock.clock(on)
  const ran: (readonly string[])[] = []
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    ran.push(e.argv)
    if (e.argv[0] === 'ntn') return world.ntn === false ? ng() : ok('private@example.com')
    return world.cli.includes(e.argv[2]!.replace('command -v ', '')) ? ok() : ng()
  })
  on('http.fetch', () =>
    world.ollama === 'down'
      ? { value: { ok: false, status: 500, headers: {}, text: '' } }
      : world.ollama === 'slow'
        ? new Promise(() => {})
        : { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ models: (world.models ?? []).map(name => ({ name })) }) } },
  )
  on('settings.read', () => (world.settings === 'fail' ? Promise.reject(new Error('no settings')) : { value: world.settings ?? {} }))
  return { clock, ran }
}

test('/harness は不足を一覧にし、秘密値や認証出力を表示しない', async ($: any, on: any) => {
  const { ran } = setup(on, {
    cli: ['git', 'fd', 'rg', 'eza'],
    ollama: 'up',
    models: ['tev1:4b'],
    settings: { enabledPlugins: { 'code-finder@m': true }, pluginConfigs: { 'notion-knowledge@m': { options: { databaseId: 'secret-db-id' } } } },
  })
  const { text } = await $.command.run({ command: 'harness', args: 'full' })
  expect(text).toContain('[OK] CLI git')
  expect(text).toContain('[不足] CLI ctxpack')
  expect(text).toContain('[不足] CLI bat')
  expect(text).toContain('[OK] ollama モデル tev1:4b')
  expect(text).toContain('[不足] ollama モデル nimble')
  expect(text).toContain('[OK] Notion 認証')
  expect(text).toContain('[OK] notion-knowledge の databaseId')
  expect(text).toContain('[OK] プラグイン code-finder')
  expect(text).toContain('[不足] プラグイン source-citation')
  expect(text).not.toContain('private@example.com')
  expect(text).not.toContain('secret-db-id')
  expect(ran.every(a => a[0] === 'sh' || (a[0] === 'ntn' && a[1] === 'whoami'))).toBe(true)
})

test('ollama が落ちている・応答しない場合は不足、settings が読めなければ確認不可', async ($: any, on: any) => {
  const { clock } = setup(on, { cli: ['git'], ollama: 'slow', settings: 'fail' })
  const run = $.command.run({ command: 'harness', args: 'full' })
  await clock.advance(10_000)
  const { text } = await run
  expect(text).toContain('[不足] ollama 接続')
  expect(text).toContain('[確認不可] ollama モデル nimble')
  expect(text).toContain('[確認不可] プラグイン source-citation')
  expect(text).toContain('[確認不可] notion-knowledge の databaseId')
})

test('引数なしは既定のプロファイル、未知の名前は案内だけ返す', { options: { profile: 'minimal' } }, async ($: any, on: any) => {
  const { ran } = setup(on, { cli: ['git'], ollama: 'down' })
  const minimal = await $.command.run({ command: 'harness', args: '' })
  expect(minimal.text).toContain('プロファイル minimal')
  expect(minimal.text).not.toContain('ollama')
  const before = ran.length
  const bad = await $.command.run({ command: 'harness', args: 'huge' })
  expect(bad.text).toContain('minimal / standard / full')
  expect(ran).toHaveLength(before)
})

test('buildLines は診断していない項目を確認不可にする', () => {
  const lines = buildLines(planFor('minimal'), { cli: {}, ollama: 'ok', models: {}, notionAuth: 'ok', notionDatabase: 'ok', enabled: {} }, readConfig(undefined))
  expect(lines.every(l => l.status === 'unknown')).toBe(true)
})
