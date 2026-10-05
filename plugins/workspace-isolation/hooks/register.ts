import type { Register } from 'claude-code'
import * as git from './git'
import { type Io, type Outcome } from './git'
import { destructiveGit, guidance, readConfig } from './policy'

const PREFIX = 'mcp__workspace-isolation__'

const ioOf = ($: any): Io => ({
  run: (argv, init) => $.process.run(argv, { timeoutMs: 60_000, ...init }),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  exists: path => $.fs.exists(path),
})

const idProp = { id: { type: 'string', description: 'タスク ID (英小文字・数字・ハイフン)' } }
const idOnly = { type: 'object', properties: idProp, required: ['id'] }

const TOOLS = [
  {
    name: 'workspace_assign',
    description:
      '書き込みを行う並列タスクに専用 git worktree (ブランチ ws/<id>) を割り当て、ベースのコミット・担当範囲・開始前のユーザー変更を記録する。mode: read なら worktree を作らず読み取りタスクとして登録する。',
    inputSchema: {
      type: 'object',
      properties: {
        ...idProp,
        mode: { type: 'string', enum: ['write', 'read'], description: '既定は write' },
        scope: { type: 'array', items: { type: 'string' }, description: '担当するパス・ディレクトリ・glob (write では必須)' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  { name: 'workspace_status', description: '登録済みタスクの状態と、未統合の変更ファイル数を一覧する。', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'workspace_check',
    description: '統合前の確認。担当範囲外の変更、他タスクとの重なり、ユーザー変更との重なり、適用時の競合を検出する。何も書き換えない。',
    inputSchema: idOnly,
  },
  {
    name: 'workspace_integrate',
    description:
      'check を通ったタスクの差分を元の作業ツリーへ適用する。上書き・3-way マージはせず、衝突があれば何も適用しない。commit・push はしない。',
    inputSchema: idOnly,
  },
  {
    name: 'workspace_verify',
    description: '統合済みタスクに対して設定の検証コマンドを作業ツリーで実行し、成功なら完了 (verified) にする。',
    inputSchema: idOnly,
  },
  {
    name: 'workspace_collect',
    description: '未完了タスクの差分をパッチファイルに保存して回収する。id 省略で全件。worktree・ブランチ・変更は削除しない。',
    inputSchema: { type: 'object', properties: idProp },
  },
]

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    for (const t of TOOLS) await $.tool.register(t)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    if (cfg.guardDestructive && tool === 'Bash' && typeof e.command === 'string') {
      const hit = destructiveGit(e.command)
      if (hit !== undefined)
        return { deny: `${hit} は workspace-isolation が拒否した。未回収の成果を失う恐れがある。workspace_collect で回収し、必要ならユーザーが手動で実行する。` }
    }
    if (!tool.startsWith(PREFIX)) return next(e)
    const io = ioOf($)
    const input = e as unknown as Record<string, any>
    let r: Outcome
    switch (tool.slice(PREFIX.length)) {
      case 'workspace_assign': r = await git.assign(io, cfg, input); break
      case 'workspace_status': r = await git.status(io); break
      case 'workspace_check': r = await git.check(io, input.id); break
      case 'workspace_integrate': r = await git.integrate(io, input.id); break
      case 'workspace_verify': r = await git.verify(io, cfg, input.id); break
      case 'workspace_collect': r = await git.collect(io, input.id); break
      default: return next(e)
    }
    return r.ok ? { result: r.text } : { deny: r.text }
  })

  on('session.end', async ($, e, next) => {
    if (cfg.autoCollect) {
      try {
        await git.collect(ioOf($), undefined)
      } catch {
        // 終了処理を妨げない
      }
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    let pending: string | undefined
    try {
      pending = await git.pendingSummary(ioOf($))
    } catch {
      pending = undefined
    }
    const sections = [
      ...composed.sections,
      { id: 'workspace-isolation:guidance', text: guidance(), scope: 'session' as const },
      ...(pending === undefined ? [] : [{ id: 'workspace-isolation:pending', text: pending, scope: 'session' as const }]),
    ]
    return { sections }
  })
}
