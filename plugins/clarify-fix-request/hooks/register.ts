import type { Register } from 'claude-code'
import {
  CONFIRM_TOOL,
  EDIT_TOOL,
  confirmToolSpec,
  denyText,
  guidance,
  isBashWrite,
  isFixRequest,
  isHumanOrigin,
  judgeSpec,
  readSpec,
} from './policy'

export const register: Register = on => {
  // 直近の修正依頼の文面。確認が済むか、修正依頼でないプロンプトが届くと undefined に戻す
  let pending: string | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register(confirmToolSpec)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && isHumanOrigin(e.origin.kind)) {
      pending = isFixRequest(e.text) ? e.text : undefined
      $.ui.status(pending === undefined ? undefined : '修正内容: 未確認')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: CONFIRM_TOOL }, async ($, e) => {
    if (pending === undefined) return { result: '確認待ちの修正依頼はない。そのまま進めてよい。' }
    const verdict = judgeSpec(readSpec(e as unknown as Record<string, unknown>), pending)
    if (verdict.ok) {
      pending = undefined
      $.ui.status(undefined)
    }
    return { result: verdict.text }
  }).catch(() => ({ result: '確認の処理に失敗した。編集する前に AskUserQuestion で利用者に聞くこと。' }))

  // 生成した型の組み込みツール一覧に AskUserQuestion が無いため、完全一致の正規表現で指定する
  on('tool.call', { tool: /^AskUserQuestion$/ }, async ($, e, next) => {
    const r = await next(e)
    const answers = (r.result as { answers?: unknown } | undefined)?.answers
    if (pending !== undefined && !r.isError && answers !== undefined && JSON.stringify(answers) !== '{}') {
      pending = undefined
      $.ui.status(undefined)
    }
    return r
  }).catch(($, e, next) => next(e)) // 記録に失敗しても質問自体は壊さない

  on('tool.call', async ($, e, next) => {
    if (pending === undefined) return next(e)
    const input = e as unknown as { tool: string; command?: unknown; agentId?: string }
    const writes = EDIT_TOOL.test(input.tool) || (input.tool === 'Bash' && isBashWrite(input.command))
    return writes ? { deny: denyText(input.agentId !== undefined) } : next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'clarify-fix-request:guidance', text: guidance, scope: 'session' }] }
  })
}
