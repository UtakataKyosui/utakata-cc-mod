import type { Register } from 'claude-code'
import {
  type Config, type Plan, type Probes, type Status,
  PROFILES, buildLines, databaseStatus, enabledStatus, hasModel, modelNames, parseProfileArg, planFor, readConfig, render,
} from './policy'

const settle = async (work: Promise<Status>): Promise<Status> => work.catch(() => 'unknown')

const hasCli = ($: any, name: string): Promise<Status> =>
  settle($.process.run(['sh', '-c', `command -v ${name}`]).then((r: { exitCode: number }) => (r.exitCode === 0 ? 'ok' : 'missing')))

/** 応答が timeoutMs を超えたら undefined。 */
const within = <T>($: any, ms: number, work: Promise<T>): Promise<T | undefined> =>
  Promise.race([work, $.clock.sleep(ms).then(() => undefined)])

async function probeOllama($: any, cfg: Config): Promise<{ ollama: Status; models: Record<string, Status> }> {
  const unknown = Object.fromEntries(cfg.models.map(m => [m, 'unknown' as Status]))
  try {
    const res = await within($, cfg.timeoutMs, $.http.fetch(`${cfg.ollamaUrl}/api/tags`))
    if (res === undefined || !res.ok) return { ollama: 'missing', models: unknown }
    const names = modelNames(res.text)
    if (names === undefined) return { ollama: 'ok', models: unknown }
    return { ollama: 'ok', models: Object.fromEntries(cfg.models.map(m => [m, hasModel(names, m) ? 'ok' : 'missing'])) }
  } catch {
    return { ollama: 'missing', models: unknown }
  }
}

// 出力にはメールアドレスなどが含まれるので、終了コードだけを見て本文は捨てる。
const probeNotionAuth = ($: any, cfg: Config): Promise<Status> =>
  settle(
    within($, cfg.timeoutMs, $.process.run(['ntn', 'whoami'], { stdin: '', timeoutMs: cfg.timeoutMs })).then(r =>
      r === undefined ? 'unknown' : r.exitCode === 0 ? 'ok' : 'missing',
    ),
  )

async function diagnose($: any, cfg: Config, plan: Plan): Promise<Probes> {
  const settings = await $.settings.read().catch(() => undefined)
  const [cliEntries, ollama, notionAuth] = await Promise.all([
    Promise.all(plan.cli.map(async n => [n, await hasCli($, n)] as const)),
    plan.ollama ? probeOllama($, cfg) : Promise.resolve({ ollama: 'ok' as Status, models: {} }),
    plan.notion && plan.cli.includes('ntn') ? probeNotionAuth($, cfg) : Promise.resolve('ok' as Status),
  ])
  return {
    cli: Object.fromEntries(cliEntries),
    ollama: ollama.ollama,
    models: ollama.models,
    notionAuth,
    notionDatabase: settings === undefined ? 'unknown' : databaseStatus(settings.pluginConfigs),
    enabled: Object.fromEntries(plan.plugins.map(p => [p.name, settings === undefined ? 'unknown' : enabledStatus(settings.enabledPlugins, p.name)])),
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'harness',
      description: '推奨プロファイルに必要な CLI・Notion 設定・ollama 接続の不足を診断する',
      argumentHint: `[${Object.keys(PROFILES).join('|')}]`,
    })
    return next(e)
  })

  on('command.run', { command: 'harness' }, async ($, e, next) => {
    const profile = parseProfileArg(e.args, cfg.profile)
    if (profile === undefined) return { text: `プロファイルは ${Object.keys(PROFILES).join(' / ')} のいずれかを指定すること。` }
    const plan = planFor(profile)
    const probes = await diagnose($, cfg, plan)
    return { text: render(profile, buildLines(plan, probes, cfg)) }
  })
}
