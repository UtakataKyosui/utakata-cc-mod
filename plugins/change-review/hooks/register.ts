import type { Register } from 'claude-code'
import {
  REVIEWER,
  exceeded,
  formatStatus,
  guidance,
  initialState,
  isMutatingBash,
  judgeSkip,
  limitDenyText,
  parseReport,
  parseShortstat,
  readConfig,
  reportNote,
  reviewerDescription,
  reviewerPrompt,
  severe,
  PRECHECK_SCHEMA,
  PRECHECK_TOOL,
  type PrecheckFinding,
  type PrecheckInput,
  buildPrecheckPrompt,
  classifyFindings,
  diffArgs,
  diffCommand,
  diffStat,
  formatPrecheck,
  initialPrecheck,
  parseDiff,
  precheckFailText,
  precheckGuidance,
  precheckReviewerNote,
  precheckSystem,
  precheckTool,
} from './policy'
import { type LlmTransport, callLocalLlm, createLlmState, readLlmConfig } from './local-llm'

const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const llm = readLlmConfig(options)
  const llmState = createLlmState()
  let state = initialState()
  let pre = initialPrecheck()
  const reviewers = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'change-review', description: 'レビュー状況と省略可否を表示する (reset で回数を数え直す)' }).catch(() => undefined)
    await $.agent
      .register({
        name: 'reviewer',
        description: reviewerDescription,
        prompt: llm.mode === 'off' ? reviewerPrompt : `${reviewerPrompt}\n\n${precheckReviewerNote}`,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        omitClaudeMd: true,
      })
      .catch(() => $.ui.log('change-review: reviewer の登録に失敗した', { to: 'debug' }))
    if (llm.mode !== 'off') await $.tool.register(precheckTool).catch(() => $.ui.log('change-review: precheck_diff の登録に失敗した', { to: 'debug' }))
    return next(e)
  })

  on('command.run', { command: 'change-review' }, async ($, e) => {
    if (/^\s*reset\s*$/i.test(e.args)) {
      state = initialState()
      pre = initialPrecheck()
      return { text: 'change-review: レビュー回数を数え直した' }
    }
    const diff = await $.process.run(['git', 'diff', '--shortstat', 'HEAD']).catch(() => undefined)
    if (diff === undefined || diff.exitCode !== 0) {
      return { text: `${formatStatus(state, cfg, pre)}\n差分の規模を取得できなかった (git リポジトリで実行されていない可能性がある): 省略可否は判断できない` }
    }
    const judged = judgeSkip(parseShortstat(diff.stdout), cfg)
    if (judged.skip && state.reviews === 0) state = { ...state, skipped: judged.reason }
    return { text: `${formatStatus(state, cfg, pre)}\n省略可否: ${judged.skip ? '省略してよい' : '省略不可'} (${judged.reason})` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = llm.mode === 'off' ? guidance(cfg) : `${guidance(cfg)}\n\n${precheckGuidance}`
    return { sections: [...composed.sections, { id: 'change-review:guidance', text, scope: 'session' }] }
  })

  // 一次点検は読み取り専用。LLM へはツールも自由なコマンドも渡さず、plugin が固定の git diff だけを実行して入力を組み立てる
  on('tool.call', { tool: PRECHECK_TOOL }, async ($, e) => {
    if (llm.mode === 'off') return { result: precheckFailText('llmMode が off') }
    const fail = (reason: string) => {
      pre = { ...pre, failed: pre.failed + 1 }
      return { result: precheckFailText(reason) }
    }
    try {
      const input = e as unknown as PrecheckInput
      const argv = diffArgs(input)
      if (argv === undefined) return { result: precheckFailText('range が git の範囲として不正') }
      const diff = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
      if (diff === undefined || diff.exitCode !== 0) return { result: precheckFailText('差分を取得できなかった') }
      const files = parseDiff(diff.stdout)
      if (files.length === 0) return { result: precheckFailText('変更差分がない') }
      const { prompt, view } = buildPrecheckPrompt(input, files, llm.maxInputChars)
      if (view.files.length === 0) return { result: precheckFailText('入力の上限内に送れる差分がない') }

      const stat = diffStat(files)
      const r = await callLocalLlm<{ findings: PrecheckFinding[] }>(
        transport($),
        llm,
        { label: 'change-review', prompt, system: precheckSystem, schema: PRECHECK_SCHEMA, autoWhen: () => !judgeSkip(stat, cfg).skip },
        llmState,
      )
      if (!r.ok) return r.reason === 'disabled' ? { result: precheckFailText('auto の条件 (省略できない規模) を満たさない') } : fail(`理由: ${r.reason}`)

      const checked = classifyFindings(r.value.findings, view)
      pre = { runs: pre.runs + 1, failed: pre.failed, findings: pre.findings + checked.verified.length }
      const notes = ['未追跡ファイルは git diff に含まれず、点検していない']
      return { result: formatPrecheck({ model: r.model, command: diffCommand(argv), view, notes, ...checked }) }
    } catch {
      return fail('予期しない失敗')
    }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== REVIEWER) return next(e)
    if (exceeded(state, cfg)) return { deny: limitDenyText(cfg) }
    const started = await next(e)
    if (started.agentId !== undefined) {
      reviewers.add(started.agentId)
      state = { ...state, reviews: state.reviews + 1, severe: undefined, skipped: undefined }
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined || !reviewers.has(e.agentId)) return done
    const parsed = parseReport(e.answer)
    state = { ...state, severe: parsed.problems.length > 0 ? undefined : parsed.findings.filter(severe).length }
    const note = reportNote(parsed)
    return note === '' ? done : { ...done, text: `${done.text}\n\n${note}` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || !reviewers.has(e.agentId)) return next(e)
    const tool = e.tool as string
    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      return { deny: 'レビュアーは読み取り専用である。修正は実装側が行うので、指摘として報告すること。' }
    }
    if (tool === 'Bash' && isMutatingBash((e as unknown as { command?: string }).command)) {
      return { deny: 'レビュアーは読み取り専用である。状態を変える Bash は実行できない。' }
    }
    return next(e)
  })
}
