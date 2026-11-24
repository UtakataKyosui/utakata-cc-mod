/**
 * オールインワン版の判定表と、読み込みを許すかどうかの判定。
 * 副作用を持たない。CLI や HTTP の確認結果は register.ts が渡す。
 */

/** オールインワン版の marketplace 名。プロビナンス `<name>@<MARKETPLACE>` の照合に使う。 */
export const MARKETPLACE = 'utakata-all-in-one'

/** このプラグイン自身の名前。 */
export const SELF = 'utakata-all-in-one'

/** 各プラグインが動くのに必要なもの。 */
export type Need = {
  /** PATH に必要なコマンド。 */
  cmds?: readonly string[]
  /** ollama の応答が必要。URL はそのプラグインの `ollamaUrl` 設定 (無ければ既定値) を見る。 */
  ollama?: boolean
  /** LocalJev の応答が必要。URL はそのプラグインの `endpoint` 設定 (無ければ既定値) を見る。 */
  localJev?: boolean
  /** そのプラグインの設定で空にできない項目。 */
  options?: readonly string[]
}

/**
 * 収録する全プラグインの必要条件。
 * ビルドスクリプトは plugins/ の全ディレクトリがここにあることを確かめるので、
 * プラグインを足したらここにも行を足す。依存が無い (任意の CLI が無くても自分で縮退する) ものは空にする。
 */
export const NEEDS: Readonly<Record<string, Need>> = {
  'act-now-guard': { localJev: true },
  'advanced-rust-cli': { cmds: ['eza', 'bat', 'fd', 'rg'] },
  'agent-router': { localJev: true },
  'approval-guard': {},
  'auto-compact': {},
  'bash-hints': {},
  'change-review': {},
  'code-finder': { cmds: ['fd', 'rg'] },
  'ctxpack-fetch': { cmds: ['ctxpack'] },
  'execution-budget': {},
  'ghq-pane': { cmds: ['ghq', 'git'] },
  'goal-orchestrator': {},
  'harness-profile': {},
  'notion-knowledge': { cmds: ['ntn'], ollama: true, options: ['databaseId'] },
  'prompt-retrospective': {},
  'repo-storage-manager': { cmds: ['git'] },
  'session-guard': {},
  'source-citation': {},
  'stack-pr': { cmds: ['gh'] },
  'subagent-router': { ollama: true },
  'task-checkpoint': {},
  'trust-boundary': {},
  'verification-gate': {},
  'workspace-isolation': { cmds: ['git'] },
}

/**
 * 同時に入れると助言や書き換えがぶつかる組。両方が有効なら後ろ (既定で切る側) を止める。
 */
export const CONFLICTS: readonly (readonly [keep: string, drop: string])[] = [
  ['bash-hints', 'advanced-rust-cli'],
  ['agent-router', 'subagent-router'],
]

export const DEFAULT_DISABLED = CONFLICTS.map(([, drop]) => drop).join(',')
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
export const DEFAULT_LOCALJEV_URL = 'http://127.0.0.1:8080'

export type Config = {
  disabled: ReadonlySet<string>
  autoDisable: boolean
  probeTimeoutMs: number
}

const list = (v: unknown, fallback: string): string[] =>
  (typeof v === 'string' ? v : fallback).split(',').map(s => s.trim()).filter(s => s !== '')

export const readConfig = (o: Readonly<Record<string, unknown>> | undefined): Config => {
  const n = Number(o?.probeTimeoutSeconds)
  return {
    disabled: new Set(list(o?.disabled, DEFAULT_DISABLED)),
    autoDisable: o?.autoDisable !== 'off',
    probeTimeoutMs: (Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 2) * 1000,
  }
}

/** 管理対象か: このオールインワン版の marketplace から入った、表にあるプラグイン。 */
export const isManaged = (name: string, provenance: string): boolean =>
  name !== SELF && provenance === `${name}@${MARKETPLACE}` && Object.hasOwn(NEEDS, name)

/** settings の pluginConfigs から、そのプラグインの options を取り出す。 */
export const optionsOf = (pluginConfigs: unknown, name: string): Record<string, unknown> => {
  if (typeof pluginConfigs !== 'object' || pluginConfigs === null) return {}
  const table = pluginConfigs as Record<string, unknown>
  for (const key of [`${name}@${MARKETPLACE}`, name]) {
    const entry = table[key]
    if (typeof entry === 'object' && entry !== null) {
      const options = (entry as { options?: unknown }).options
      if (typeof options === 'object' && options !== null) return options as Record<string, unknown>
    }
  }
  return {}
}

const url = (v: unknown, fallback: string): string =>
  (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback).replace(/\/+$/, '')

export const ollamaUrlOf = (options: Record<string, unknown>): string => url(options.ollamaUrl, DEFAULT_OLLAMA_URL)
export const localJevUrlOf = (options: Record<string, unknown>): string => url(options.endpoint, DEFAULT_LOCALJEV_URL)

/** 依存を確かめた結果。キーはコマンド名か URL。 */
export type Probes = {
  cmds: Readonly<Record<string, boolean>>
  ollama: Readonly<Record<string, boolean>>
  localJev: Readonly<Record<string, boolean>>
}

/** 手動指定と競合だけで決まる拒否理由。依存の確認より先に見る。 */
export const staticRefusal = (name: string, cfg: Config): string | undefined => {
  if (cfg.disabled.has(name)) return `設定 disabled で無効化されている`
  for (const [keep, drop] of CONFLICTS) {
    if (name === drop && !cfg.disabled.has(keep)) return `${keep} と競合するため無効化した (使うなら disabled に ${keep} を入れ、${name} を外す)`
  }
  return undefined
}

/** 依存の不足による拒否理由。足りていれば undefined。 */
export const missingRefusal = (name: string, options: Record<string, unknown>, probes: Probes): string | undefined => {
  const need = NEEDS[name] ?? {}
  const missing: string[] = []
  for (const c of need.cmds ?? []) if (probes.cmds[c] !== true) missing.push(`コマンド ${c}`)
  for (const key of need.options ?? []) {
    const v = options[key]
    if (typeof v !== 'string' || v.trim() === '') missing.push(`設定 ${key}`)
  }
  if (need.ollama === true && probes.ollama[ollamaUrlOf(options)] !== true) missing.push(`ollama (${ollamaUrlOf(options)})`)
  if (need.localJev === true && probes.localJev[localJevUrlOf(options)] !== true) missing.push(`LocalJev (${localJevUrlOf(options)})`)
  return missing.length === 0 ? undefined : `依存が見つからないため無効化した: ${missing.join('、')}`
}

export type Decision = { name: string; admitted: boolean; reason: string }

export const renderStatus = (decisions: readonly Decision[], cfg: Config): string => {
  const names = Object.keys(NEEDS).sort()
  const byName = new Map(decisions.map(d => [d.name, d]))
  const lines = names.map(n => {
    const d = byName.get(n)
    if (d === undefined) return `- [未判定] ${n}: このセッションでは読み込みを見ていない (未インストール、または別の marketplace から入っている)`
    return d.admitted ? `- [有効] ${n}${d.reason === '' ? '' : `: ${d.reason}`}` : `- [無効] ${n}: ${d.reason}`
  })
  return [
    `utakata-all-in-one: 収録 ${names.length} 本 (自動無効化: ${cfg.autoDisable ? 'on' : 'off'})`,
    ...lines,
    '',
    '依存を入れたら、新しいセッションを始めると有効になる。',
  ].join('\n')
}
