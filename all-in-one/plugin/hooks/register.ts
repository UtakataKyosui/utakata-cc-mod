import type { Register } from 'claude-code'
import {
  type Decision, NEEDS, SELF, isManaged, localJevUrlOf, missingRefusal, ollamaUrlOf, optionsOf, readConfig, renderStatus, staticRefusal,
} from './policy'

// 判定はモジュールの読み込み (と再読み込み) ごとに走る。確認結果はこのモジュールが生きている間使い回す。
const cmdProbes = new Map<string, Promise<boolean>>()
const httpProbes = new Map<string, Promise<boolean>>()
const decisions = new Map<string, Decision>()
let settingsRead: Promise<unknown> | undefined

const within = <T>($: any, ms: number, work: Promise<T>): Promise<T | undefined> =>
  Promise.race([work, $.clock.sleep(ms).then(() => undefined)])

function hasCmd($: any, name: string, ms: number): Promise<boolean> {
  let p = cmdProbes.get(name)
  if (p === undefined) {
    // name は判定表の定数で、外から来る値ではない。
    p = within($, ms, $.process.run(['sh', '-c', `command -v ${name}`], { stdin: '', timeoutMs: ms }))
      .then((r: any) => r !== undefined && r.exitCode === 0, () => false)
    cmdProbes.set(name, p)
  }
  return p
}

function answers($: any, url: string, ms: number, mustBeOk: boolean): Promise<boolean> {
  const key = `${mustBeOk ? 'ok' : 'any'} ${url}`
  let p = httpProbes.get(key)
  if (p === undefined) {
    p = within($, ms, $.http.fetch(url))
      .then((r: any) => r !== undefined && r !== null && (!mustBeOk || r.ok === true), () => false)
    httpProbes.set(key, p)
  }
  return p
}

function pluginConfigs($: any): Promise<unknown> {
  const p: Promise<unknown> = settingsRead ?? $.settings.read().then((s: any) => s?.pluginConfigs, () => undefined)
  settingsRead = p
  return p
}

async function judge($: any, name: string, ms: number): Promise<string | undefined> {
  const need = NEEDS[name] ?? {}
  const options = optionsOf(await pluginConfigs($), name)
  const cmds = need.cmds ?? []
  const [cmdResults, ollama, localJev] = await Promise.all([
    Promise.all(cmds.map(c => hasCmd($, c, ms))),
    need.ollama === true ? answers($, `${ollamaUrlOf(options)}/api/tags`, ms, true) : Promise.resolve(false),
    need.localJev === true ? answers($, localJevUrlOf(options), ms, false) : Promise.resolve(false),
  ])
  return missingRefusal(name, options, {
    cmds: Object.fromEntries(cmds.map((c, i) => [c, cmdResults[i] === true])),
    ollama: { [ollamaUrlOf(options)]: ollama },
    localJev: { [localJevUrlOf(options)]: localJev },
  })
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('plugin.register', async ($, e, next) => {
    if (!isManaged(e.name, e.provenance)) return next(e)
    const fixed = staticRefusal(e.name, cfg)
    const reason = fixed ?? (cfg.autoDisable ? await judge($, e.name, cfg.probeTimeoutMs) : undefined)
    if (reason !== undefined) {
      decisions.set(e.name, { name: e.name, admitted: false, reason })
      $.ui.log(`${SELF}: ${e.name} を読み込まない: ${reason}`, { to: 'debug' })
      return { refuse: `${SELF}: ${reason}` }
    }
    decisions.set(e.name, { name: e.name, admitted: true, reason: '' })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'all-in-one',
      description: 'utakata-all-in-one に収録したプラグインの有効・無効と、その理由を一覧する',
    })
    const off = [...decisions.values()].filter(d => !d.admitted)
    if (off.length > 0) $.ui.status(`all-in-one: ${off.length} 本を無効化 (/all-in-one で理由)`)
    return next(e)
  })

  on('command.run', { command: 'all-in-one' }, async () => ({ text: renderStatus([...decisions.values()], cfg) }))
}
