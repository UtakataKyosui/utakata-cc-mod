// 複数プラグインを同時に載せたときに実エンジンがどう振る舞うか。tests/integration の模擬エンジンの前提を確かめる。
import { test, expect } from 'claude-code/testing'

const COMPOSE = { model: 'm', promptModel: 'm', outputStyle: null, tools: [], traits: [], surfaces: [] } as any
const ids = (r: any) => r.sections.map((s: { id: string }) => s.id)


test('prompt.compose の section は tier と登録順で外側から積まれる', {
  plugins: [
    { name: 'a', register: (on: any) => { on('prompt.compose', async (_$: any, e: any, next: any) => { const c = await next(e); return { sections: [...c.sections, { id: 'a', text: 'a', scope: 'session' }] } }) } },
    { name: 'b', register: (on: any) => { on('prompt.compose', async (_$: any, e: any, next: any) => { const c = await next(e); return { sections: [...c.sections, { id: 'b', text: 'b', scope: 'session' }] } }) } },
    { name: 'c', tier: 'append', register: (on: any) => { on('prompt.compose', async (_$: any, e: any, next: any) => { const c = await next(e); return { sections: [...c.sections, { id: 'c', text: 'c', scope: 'session' }] } }) } },
    { name: 'd', tier: 'prepend', register: (on: any) => { on('prompt.compose', async (_$: any, e: any, next: any) => { const c = await next(e); return { sections: [...c.sections, { id: 'd', text: 'd', scope: 'session' }] } }) } },
  ],
}, async ($: any, on: any) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'session' }] }))
  // 内側の append が最初に積み、外側の prepend が最後に積む
  expect(ids(await $.prompt.compose(COMPOSE))).toEqual(['base', 'c', 'b', 'a', 'd'])
})

test('外側のプラグインの deny は内側と下層に届かない', {
  plugins: [
    { name: 'outer', register: (on: any) => { on('tool.call', (_$: any, e: any, next: any) => (e.tool === 'Write' ? { deny: 'outer denied' } : next(e))) } },
    { name: 'inner', register: (on: any) => { on('tool.call', (_$: any, e: any, next: any) => next(e)) } },
  ],
}, async ($: any, on: any) => {
  let reached = 0
  on('tool.call', () => { reached++; return { result: 'ok', text: 'ok' } })
  const denied = await $.tool.call({ tool: 'Write', file_path: '/tmp/a.md', content: 'x' })
  expect(denied.deny).toBe('outer denied')
  expect(reached).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' })
  expect(reached).toBe(1)
})

test('例外を投げた hook は飛ばされ、ほかのプラグインの hook は動き続ける', {
  plugins: [
    { name: 'broken', register: (on: any) => { on('prompt.compose', () => { throw new Error('boom') }) } },
    { name: 'healthy', register: (on: any) => { on('prompt.compose', async (_$: any, e: any, next: any) => { const c = await next(e); return { sections: [...c.sections, { id: 'healthy', text: 'h', scope: 'session' }] } }) } },
  ],
}, async ($: any, on: any) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'session' }] }))
  expect(ids(await $.prompt.compose(COMPOSE))).toEqual(['base', 'healthy'])
})
