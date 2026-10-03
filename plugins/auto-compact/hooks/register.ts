import type { Register } from 'claude-code'
import {
  COOLDOWN_TURNS,
  type Config,
  buildDocument,
  fileName,
  readConfig,
  resolveDir,
  shouldCompactAtTurnEnd,
  shouldCompactOnIdle,
} from './policy'

const SETTLE_MS = 1000
const RETRY_LIMIT = 5

const INSTRUCTIONS =
  '進行中のタスク、決定事項、未解決の問題、変更したファイルと次にやることを優先して残す'

type State = { idleTimer: { cancel: () => void } | undefined; running: boolean; cooldown: number }

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
  try {
    for (let i = 0; i < RETRY_LIMIT; i++) {
      try {
        const before = cfg.saveMode === 'full' ? await $.session.messages() : []
        const r = await $.session.compact({ instructions: INSTRUCTIONS })
        if (r.skip !== undefined) {
          $.ui.log(`auto-compact: skipped (${r.skip})`, { to: 'debug' })
          return
        }
        await save($, cfg, 'plugin', before, r)
        const { context } = await $.session.usage()
        const after = r.tokensAfter !== undefined ? (r.tokensAfter / context.window) * 100 : 0
        if (after >= cfg.threshold) state.cooldown = COOLDOWN_TURNS
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

async function check($: any, state: State, cfg: Config) {
  const { context } = await $.session.usage()
  if (state.cooldown > 0) {
    state.cooldown--
  } else if (shouldCompactAtTurnEnd(context.percent, cfg.threshold)) {
    await compact($, state, cfg, `使用率が ${context.percent}% に達した`)
    return
  }
  cancelIdle(state)
  state.idleTimer = $.clock.after(cfg.ttlMs, () => void onIdle($, state, cfg).catch(() => {}))
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state: State = { idleTimer: undefined, running: false, cooldown: 0 }

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
    const r = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined) return r
    if (r.skip !== undefined) return r

    await save($, cfg, e.trigger, e.messages, r)
    return r
  })
}
