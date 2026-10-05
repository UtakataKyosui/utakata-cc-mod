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
} from './policy'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  let state = initialState()
  const reviewers = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'change-review', description: 'レビュー状況と省略可否を表示する (reset で回数を数え直す)' }).catch(() => undefined)
    await $.agent
      .register({
        name: 'reviewer',
        description: reviewerDescription,
        prompt: reviewerPrompt,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        omitClaudeMd: true,
      })
      .catch(() => $.ui.log('change-review: reviewer の登録に失敗した', { to: 'debug' }))
    return next(e)
  })

  on('command.run', { command: 'change-review' }, async ($, e) => {
    if (/^\s*reset\s*$/i.test(e.args)) {
      state = initialState()
      return { text: 'change-review: レビュー回数を数え直した' }
    }
    const diff = await $.process.run(['git', 'diff', '--shortstat', 'HEAD']).catch(() => undefined)
    if (diff === undefined || diff.exitCode !== 0) {
      return { text: `${formatStatus(state, cfg)}\n差分の規模を取得できなかった (git リポジトリで実行されていない可能性がある): 省略可否は判断できない` }
    }
    const judged = judgeSkip(parseShortstat(diff.stdout), cfg)
    if (judged.skip && state.reviews === 0) state = { ...state, skipped: judged.reason }
    return { text: `${formatStatus(state, cfg)}\n省略可否: ${judged.skip ? '省略してよい' : '省略不可'} (${judged.reason})` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'change-review:guidance', text: guidance(cfg), scope: 'session' }] }
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
