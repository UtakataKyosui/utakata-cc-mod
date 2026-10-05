import type { Register } from 'claude-code'
import {
  type Config, type Entry, type Report, type Run,
  EXTRACT_SYSTEM, LINE_MAX_CHARS, MAX_PICK,
  buildExcerpt, buildExtractPrompt, collectLog, exceedsTail, fingerprintOf, formatExtract, formatReport, guidance, overall, parseConditions,
  promptBudget, readConfig, tail, verdictOf, windowCandidates,
} from './policy'
import {
  type LlmConfig, type LlmState, type LlmTransport,
  callLocalLlm, createLlmState, idsSchema, pickByIds, readLlmConfig, renderCandidates, splitCandidates, validateIds,
} from './local-llm'

const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const DEFINE = 'mcp__verification-gate__verify_define'
const RUN = 'mcp__verification-gate__verify_run'
const STATUS = 'mcp__verification-gate__verify_status'
const GIT_TIMEOUT_MS = 30_000
const MAX_UNTRACKED = 500
const TIMEOUT_GRACE_MS = 2000

const git = async ($: any, args: string[], stdin = ''): Promise<string | null> => {
  try {
    const r = await $.process.run(['git', ...args], { stdin, timeoutMs: GIT_TIMEOUT_MS })
    return r.exitCode === 0 ? (r.stdout as string) : null
  } catch {
    return null
  }
}

/** 作業ツリーの変更状態。git 管理外などで取得できなければ null。 */
async function fingerprint($: any): Promise<string | null> {
  if ((await git($, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return null
  const head = (await git($, ['rev-parse', 'HEAD'])) ?? ''
  const status = await git($, ['status', '--porcelain=v1', '-z'])
  if (status === null) return null
  const diff = (await git($, ['diff', 'HEAD'])) ?? (await git($, ['diff'])) ?? ''
  const untracked = ((await git($, ['ls-files', '-o', '--exclude-standard', '-z'])) ?? '').split('\0').filter(p => p !== '')
  const hashes =
    untracked.length === 0
      ? ''
      : (await git($, ['hash-object', '--stdin-paths'], untracked.slice(0, MAX_UNTRACKED).join('\n'))) ?? ''
  return fingerprintOf([head, status, diff, hashes])
}

const key = async ($: any): Promise<string> => `entries:${await $.session.root()}`
const load = async ($: any): Promise<Entry[]> => ((await $.store.get(await key($))) as Entry[] | undefined) ?? []
const save = async ($: any, entries: Entry[]) => $.store.set(await key($), entries)

async function reports($: any, entries: Entry[]): Promise<Report[]> {
  const now = entries.length === 0 ? null : await fingerprint($)
  return entries.map(entry => ({ entry, verdict: verdictOf(entry, now) }))
}

async function execute($: any, cfg: Config, entry: Entry): Promise<{ run: Run; output: string; raw: string }> {
  const started = await $.clock.now()
  const base = { at: new Date(started).toISOString() }
  try {
    // エンジンのタイムアウトで拒否されるはずだが、戻ってこない場合に備えて猶予付きで待ち切る
    const r = await Promise.race([
      $.process.run(entry.condition.command, { stdin: '', timeoutMs: entry.condition.timeoutMs }),
      $.clock.sleep(entry.condition.timeoutMs + TIMEOUT_GRACE_MS).then(() => {
        throw new Error('timed out')
      }),
    ])
    const durationMs = (await $.clock.now()) - started
    const fp = await fingerprint($)
    const run: Run = { ...base, outcome: r.exitCode === 0 ? 'passed' : 'failed', exitCode: r.exitCode, durationMs, fingerprint: fp }
    const raw = `${r.stdout}\n${r.stderr}`
    return { run, output: tail(raw, cfg.outputTailChars), raw }
  } catch (err) {
    const durationMs = (await $.clock.now()) - started
    const msg = err instanceof Error ? err.message : String(err)
    const timedOut = /time.?d? ?out/i.test(msg) || durationMs >= entry.condition.timeoutMs
    const detail = timedOut
      ? `${entry.condition.timeoutMs / 1000} 秒以内に終わらなかった`
      : `コマンドを実行できなかった (${tail(msg, 200)})`
    const fp = await fingerprint($)
    return { run: { ...base, outcome: timedOut ? 'timeout' : 'error', exitCode: null, durationMs, fingerprint: fp, detail }, output: '', raw: '' }
  }
}

/**
 * 失敗ログから、ローカル LLM が選んだ行の原文を抜粋する。LLM が選ぶのは行 ID だけで、判定や記録には使わない。
 * off・条件外・失敗・不正な ID のときは undefined を返し、呼び出し側が既存の末尾出力を使う。
 */
async function extract($: any, cfg: Config, llm: LlmConfig, state: LlmState, id: string, description: string, raw: string): Promise<string | undefined> {
  try {
    if (llm.mode === 'off' || cfg.outputTailChars <= 0) return undefined
    const collected = collectLog(raw)
    const cands = splitCandidates(collected.text, { by: 'lines', maxChars: LINE_MAX_CHARS })
    const { shown, hidden } = windowCandidates(cands, promptBudget(llm.maxInputChars))
    if (shown.length === 0) return undefined
    const check = (ids: unknown) => validateIds(ids, shown, { mode: 'strict', max: MAX_PICK })
    const r = await callLocalLlm<{ ids: number[] }>(
      transport($),
      llm,
      {
        label: 'verification-gate',
        system: EXTRACT_SYSTEM,
        prompt: buildExtractPrompt(description, renderCandidates(shown), hidden),
        schema: idsSchema(MAX_PICK),
        autoWhen: () => exceedsTail(collected, cfg.outputTailChars),
        semantic: v => v.ids.length > 0 && check(v.ids).ok,
      },
      state,
    )
    if (!r.ok) return undefined
    const v = check(r.value.ids)
    if (!v.ok) return undefined
    const ex = buildExcerpt(pickByIds(shown, v.ids), collected.joinAt, collected.omitted, cfg.outputTailChars)
    return ex.shown === 0 ? undefined : formatExtract(id, ex, collected)
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const llm = readLlmConfig(options)
  const llmState = createLlmState()

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'verify_define',
      description:
        'タスクの受け入れ条件と、それを確かめる検証コマンドを登録する。登録済みの条件は置き換わり、実行記録は消える。command はシェルを介さない argv の配列 (例: ["npm","test","--","foo"])。',
      inputSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '英数字・_・- の識別子' },
                description: { type: 'string', description: '受け入れ条件の説明' },
                command: { type: 'array', items: { type: 'string' }, description: '検証コマンドの argv' },
                timeout_sec: { type: 'number', description: 'タイムアウト秒。省略時は設定の既定値' },
              },
              required: ['id', 'command'],
            },
          },
        },
        required: ['conditions'],
      },
    })
    await $.tool.register({
      name: 'verify_run',
      description:
        '登録済みの検証コマンドを実行し、終了コードと実行時点の変更状態を記録する。id を省くと全条件を実行する。baseline を true にすると、既存の失敗と区別するための基準として記録する (変更前に実行すること)。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '実行する条件の id。省略時は全件' },
          baseline: { type: 'boolean', description: '変更前の基準として記録する' },
        },
      },
    })
    await $.tool.register({
      name: 'verify_status',
      description: '受け入れ条件ごとの判定 (成功・失敗・未実行・タイムアウト・再変更・検証不可) を現在の変更状態に照らして返す。完了を報告する前に確認する。',
      inputSchema: { type: 'object' },
    })
    await $.command.register({ name: 'verification', description: '受け入れ条件の検証状況を表示する' })
    return next(e)
  })

  on('tool.call', { tool: DEFINE }, async ($, e) => {
    const input = e as unknown as { conditions?: unknown }
    const parsed = parseConditions(input.conditions, cfg.defaultTimeoutMs)
    if (parsed.error !== undefined) return { deny: parsed.error }
    await save($, parsed.conditions.map(condition => ({ condition })))
    return { result: `${parsed.conditions.length} 件の受け入れ条件を登録した。変更後に verify_run で実行すること。` }
  })

  on('tool.call', { tool: RUN }, async ($, e) => {
    const input = e as unknown as { id?: unknown; baseline?: unknown }
    const entries = await load($)
    if (entries.length === 0) return { deny: '受け入れ条件が登録されていない。先に verify_define を呼ぶこと' }
    const targets = typeof input.id === 'string' ? entries.filter(x => x.condition.id === input.id) : entries
    if (targets.length === 0) return { deny: `id が見つからない: ${String(input.id)}` }

    const baseline = input.baseline === true
    const outputs: string[] = []
    for (const entry of targets) {
      const { run, output, raw } = await execute($, cfg, entry)
      if (baseline) entry.baseline = run
      else entry.last = run
      if (run.outcome !== 'failed' || output === '') continue
      // 判定は記録済み。抜粋は表示だけに使い、失敗したら末尾出力に戻る
      const excerpt = await extract($, cfg, llm, llmState, entry.condition.id, entry.condition.description, raw)
      outputs.push(excerpt ?? `--- ${entry.condition.id} の出力 (末尾) ---\n${output}`)
    }
    await save($, entries)
    const head = baseline ? '変更前の基準として記録した。\n' : ''
    const body = baseline ? targets.map(t => `- ${t.condition.id}: ${t.baseline!.outcome} (exit ${t.baseline!.exitCode ?? '-'})`).join('\n') : formatReport(await reports($, entries))
    return { result: [head + body, ...outputs].join('\n\n') }
  })

  on('tool.call', { tool: STATUS }, async ($) => ({ result: formatReport(await reports($, await load($))) }))

  on('command.run', { command: 'verification' }, async ($) => ({ text: formatReport(await reports($, await load($))) }))

  on('turn.complete', async ($, e, next) => {
    const entries = await load($)
    if (entries.length > 0) {
      const state = overall(await reports($, entries))
      if (state === 'blocked') $.ui.toast('verification-gate: 未検証または失敗の受け入れ条件がある。/verification で確認')
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'verification-gate:guidance', text: guidance, scope: 'session' }] }
  })
}
