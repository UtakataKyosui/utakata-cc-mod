import type { Register } from 'claude-code'
import {
  COOLDOWN_TURNS,
  HANDOFF_RULE,
  type Config,
  buildDocument,
  fileName,
  instructionsFor,
  isDueAtTurnEnd,
  readConfig,
  resolveDir,
  shouldCompactOnIdle,
  ttlFromLabel,
  ttlFromResume,
} from './policy'

const SETTLE_MS = 1000
const RETRY_LIMIT = 5

type State = {
  idleTimer: { cancel: () => void } | undefined
  running: boolean
  cooldown: number
  ttlMs: number
  turns: number
}

const cancelIdle = (state: State) => {
  state.idleTimer?.cancel()
  state.idleTimer = undefined
}

async function save($: any, cfg: Config, trigger: string, messages: readonly any[], r: any) {
  if (cfg.saveMode === 'off') return
  try {
    const iso = new Date(await $.clock.now()).toISOString()
    const dir = resolveDir(await $.session.root(), cfg.saveDir)
    if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
    const summary = r.messages.find((m: { text: string }) => m.text.trim() !== '')?.text ?? ''
    const before =
      cfg.saveMode === 'full'
        ? messages.map((m: any) => ({
            role: m.role,
            text: m.text,
            tools: m.toolUses.map((t: { name: string }) => t.name),
          }))
        : undefined
    await $.fs.write(
      `${dir}/${fileName(iso)}`,
      buildDocument({
        iso,
        sessionId: await $.session.id(),
        trigger,
        tokensBefore: r.tokensBefore,
        tokensAfter: r.tokensAfter,
        summary,
        before,
      }),
    )
  } catch (err) {
    $.ui.log(`auto-compact: could not save the summary (${String(err)})`, { to: 'debug' })
  }
}

async function compact($: any, state: State, cfg: Config, why: string) {
  if (state.running) return
  state.running = true
  state.turns = 0
  try {
    for (let i = 0; i < RETRY_LIMIT; i++) {
      try {
        const before = cfg.saveMode === 'full' ? await $.session.messages() : []
        const r = await $.session.compact({ instructions: instructionsFor(cfg) })
        if (r.skip !== undefined) {
          $.ui.log(`auto-compact: skipped (${r.skip})`, { to: 'debug' })
          return
        }
        await save($, cfg, 'plugin', before, r)
        const { context } = await $.session.usage()
        const after = r.tokensAfter !== undefined ? (r.tokensAfter / context.window) * 100 : 0
        if (cfg.triggerMode === 'threshold' && after >= cfg.threshold) state.cooldown = COOLDOWN_TURNS
        $.ui.toast(`auto-compact: ${why}のため Compaction した`)
        return
      } catch {
        await $.clock.sleep(SETTLE_MS)
      }
    }
    $.ui.log('auto-compact: compaction was rejected every time', { to: 'debug' })
  } finally {
    state.running = false
  }
}

async function onIdle($: any, state: State, cfg: Config) {
  state.idleTimer = undefined
  const { context } = await $.session.usage()
  if (shouldCompactOnIdle(context.percent, cfg.idleMinPercent)) {
    await compact($, state, cfg, 'キャッシュが失効した')
  }
}

const turnEndReason = (cfg: Config, percent: number | undefined) =>
  cfg.triggerMode === 'turns'
    ? `${cfg.everyNTurns}ターン経過した`
    : cfg.triggerMode === 'every'
      ? 'ターンが終わった'
      : `使用率が ${percent}% に達した`

async function check($: any, state: State, cfg: Config) {
  state.turns++
  const { context } = await $.session.usage()
  if (state.cooldown > 0) {
    state.cooldown--
  } else if (isDueAtTurnEnd(cfg, state.turns, context.percent)) {
    await compact($, state, cfg, turnEndReason(cfg, context.percent))
    return
  }
  if (cfg.triggerMode !== 'threshold') return
  cancelIdle(state)
  state.idleTimer = $.clock.after(state.ttlMs, () => void onIdle($, state, cfg).catch(() => {}))
}

type ResumeInfo = {
  source: string
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  context_tokens?: number
}

async function onResume($: any, state: State, cfg: Config, e: ResumeInfo) {
  const learned = ttlFromResume(e.seconds_since_last_response, e.prompt_cache_likely_expired)
  if (learned !== undefined) state.ttlMs = learned
  if (cfg.triggerMode !== 'threshold') return
  if (e.prompt_cache_likely_expired !== true || e.context_tokens === undefined) return
  const { context } = await $.session.usage()
  const percent = (e.context_tokens / context.window) * 100
  if (shouldCompactOnIdle(percent, cfg.idleMinPercent)) {
    await compact($, state, cfg, '再開時にキャッシュが失効していた')
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state: State = { idleTimer: undefined, running: false, cooldown: 0, ttlMs: cfg.ttlMs, turns: 0 }

  on('classic.SessionStart', ($, e, next) => {
    if (e.source === 'resume' || e.source === 'fork') {
      $.clock.after(SETTLE_MS, () => void onResume($, state, cfg, e).catch(() => {}))
    }
    return next(e)
  })

  on('classic.PreModelSwitch', ($, e, next) => {
    state.ttlMs = ttlFromLabel(e.cache_ttl) ?? state.ttlMs
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    if (!cfg.handoff) return { sections }
    return { sections: [...sections, { id: 'auto-compact:handoff', text: HANDOFF_RULE, scope: 'session' }] }
  })

  on('turn.start', ($, e, next) => {
    cancelIdle(state)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      $.clock.after(SETTLE_MS, () => void check($, state, cfg).catch(() => {}))
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    cancelIdle(state)
    state.turns = 0
    const r = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined) return r
    if (r.skip !== undefined) return r

    await save($, cfg, e.trigger, e.messages, r)
    return r
  })
}
