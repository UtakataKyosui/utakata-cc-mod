import type { Register } from 'claude-code'
import { HANDOFF_RULE, INSTRUCTIONS, isDue, readConfig } from './policy'

const RETRY_MS = 300
const MAX_RETRIES = 5

let isCompacting = false

function compactSoon($: any, attempt: number): void {
  $.clock.after(RETRY_MS, async () => {
    try {
      const done = await $.session.compact({ instructions: INSTRUCTIONS })
      isCompacting = false
      $.ui.status(done.skip === undefined ? undefined : `compact skipped: ${done.skip}`)
    } catch {
      if (attempt < MAX_RETRIES) return compactSoon($, attempt + 1)
      isCompacting = false
      $.ui.status('compact-every-turn: gave up')
    }
  })
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  let turnsSinceCompact = 0

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return {
      sections: [...sections, { id: 'compact-every-turn:handoff', text: HANDOFF_RULE, scope: 'session' }],
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || isCompacting) return result
    turnsSinceCompact += 1
    const percent = cfg.mode === 'threshold' ? (await $.session.usage()).context.percent : undefined
    if (isDue(cfg, turnsSinceCompact, percent)) {
      turnsSinceCompact = 0
      isCompacting = true
      compactSoon($, 0)
    }
    return result
  })
}
