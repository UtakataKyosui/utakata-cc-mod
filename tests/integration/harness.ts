// 複数プラグインの register を 1 つの模擬エンジンへ束ねる。
// claude plugin test は検証中のプラグイン以外のフォルダを読めないため、実プラグインの同時検証は bun で行う。
// 連鎖の規則 (先に載せたプラグインが外側、hook が例外を投げたら飛ばす) は plugins/harness-profile/hooks/engine.test.ts で実エンジンと照合している。
type Fn = (...args: any[]) => any
type Hook = { plugin: string; matcher: Record<string, unknown> | undefined; fn: Fn }
type ProcResult = { exitCode: number; stdout: string; stderr: string }

export type Spec = { name: string; dir: string; options?: Record<string, unknown> }

export type World = {
  proc: (argv: readonly string[], init?: { stdin?: string }) => ProcResult | Promise<ProcResult>
  http: (url: string, init?: { body?: string }) => { ok: boolean; status: number; text: string } | Promise<{ ok: boolean; status: number; text: string }>
  usagePercent: () => number | undefined
  compact: () => unknown | Promise<unknown>
  settings: () => unknown
}

export const defaultWorld = (): World => ({
  proc: () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
  http: () => ({ ok: false, status: 503, text: '' }),
  usagePercent: () => 10,
  compact: () => ({ messages: [{ role: 'user', text: '要約', toolUses: [] }], tokensBefore: 130000, tokensAfter: 8000 }),
  settings: () => ({}),
})

let loads = 0

export async function boot(specs: readonly Spec[], overrides: Partial<World> = {}) {
  const world: World = { ...defaultWorld(), ...overrides }
  const hooks = new Map<string, Hook[]>()
  const toasts: string[] = []
  const logs: string[] = []
  const procs: (readonly string[])[] = []
  const httpUrls: string[] = []
  const tools: string[] = []
  const commands: string[] = []
  const files = new Map<string, string>()
  const skipped: string[] = []
  const history: { type: string; name: string }[] = []

  // 手動の時計。sleep と after は advance で期限が来たときに動く。
  let now = 0
  const waits: { due: number; run: () => void; live: boolean }[] = []
  const wait = (ms: number, run: () => void) => {
    const w = { due: now + ms, run, live: true }
    waits.push(w)
    return w
  }
  const clock = {
    now: async () => now,
    sleep: (ms: number) => new Promise<void>(res => void wait(ms, res)),
    after: (ms: number, fn: () => void) => {
      const w = wait(ms, fn)
      return { cancel: () => void (w.live = false) }
    },
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = waits.filter(w => w.live && w.due <= end).sort((a, b) => a.due - b.due)[0]
      if (next === undefined) break
      next.live = false
      now = Math.max(now, next.due)
      next.run()
      await settle()
    }
    now = end
    await settle()
  }
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0))
  }

  const makeEngine = (plugin: string) => ({
    plugin: { name: plugin, root: `/plugins/${plugin}` },
    clock,
    ui: { toast: (t: string) => void toasts.push(t), log: (t: string) => void logs.push(t), status: () => {} },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        procs.push(argv)
        return { isStdoutTruncated: false, isStderrTruncated: false, ...(await world.proc(argv, init)) }
      },
    },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        httpUrls.push(url)
        return { headers: {}, ...(await world.http(url, init)) }
      },
    },
    tool: { register: async (t: { name: string }) => void tools.push(t.name) },
    command: { register: async (c: { name: string }) => void commands.push(c.name) },
    fs: {
      read: async (p: string) => {
        const v = files.get(p)
        if (v === undefined) throw new Error(`ENOENT ${p}`)
        return v
      },
      write: async (p: string, t: string) => void files.set(p, t),
      exists: async (p: string) => files.has(p),
    },
    session: {
      root: async () => '/repo',
      id: async () => 'sess',
      messages: async () => [{ role: 'assistant', content: history }],
      usage: async () => ({ startedAt: 0, context: { window: 200000, percent: world.usagePercent() }, rateLimits: [] }),
      compact: async () => dispatch('session.compact', { trigger: 'plugin', messages: [] }, () => world.compact()),
    },
    settings: { read: async () => world.settings() },
  })

  for (const spec of specs) {
    const mod = await import(`../../plugins/${spec.dir}?load=${++loads}`)
    mod.register((event: string, a: unknown, b?: unknown) => {
      const matcher = typeof a === 'function' ? undefined : (a as Record<string, unknown>)
      const fn = (typeof a === 'function' ? a : b) as Fn
      hooks.set(event, [...(hooks.get(event) ?? []), { plugin: spec.name, matcher, fn }])
    }, spec.options ?? {})
  }

  const engines = new Map(specs.map(s => [s.name, makeEngine(s.name)]))

  async function dispatch(event: string, input: any, bottom: Fn): Promise<any> {
    const chain = (hooks.get(event) ?? []).filter(h => h.matcher === undefined || Object.entries(h.matcher).every(([k, v]) => input[k] === v))
    const run = async (i: number, e: any): Promise<any> => {
      const hook = chain[i]
      if (hook === undefined) return bottom(e)
      let called = false
      let result: any
      const next = async (ne: any) => {
        called = true
        return (result = await run(i + 1, ne))
      }
      try {
        return await hook.fn(engines.get(hook.plugin), e, next)
      } catch (err) {
        skipped.push(`${hook.plugin}: ${event}: ${String(err)}`)
        return called ? result : run(i + 1, e)
      }
    }
    return run(0, input)
  }

  const any = engines.values().next().value
  return {
    advance,
    settle,
    toasts,
    logs,
    procs,
    httpUrls,
    tools,
    commands,
    files,
    skipped,
    start: () => dispatch('session.start', {}, (e: unknown) => e),
    compose: async () =>
      (await dispatch('prompt.compose', {}, () => ({ sections: [{ id: 'base', text: 'base', scope: 'session' }] }))).sections as { id: string; text: string }[],
    toolCall: (input: { tool: string } & Record<string, unknown>) => {
      let reached = 0
      history.push({ type: 'tool_use', name: input.tool })
      const r = dispatch('tool.call', input, () => {
        reached++
        return { result: 'ok', text: 'ok' }
      })
      return r.then(v => ({ ...v, reached }))
    },
    command: (command: string, args: string) => dispatch('command.run', { command, args }, () => ({ text: 'builtin' })),
    submit: (text: string, extra: Record<string, unknown> = {}) => dispatch('prompt.submit', { text, ...extra }, (e: unknown) => e),
    spawn: (extra: Record<string, unknown> = {}) => {
      const seen: any[] = []
      const r = dispatch('agent.spawn', { tool_use_id: 't', prompt: '調査して', description: '調査', subagentType: 'Explore', fork: false, ...extra }, (e: any) => {
        seen.push(e)
        return { model: e.model ?? 'default', agentId: 'a1' }
      })
      return r.then(v => ({ ...v, seen }))
    },
    complete: (answer: string, extra: Record<string, unknown> = {}) =>
      dispatch('turn.complete', { answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra }, (e: unknown) => e),
    engine: any,
  }
}

export const ids = (sections: readonly { id: string }[]) => sections.map(s => s.id)
