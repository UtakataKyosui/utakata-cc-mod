import type { Register } from 'claude-code'
import { buildPlaybook, mentionsIssue, readConfig } from './policy'

export const register: Register = (on, options) => {
  const playbook = buildPlaybook(readConfig(options))

  on('prompt.submit', ($, e, next) => {
    if (!mentionsIssue(e.text)) return next(e)

    $.ui.toast('stack-pr: 変更範囲の見積もりと Stack PR の手順を添付した')
    return next({ ...e, context: [...(e.context ?? []), playbook] })
  })
}
