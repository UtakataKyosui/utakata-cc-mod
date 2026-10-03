import type { Register } from 'claude-code'
import { buildPlaybook, isGoalStatement } from './playbook'

export const register: Register = on => {
  let activeGoal: string | undefined

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const ran = await next(e)

    if (isGoalStatement(e.args)) {
      activeGoal = e.args
      $.ui.toast('goal-orchestrator: タスク分解と SubAgent 委譲の手順を有効にした')
    } else {
      activeGoal = undefined
    }

    return ran
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (activeGoal === undefined) return composed

    return {
      sections: [
        ...composed.sections,
        { id: `${$.plugin.name}:playbook`, text: buildPlaybook(activeGoal), scope: 'session' },
      ],
    }
  })
}
