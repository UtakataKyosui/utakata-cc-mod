import { test, expect } from 'claude-code/testing'
import {
  type Body,
  type Task,
  applyOp,
  checksum,
  choose,
  clean,
  decode,
  describeIssues,
  emptyBody,
  encode,
  fingerprint,
  nextSlot,
  normalizePath,
  readConfig,
  reconcile,
  redact,
  renderLedger,
  restoreInterrupted,
} from './policy'

const NOW = '2026-10-06T00:00:00.000Z'
const ctx = (observed: Record<string, string | null> = {}) => ({ now: NOW, observed })

const task = (over: Partial<Task>): Task => ({
  id: 'a',
  title: 't',
  status: 'pending',
  deps: [],
  artifacts: [],
  note: '',
  updatedAt: NOW,
  ...over,
})
const bodyOf = (...tasks: Task[]): Body => ({ goal: 'g', tasks, issues: [] })

const must = (r: ReturnType<typeof applyOp>) => {
  if (!r.ok) throw new Error(r.error)
  return r.body
}

test('設定の既定値', () => {
  expect(readConfig({})).toEqual({ saveDir: '.claude/checkpoints', maxPromptTasks: 20 })
  expect(readConfig({ saveDir: 'x', maxPromptTasks: 7 })).toEqual({ saveDir: 'x', maxPromptTasks: 7 })
})

test('中断した running は再確認対象に戻り、完了にならない', () => {
  const restored = restoreInterrupted(bodyOf(task({ status: 'running' }), task({ id: 'b', status: 'done' })), NOW)
  expect(restored.tasks[0].status).toBe('needs_recheck')
  expect(restored.tasks[0].interruptedAt).toBe(NOW)
  expect(restored.tasks[1].status).toBe('done')
  const { findings } = reconcile(restored, {}, undefined, NOW)
  expect(findings.some(f => f.kind === 'interrupted')).toBe(true)
})

test('検証なしでは done にできず、合格後に成果物が変わると再び done にできない', () => {
  let b = must(applyOp(emptyBody(), { op: 'task', id: 'a', title: '実装', status: 'running' }, ctx()))
  b = must(applyOp(b, { op: 'artifact', id: 'a', paths: ['src/a.ts'] }, ctx()))
  const noVerify = applyOp(b, { op: 'task', id: 'a', status: 'done' }, ctx({ 'src/a.ts': '10:1' }))
  expect(noVerify.ok).toBe(false)

  b = must(applyOp(b, { op: 'verify', id: 'a', command: 'bun test', result: 'pass' }, ctx({ 'src/a.ts': '10:1' })))
  expect(applyOp(b, { op: 'task', id: 'a', status: 'done' }, ctx({ 'src/a.ts': '10:2' })).ok).toBe(false)
  expect(applyOp(b, { op: 'task', id: 'a', status: 'done' }, ctx({ 'src/a.ts': null })).ok).toBe(false)
  const done = must(applyOp(b, { op: 'task', id: 'a', status: 'done' }, ctx({ 'src/a.ts': '10:1' })))
  expect(done.tasks[0].status).toBe('done')
})

test('依存先が未完了なら running にできず、循環も拒否する', () => {
  let b = must(applyOp(emptyBody(), { op: 'task', id: 'a' }, ctx()))
  b = must(applyOp(b, { op: 'task', id: 'b', deps: ['a'] }, ctx()))
  expect(applyOp(b, { op: 'task', id: 'b', status: 'running' }, ctx()).ok).toBe(false)
  expect(applyOp(b, { op: 'task', id: 'a', deps: ['b'] }, ctx()).ok).toBe(false)
  expect(applyOp(b, { op: 'task', id: 'c', deps: ['zzz'] }, ctx()).ok).toBe(false)
})

test('古い状態を検出し、根拠の古い done は再確認へ戻す', () => {
  const done = task({
    status: 'done',
    artifacts: [{ path: 'f.ts' }, { path: 'gone.ts' }],
    verification: { command: 'x', result: 'pass', at: NOW, rev: 'aaaaaaa1', sealed: { 'f.ts': '1:1', 'gone.ts': '2:2' } },
  })
  const r = reconcile(bodyOf(done), { 'f.ts': '1:9', 'gone.ts': null }, 'bbbbbbb2', NOW)
  const kinds = r.findings.map(f => f.kind)
  expect(kinds).toContain('artifact-changed')
  expect(kinds).toContain('artifact-missing')
  expect(kinds).toContain('rev-changed')
  expect(r.body.tasks[0].status).toBe('needs_recheck')

  const fresh = reconcile(bodyOf(done), { 'f.ts': '1:1', 'gone.ts': '2:2' }, 'aaaaaaa1', NOW)
  expect(fresh.findings).toEqual([])
  expect(fresh.body.tasks[0].status).toBe('done')
  expect(fingerprint({ size: 3, mtimeMs: 4.9 })).toBe('3:4')
  expect(fingerprint(undefined)).toBeNull()
})

test('エンコードしたものを復元でき、スキーマ版が新しいものは未来版として扱う', () => {
  const b = bodyOf(task({}))
  const d = decode(encode(b, 3, NOW))
  expect(d.ok && d.seq).toBe(3)
  const future = JSON.stringify({ ...JSON.parse(encode(b, 1, NOW)), schema: 99 })
  const r = decode(future)
  expect(r.ok).toBe(false)
  expect(!r.ok && r.reason).toBe('future-schema')
  const c = choose([{ slot: 'slot-a.json', text: future }])
  expect(c.writable).toBe(false)
  expect(describeIssues(c.issues, c.writable).join('\n')).toContain('読み取り専用')
})

test('破損を診断し、有効な面があればそちらへ戻る', () => {
  const older = encode(bodyOf(task({ title: '旧' })), 1, NOW)
  const newer = encode(bodyOf(task({ title: '新' })), 2, NOW)
  const torn = newer.slice(0, newer.length - 20)
  const c = choose([
    { slot: 'slot-a.json', text: torn },
    { slot: 'slot-b.json', text: older },
  ])
  expect(c.body?.tasks[0].title).toBe('旧')
  expect(c.issues).toEqual([{ slot: 'slot-a.json', reason: 'parse', detail: expect.any(String) }])
  expect(c.writable).toBe(true)

  const tampered = JSON.parse(newer)
  tampered.body.goal = '改ざん'
  expect(decode(JSON.stringify(tampered))).toMatchObject({ ok: false, reason: 'checksum' })
  expect(decode('{"schema":1,"seq":1}')).toMatchObject({ ok: false, reason: 'shape' })

  const none = choose([{ slot: 'slot-a.json', text: undefined }])
  expect(none.body).toBeUndefined()
  expect(none.issues).toEqual([])
})

test('書き込みは直前に有効だった面と別の面へ交互に行う', () => {
  expect(nextSlot(undefined)).toBe('slot-a.json')
  expect(nextSlot('slot-a.json')).toBe('slot-b.json')
  expect(nextSlot('slot-b.json')).toBe('slot-a.json')
  expect(checksum('x')).toBe(checksum('x'))
  expect(checksum('x')).not.toBe(checksum('y'))
})

test('秘密値は保存前に伏せ、長文は切り詰める', () => {
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'
  expect(redact(`key ${secret}`)).not.toContain(secret)
  expect(redact('password=hunter2 ok')).toBe('password=[REDACTED] ok')
  expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghij')
  expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('[REDACTED]')
  expect(clean('word '.repeat(300), 200).length).toBe(201)
  expect(clean('一行目\n二行目', 50)).toBe('一行目 二行目')

  const b = must(applyOp(emptyBody(), { op: 'task', id: 'a', title: `x ${secret}`, note: 'token: abc123' }, ctx()))
  const saved = encode(b, 1, NOW)
  expect(saved).not.toContain(secret)
  expect(saved).not.toContain('abc123')
  const g = must(applyOp(b, { op: 'goal', goal: `deploy with ${secret}` }, ctx()))
  expect(JSON.stringify(g)).not.toContain(secret)
})

test('秘密情報を含みうるパスや範囲外のパスは成果物にできない', () => {
  expect(normalizePath('.env').ok).toBe(false)
  expect(normalizePath('config/.env.local').ok).toBe(false)
  expect(normalizePath('keys/server.pem').ok).toBe(false)
  expect(normalizePath('../x').ok).toBe(false)
  expect(normalizePath('/etc/passwd').ok).toBe(false)
  expect(normalizePath('./src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' })
})

test('表示は未完了を先に並べ、上限で省略する', () => {
  const b = bodyOf(task({ id: 'd', status: 'done' }), task({ id: 'p' }), task({ id: 'q' }))
  const all = renderLedger(b, [], 3)
  expect(all.indexOf(' p ')).toBeLessThan(all.indexOf(' d '))
  const cut = renderLedger(b, [], 2)
  expect(cut).not.toContain(' d ')
  expect(cut).toContain('ほか 1 件')
})

// ---- hook を通した動作 ----

const setup = ($: any, on: any, files: Record<string, string>, fps: Record<string, { size: number; mtimeMs: number }> = {}) => {
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('clock.now', () => ({ value: Date.parse(NOW) }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('command.register', () => ({ value: { command: 'checkpoint' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'rev1\n', stderr: '' } }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_: unknown, e: { path: string }) => {
    const s = fps[e.path]
    if (!s) throw new Error('ENOENT')
    return { value: { kind: 'file', isLink: false, ...s } }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('session.compact', () => ({ messages: [], tokensBefore: 1, tokensAfter: 1 }))
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }
const CALL = 'mcp__task-checkpoint__checkpoint'

test('保存は .gitignore を置き、再開時に running を再確認へ戻して prompt に載せる', async ($, on) => {
  const files: Record<string, string> = {}
  setup($, on, files)
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

  await $.tool.call({ tool: CALL, op: 'goal', goal: 'API を作る' })
  await $.tool.call({ tool: CALL, op: 'task', id: 'a', title: '実装', status: 'running' })
  expect(files['/proj/.claude/checkpoints/.gitignore']).toBe('*\n')
  expect(Object.keys(files).filter(p => p.endsWith('.json')).sort()).toEqual([
    '/proj/.claude/checkpoints/slot-a.json',
    '/proj/.claude/checkpoints/slot-b.json',
  ])

  // 再開: 保存内容から復元する
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
  const composed = await $.prompt.compose(COMPOSE)
  const section = composed.sections.find((s: { id: string }) => s.id === 'task-checkpoint:ledger')
  expect(section.text).toContain('ゴール: API を作る')
  expect(section.text).toContain('(needs_recheck)')
  expect(section.text).not.toContain('(done)')

  const done = await $.tool.call({ tool: CALL, op: 'task', id: 'a', status: 'done' })
  expect(String(done.result)).toContain('完了にできない')
})

test('片方の面が壊れていても有効な面から復元し、診断を prompt に載せる', async ($, on) => {
  const files: Record<string, string> = {}
  const good = encode({ goal: '復元', tasks: [], issues: [] }, 1, NOW)
  files['/proj/.claude/checkpoints/slot-a.json'] = good
  files['/proj/.claude/checkpoints/slot-b.json'] = '{"schema":1,"seq":2,'
  setup($, on, files)
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

  const composed = await $.prompt.compose(COMPOSE)
  const text = composed.sections.at(-1).text
  expect(text).toContain('ゴール: 復元')
  expect(text).toContain('slot-b.json: JSON として読めない')
  expect(files['/proj/.claude/checkpoints/corrupt-slot-b.json']).toBe('{"schema":1,"seq":2,')
})

test('未来版の保存データは上書きしない', async ($, on) => {
  const files: Record<string, string> = {}
  const future = JSON.stringify({ schema: 99, seq: 5, body: {} })
  files['/proj/.claude/checkpoints/slot-a.json'] = future
  setup($, on, files)
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

  const r = await $.tool.call({ tool: CALL, op: 'goal', goal: 'x' })
  expect(String(r.result)).toContain('書き込まない')
  expect(files['/proj/.claude/checkpoints/slot-a.json']).toBe(future)
})

test('照合で成果物の変更を検出し、done を再確認へ戻す', async ($, on) => {
  const files: Record<string, string> = {}
  const fps: Record<string, { size: number; mtimeMs: number }> = { '/proj/src/a.ts': { size: 10, mtimeMs: 1 } }
  setup($, on, files, fps)
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

  await $.tool.call({ tool: CALL, op: 'task', id: 'a', title: '実装', status: 'running' })
  await $.tool.call({ tool: CALL, op: 'artifact', id: 'a', paths: ['src/a.ts'] })
  await $.tool.call({ tool: CALL, op: 'verify', id: 'a', command: 'bun test', result: 'pass' })
  const ok = await $.tool.call({ tool: CALL, op: 'task', id: 'a', status: 'done' })
  expect(String(ok.result)).toContain('(done)')

  fps['/proj/src/a.ts'] = { size: 11, mtimeMs: 2 }
  const r = await $.tool.call({ tool: CALL, op: 'reconcile' })
  expect(String(r.result)).toContain('(needs_recheck)')
  expect(String(r.result)).toContain('検証のあとに変わった')
})

test('/goal の文をゴールとして拾い、/checkpoint で表示できる', async ($, on) => {
  const files: Record<string, string> = {}
  setup($, on, files)
  on('command.run', { command: 'goal' }, () => ({ text: 'Goal set' }))
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

  await $.command.run({ command: 'goal', args: 'ログインを作る' })
  const shown = await $.command.run({ command: 'checkpoint', args: '' })
  expect(shown.text).toContain('ゴール: ログインを作る')
  const diag = await $.command.run({ command: 'checkpoint', args: 'diagnose' })
  expect(diag.text).toContain('問題はない')
})
