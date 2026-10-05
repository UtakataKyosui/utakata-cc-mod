export type Status = 'ok' | 'missing' | 'unknown'
export type ProfileName = 'minimal' | 'standard' | 'full' | 'local-llm'

export type Needs = {
  cli?: readonly string[]
  /** 常に ollama を使う。 */
  ollama?: boolean
  /** llmMode が off 以外のときだけ ollama を使う (共通のローカルLLM基盤を使う plugin)。 */
  llmMode?: boolean
  notion?: boolean
}

export type PluginSpec = { name: string; needs: Needs }

/** 各プラグインが実際に呼ぶ CLI と外部サービス。 */
export const PLUGINS: readonly PluginSpec[] = [
  { name: 'source-citation', needs: {} },
  { name: 'verification-gate', needs: { cli: ['git'], llmMode: true } },
  { name: 'task-checkpoint', needs: { cli: ['git'] } },
  { name: 'execution-budget', needs: {} },
  { name: 'trust-boundary', needs: {} },
  { name: 'goal-orchestrator', needs: {} },
  { name: 'change-review', needs: { cli: ['git'], llmMode: true } },
  { name: 'workspace-isolation', needs: { cli: ['git'] } },
  { name: 'auto-compact', needs: {} },
  { name: 'code-finder', needs: { cli: ['fd', 'rg'], llmMode: true } },
  { name: 'ctxpack-fetch', needs: { cli: ['ctxpack'], llmMode: true } },
  { name: 'subagent-router', needs: { ollama: true } },
  { name: 'notion-knowledge', needs: { cli: ['ntn'], ollama: true, notion: true } },
  { name: 'advanced-rust-cli', needs: { cli: ['eza', 'bat', 'fd', 'rg'] } },
  { name: 'stack-pr', needs: { cli: ['gh'] } },
]

const MINIMAL = ['source-citation', 'verification-gate', 'task-checkpoint']
const STANDARD = [
  ...MINIMAL,
  'execution-budget',
  'trust-boundary',
  'goal-orchestrator',
  'change-review',
  'workspace-isolation',
  'auto-compact',
  'code-finder',
  'ctxpack-fetch',
]

export const PROFILES: Record<ProfileName, { summary: string; plugins: readonly string[]; /** llmMode が off 以外であることを期待する。 */ expectLlm?: boolean }> = {
  minimal: { summary: '外部の道具に依存しない最小構成。出典・検証・状態保存だけを守る', plugins: MINIMAL },
  standard: { summary: '日常の開発向け。委譲・レビュー・隔離・予算・外部入力の保護を加える', plugins: STANDARD },
  full: {
    summary: 'ollama と Notion まで使う全部入り',
    plugins: [...STANDARD, 'subagent-router', 'notion-knowledge', 'advanced-rust-cli', 'stack-pr'],
  },
  'local-llm': {
    summary: 'standard にローカルLLMの併用 (llmMode: auto) を前提とする暫定構成。効果は未測定で、手動評価の結果で見直す',
    plugins: STANDARD,
    expectLlm: true,
  },
}

export type Config = { profile: ProfileName; ollamaUrl: string; models: string[]; timeoutMs: number }

export const isProfileName = (v: unknown): v is ProfileName => v === 'minimal' || v === 'standard' || v === 'full' || v === 'local-llm'

export const readConfig = (o: Record<string, unknown> | undefined): Config => {
  const models =
    typeof o?.models === 'string'
      ? o.models.split(',').map(s => s.trim()).filter(s => s !== '')
      : ['tev1:4b', 'nimble']
  const seconds = Number(o?.timeoutSeconds)
  return {
    profile: isProfileName(o?.profile) ? o.profile : 'standard',
    ollamaUrl: (typeof o?.ollamaUrl === 'string' && o.ollamaUrl !== '' ? o.ollamaUrl : 'http://localhost:11434').replace(/\/+$/, ''),
    models,
    timeoutMs: (Number.isFinite(seconds) ? Math.min(60, Math.max(2, seconds)) : 10) * 1000,
  }
}

/** `/harness [profile]` の引数。空なら既定、未知の名前なら undefined。 */
export const parseProfileArg = (args: string, fallback: ProfileName): ProfileName | undefined => {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === '') return fallback
  return isProfileName(word) ? word : undefined
}

export type LlmModeStatus = 'off' | 'auto' | 'always' | 'unknown'
export type LlmModes = Record<string, LlmModeStatus>

export type Plan = {
  plugins: readonly PluginSpec[]
  cli: string[]
  ollama: boolean
  notion: boolean
  /** llmMode を持つ plugin と、その設定値。modes を渡さなければ unknown。 */
  llm: { name: string; mode: LlmModeStatus }[]
  expectLlm: boolean
}

/**
 * プロファイルで診断する対象。CLI は重複を除く。
 * ollama は、常に使う plugin があるか、llmMode が off 以外の plugin があるときだけ要る。
 */
export const planFor = (profile: ProfileName, modes?: LlmModes): Plan => {
  const plugins = PROFILES[profile].plugins.map(n => PLUGINS.find(p => p.name === n)!)
  const llm = plugins.filter(p => p.needs.llmMode === true).map(p => ({ name: p.name, mode: modes?.[p.name] ?? ('unknown' as LlmModeStatus) }))
  return {
    plugins,
    cli: [...new Set(plugins.flatMap(p => p.needs.cli ?? []))],
    ollama: plugins.some(p => p.needs.ollama === true) || llm.some(l => l.mode === 'auto' || l.mode === 'always'),
    notion: plugins.some(p => p.needs.notion === true),
    llm,
    expectLlm: PROFILES[profile].expectLlm === true,
  }
}

export type Probes = {
  cli: Record<string, Status>
  ollama: Status
  models: Record<string, Status>
  notionAuth: Status
  notionDatabase: Status
  enabled: Record<string, Status>
  /** trust-boundary の allowedHosts が ollamaUrl のホストを含むか。省略は確認不可。 */
  ollamaHostAllowed?: Status
}

export type Line = { status: Status; label: string; note: string }

const needers = (plan: Plan, pick: (n: Needs) => boolean): string =>
  plan.plugins.filter(p => pick(p.needs)).map(p => p.name).join(', ')

const ollamaUsers = (plan: Plan): string =>
  [
    ...plan.plugins.filter(p => p.needs.ollama === true).map(p => p.name),
    ...plan.llm.filter(l => l.mode === 'auto' || l.mode === 'always').map(l => `${l.name}(llmMode=${l.mode})`),
  ].join(', ')

const llmLine = (l: Plan['llm'][number], expect: boolean): Line => {
  const label = `ローカルLLM設定 ${l.name}`
  if (l.mode === 'unknown') return { status: 'unknown', label, note: 'settings を読めず llmMode を確認できない (ollama が要るかも判断できない)' }
  if (l.mode !== 'off') return { status: 'ok', label, note: `llmMode=${l.mode}` }
  return expect
    ? { status: 'missing', label, note: 'llmMode=off。このプロファイルは auto を前提とする (設定は自分で変える)' }
    : { status: 'ok', label, note: 'llmMode=off (ローカルLLMは使わない)' }
}

const hostOf = (url: string): string | undefined => {
  const m = url.trim().match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i)
  return m?.[1]?.replace(/^\[|\]$/g, '').toLowerCase()
}

/** 診断結果を行にする。値は有無だけで、秘密値や設定内容は持たない。 */
export const buildLines = (plan: Plan, probes: Probes, cfg: Config): Line[] => {
  const lines: Line[] = []
  for (const p of plan.plugins) {
    const status = probes.enabled[p.name] ?? 'unknown'
    lines.push({
      status,
      label: `プラグイン ${p.name}`,
      note: status === 'missing' ? 'enabledPlugins に無い (--plugin-dir で読み込んでいると検出できない)' : '',
    })
  }
  for (const name of plan.cli) {
    lines.push({ status: probes.cli[name] ?? 'unknown', label: `CLI ${name}`, note: `使うプラグイン: ${needers(plan, n => n.cli?.includes(name) === true)}` })
  }
  for (const l of plan.llm) lines.push(llmLine(l, plan.expectLlm))
  if (plan.ollama) {
    lines.push({ status: probes.ollama, label: `ollama 接続 (${cfg.ollamaUrl})`, note: `使うプラグイン: ${ollamaUsers(plan)}` })
    for (const m of cfg.models) {
      lines.push({ status: probes.models[m] ?? 'unknown', label: `ollama モデル ${m}`, note: '' })
    }
    if (plan.plugins.some(p => p.name === 'trust-boundary')) {
      lines.push({
        status: probes.ollamaHostAllowed ?? 'unknown',
        label: `trust-boundary の allowedHosts に ${hostOf(cfg.ollamaUrl) ?? cfg.ollamaUrl} を含む`,
        note: '含まれないと ollama への送信が止まり、ローカルLLMは使われず既存の動作に戻る',
      })
    }
  }
  if (plan.notion) {
    lines.push({ status: probes.notionAuth, label: 'Notion 認証 (ntn whoami)', note: '未認証なら ntn login を自分で実行する' })
    lines.push({ status: probes.notionDatabase, label: 'notion-knowledge の databaseId', note: '空のあいだ notion-knowledge は何もしない' })
  }
  return lines
}

const MARK: Record<Status, string> = { ok: 'OK', missing: '不足', unknown: '確認不可' }

export const render = (profile: ProfileName, lines: readonly Line[]): string => {
  const count = (s: Status) => lines.filter(l => l.status === s).length
  return [
    `プロファイル ${profile}: ${PROFILES[profile].summary}`,
    `OK ${count('ok')} / 不足 ${count('missing')} / 確認不可 ${count('unknown')}`,
    ...lines.map(l => `[${MARK[l.status]}] ${l.label}${l.note === '' ? '' : ` - ${l.note}`}`),
    '',
    '診断だけを行う。インストールや設定の変更はしない。秘密値は読まない。',
  ].join('\n')
}

/** enabledPlugins のキーは `name` または `name@marketplace`。 */
export const enabledStatus = (enabledPlugins: unknown, name: string): Status => {
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null) return 'unknown'
  const hit = Object.entries(enabledPlugins).some(([k, v]) => (k === name || k.startsWith(`${name}@`)) && v === true)
  return hit ? 'ok' : 'missing'
}

const optionsOf = (pluginConfigs: unknown, name: string): Record<string, unknown> | undefined => {
  if (typeof pluginConfigs !== 'object' || pluginConfigs === null) return undefined
  for (const [k, v] of Object.entries(pluginConfigs)) {
    if (k === name || k.startsWith(`${name}@`)) return (v as { options?: Record<string, unknown> } | null)?.options
  }
  return undefined
}

/**
 * plugin の llmMode。設定が無ければ既定の off。共通基盤と同じく、大文字小文字を無視し、不正な値は off。
 * settings 自体を読めないときは、呼び出し側が unknown にする。
 */
export const llmModeOf = (pluginConfigs: unknown, name: string): LlmModeStatus => {
  const v = optionsOf(pluginConfigs, name)?.llmMode
  const mode = typeof v === 'string' ? v.trim().toLowerCase() : undefined
  return mode === 'auto' || mode === 'always' ? mode : 'off'
}

export const llmModesOf = (pluginConfigs: unknown | undefined, readable: boolean): LlmModes =>
  Object.fromEntries(PLUGINS.filter(p => p.needs.llmMode === true).map(p => [p.name, readable ? llmModeOf(pluginConfigs, p.name) : ('unknown' as LlmModeStatus)]))

const DEFAULT_ALLOWED_HOSTS = 'localhost,127.0.0.1,::1,api.notion.com'

/**
 * trust-boundary の allowedHosts が url のホストを含むか。設定が無ければ既定の許可先で判定する。
 * 照合は trust-boundary と同じ (完全一致、またはサブドメイン)。ホストを読めない url は不足。
 */
export const hostAllowedStatus = (pluginConfigs: unknown, url: string): Status => {
  const host = hostOf(url)
  if (host === undefined) return 'unknown'
  const raw = optionsOf(pluginConfigs, 'trust-boundary')?.allowedHosts
  const hosts = (typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_ALLOWED_HOSTS).split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '')
  return hosts.some(h => h === host || host.endsWith(`.${h}`)) ? 'ok' : 'missing'
}

/** pluginConfigs のキーは `name` または `name@marketplace`。値の中身は見ず、空でないかだけ返す。 */
export const databaseStatus = (pluginConfigs: unknown): Status => {
  if (typeof pluginConfigs !== 'object' || pluginConfigs === null) return 'missing'
  for (const [k, v] of Object.entries(pluginConfigs)) {
    if (k !== 'notion-knowledge' && !k.startsWith('notion-knowledge@')) continue
    const id = (v as { options?: { databaseId?: unknown } } | null)?.options?.databaseId
    if (typeof id === 'string' && id.trim() !== '') return 'ok'
  }
  return 'missing'
}

/** ollama の /api/tags の本文からモデル名を取り出す。`tev1:4b` と `tev1:4b:latest` は同じ扱い。 */
export const modelNames = (text: string): string[] | undefined => {
  try {
    const models = (JSON.parse(text) as { models?: { name?: unknown }[] }).models
    return Array.isArray(models) ? models.map(m => String(m.name ?? '')).filter(n => n !== '') : undefined
  } catch {
    return undefined
  }
}

export const hasModel = (names: readonly string[], wanted: string): boolean =>
  names.some(n => n === wanted || n === `${wanted}:latest` || n.split(':')[0] === wanted)
