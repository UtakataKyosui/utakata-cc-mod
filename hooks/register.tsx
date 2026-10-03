import type { Register } from 'claude-code'
import { buildPlaybook, isGoalStatement } from './playbook'

export const register: Register = on => {
  let pendingGoal: string | undefined

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const ran = await next(e)

    if (isGoalStatement(e.args)) {
      pendingGoal = e.args
      $.ui.toast('goal-orchestrator: タスク分解と SubAgent 委譲の手順を有効にした')
    } else {
      pendingGoal = undefined
    }

    return ran
  })

  on('prompt.submit', ($, e, next) => {
    if (pendingGoal === undefined) return next(e)

    const playbook = buildPlaybook(pendingGoal)
    pendingGoal = undefined

    return next({ ...e, context: [...(e.context ?? []), playbook] })
  })
}
