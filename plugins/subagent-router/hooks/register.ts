import type { Register } from 'claude-code'
import { type Config, type Decision, buildBody, buildRequest, parseDecision, pickCandidates, readConfig, tick } from './policy'

async function ask($: any, cfg: Config, model: string, content: string): Promise<Decision | undefined> {
  const call = $.http.fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: buildBody(cfg, model, content),
  })
  const timeout = $.clock.sleep(cfg.timeoutMs).then(() => undefined)
  const res = await Promise.race([call, timeout])
  if (res === undefined || !res.ok) return undefined
  const text = (JSON.parse(res.text) as { message?: { content?: string } }).message?.content
  return typeof text === 'string' ? parseDecision(text) : undefined
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const cooldown = new Map<string, number>()
  const efforts = new Map<string, Decision['effort']>()

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.model !== undefined) return next(e)

    const content = buildRequest(e)
    const candidates = pickCandidates(cfg.models, cooldown)
    tick(cooldown)

    for (const name of candidates) {
      let decision: Decision | undefined
      try {
        decision = await ask($, cfg, name, content)
      } catch {
        decision = undefined
      }
      if (decision === undefined) {
        cooldown.set(name, cfg.skipTurns)
        $.ui.log(`subagent-router: ${name} failed, trying the next model`, { to: 'debug' })
        continue
      }
      const started = await next({ ...e, model: decision.model })
      if (started.agentId !== undefined) efforts.set(started.agentId, decision.effort)
      $.ui.toast(`subagent-router: ${name} → ${decision.model} / ${decision.effort}`)
      return started
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId === undefined ? undefined : efforts.get(e.agentId)
    if (effort !== undefined) $.ui.log(`subagent-router: effort ${e.effort ?? '(none)'} -> ${effort}`, { to: 'debug' })
    return yield* next(effort === undefined ? e : { ...e, effort })
  })
}
