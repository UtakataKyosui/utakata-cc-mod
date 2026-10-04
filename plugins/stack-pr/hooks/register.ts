import type { Register } from 'claude-code'
import { buildPlaybook, mentionsIssue, pickMode, readConfig } from './policy'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('prompt.submit', ($, e, next) => {
    if (!mentionsIssue(e.text)) return next(e)

    const mode = pickMode(e.text, cfg.mode)
    $.ui.toast(`stack-pr: 変更範囲の見積もりと Stack PR の手順を添付した (${mode === 'plan' ? '実装前に計画' : '実装後に分割'})`)
    return next({ ...e, context: [...(e.context ?? []), buildPlaybook(cfg, mode)] })
  })
}
