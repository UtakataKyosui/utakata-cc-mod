export type Status = 'ok' | 'missing' | 'unknown'
export type ProfileName = 'minimal' | 'standard' | 'full'

export type Needs = {
  cli?: readonly string[]
  ollama?: boolean
  notion?: boolean
}

export type PluginSpec = { name: string; needs: Needs }

/** 各プラグインが実際に呼ぶ CLI と外部サービス。 */
export const PLUGINS: readonly PluginSpec[] = [
  { name: 'source-citation', needs: {} },
  { name: 'verification-gate', needs: { cli: ['git'] } },
  { name: 'task-checkpoint', needs: { cli: ['git'] } },
  { name: 'execution-budget', needs: {} },
  { name: 'trust-boundary', needs: {} },
  { name: 'goal-orchestrator', needs: {} },
  { name: 'change-review', needs: { cli: ['git'] } },
  { name: 'workspace-isolation', needs: { cli: ['git'] } },
  { name: 'auto-compact', needs: {} },
  { name: 'code-finder', needs: { cli: ['fd', 'rg'] } },
  { name: 'ctxpack-fetch', needs: { cli: ['ctxpack'] } },
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

export const PROFILES: Record<ProfileName, { summary: string; plugins: readonly string[] }> = {
  minimal: { summary: '外部の道具に依存しない最小構成。出典・検証・状態保存だけを守る', plugins: MINIMAL },
  standard: { summary: '日常の開発向け。委譲・レビュー・隔離・予算・外部入力の保護を加える', plugins: STANDARD },
  full: {
    summary: 'ollama と Notion まで使う全部入り',
    plugins: [...STANDARD, 'subagent-router', 'notion-knowledge', 'advanced-rust-cli', 'stack-pr'],
  },
}

export type Config = { profile: ProfileName; ollamaUrl: string; models: string[]; timeoutMs: number }

export const isProfileName = (v: unknown): v is ProfileName => v === 'minimal' || v === 'standard' || v === 'full'

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

export type Plan = { plugins: readonly PluginSpec[]; cli: string[]; ollama: boolean; notion: boolean }

/** プロファイルで診断する対象。CLI は重複を除く。 */
export const planFor = (profile: ProfileName): Plan => {
  const plugins = PROFILES[profile].plugins.map(n => PLUGINS.find(p => p.name === n)!)
  return {
    plugins,
    cli: [...new Set(plugins.flatMap(p => p.needs.cli ?? []))],
    ollama: plugins.some(p => p.needs.ollama === true),
    notion: plugins.some(p => p.needs.notion === true),
  }
}

export type Probes = {
  cli: Record<string, Status>
  ollama: Status
  models: Record<string, Status>
  notionAuth: Status
  notionDatabase: Status
  enabled: Record<string, Status>
}

export type Line = { status: Status; label: string; note: string }

const needers = (plan: Plan, pick: (n: Needs) => boolean, only?: string): string =>
  plan.plugins.filter(p => pick(p.needs) && (only === undefined || p.name === only)).map(p => p.name).join(', ')

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
  if (plan.ollama) {
    lines.push({ status: probes.ollama, label: `ollama 接続 (${cfg.ollamaUrl})`, note: `使うプラグイン: ${needers(plan, n => n.ollama === true)}` })
    for (const m of cfg.models) {
      lines.push({ status: probes.models[m] ?? 'unknown', label: `ollama モデル ${m}`, note: '' })
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
