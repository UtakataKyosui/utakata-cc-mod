import type { Register } from 'claude-code'
import { type Decision, SCHEMA, buildRequest, readConfig, toDecision } from './policy'
import { type LlmTransport, callLocalLlm, createLlmState } from './local-llm'

const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state = createLlmState(cfg.skipTurns)
  const efforts = new Map<string, Decision['effort']>()

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.model !== undefined) return next(e)

    const r = await callLocalLlm(transport($), cfg.llm, { label: 'subagent-router', prompt: buildRequest(e), schema: SCHEMA, semantic: v => toDecision(v) !== undefined }, state)
    const decision = r.ok ? toDecision(r.value) : undefined
    if (!r.ok || decision === undefined) return next(e)

    const started = await next({ ...e, model: decision.model })
    if (started.agentId !== undefined) efforts.set(started.agentId, decision.effort)
    $.ui.toast(`subagent-router: ${r.model} → ${decision.model} / ${decision.effort}`)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId === undefined ? undefined : efforts.get(e.agentId)
    if (effort !== undefined) $.ui.log(`subagent-router: effort ${e.effort ?? '(none)'} -> ${effort}`, { to: 'debug' })
    return yield* next(effort === undefined ? e : { ...e, effort })
  })
}
