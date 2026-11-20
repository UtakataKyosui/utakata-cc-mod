import { test, expect, mock } from 'claude-code/testing'
import { approvalCovers, cwdFromLsof, claudePids, digest, isCacheTarget, isQuarantineRoot, mentions, parseJournal, quarantineRoot } from './exec'

const PLAN = 'mcp__repo-storage-manager__plan_preservation'
const EXEC = 'mcp__repo-storage-manager__execute_preservation'
const PURGE = 'mcp__repo-storage-manager__purge_preservation'
const RESTORE = 'mcp__repo-storage-manager__restore_preservation'
const REPO = '/w/old'

type Kind = 'dir' | 'file' | 'link'

/** シェルもファイルも触らない、ファイルシステムと git の模擬。argv をすべて記録する。 */
const world = (on: any, init: Record<string, any> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const kinds = new Map<string, Kind>(Object.entries({
    '/w': 'dir', '/w/old': 'dir', '/w/old/node_modules': 'dir', '/w/old/package.json': 'file', '/w/old/.git': 'dir', '/w/old/.git/config': 'file', '/w/old/.git/hooks': 'dir', '/backup': 'dir',
    ...(init.kinds ?? {}),
  }) as [string, Kind][])
  const text: Record<string, string> = {}
  const calls: string[][] = []
  const st: any = {
    head: 'abc', status: '# branch.upstream o/m\n# branch.ab +0 -0\n', claude: [] as { pid: number; cwd: string }[], psFail: false,
    mvFail: '', refs: 'refs/heads/main abc', cloneRefs: 'refs/heads/main abc', cloneHead: 'abc', top: {} as Record<string, string>,
    mounts: { '/backup': '/mnt/b' } as Record<string, string>, tracked: '', sha: 'a'.repeat(64), ...init.st,
  }
  const out = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr } })
  const mountOf = (p: string) => Object.keys(st.mounts).filter(k => p === k || p.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0] ?? '/'
  const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
  const removeTree = (p: string) => [...kinds.keys()].filter(k => k === p || k.startsWith(`${p}/`)).forEach(k => kinds.delete(k))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    const a = [...e.argv]
    calls.push(a)
    const path = a[2] ?? ''
    switch (a[0]) {
      case 'ghq': case 'gdu': return out('', 127)
      case 'pwd': return out('/elsewhere\n')
      case 'du': return out(`${st.size ?? 100}\t${a[3]}\n`)
      case 'df': return out(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1000 1 ${st.avail ?? 500} 1% ${mountOf(a[2]!)}\n`)
      case 'test': {
        const k = kinds.get(path)
        return out('', a[1] === '-d' ? (k === 'dir' ? 0 : 1) : a[1] === '-f' ? (k === 'file' ? 0 : 1) : k ? 0 : 1)
      }
      case 'mkdir': if (kinds.has(a[2]!)) return out('', 1, 'exists'); kinds.set(a[2]!, 'dir'); return out()
      case 'mv': {
        const [from, to] = [a[3]!, a[4]!]
        if (st.mvFail === from || !kinds.has(from) || kinds.has(to)) return out('', 1, 'mv failed')
        for (const k of [...kinds.keys()]) if (k === from || k.startsWith(`${from}/`)) { kinds.set(to + k.slice(from.length), kinds.get(k)!); kinds.delete(k) }
        return out()
      }
      case 'rm': { const p = a[a.length - 1]!; removeTree(p); return out() }
      case 'find': {
        const depth = a[a.indexOf('-maxdepth') + 1]
        if (depth === '0') return out(kinds.get(a[1]!) === 'dir' && a.includes('d') ? a[1]! : '')
        const names = a.flatMap((x, i) => (a[i - 1] === '-name' ? [x] : []))
        const want = a[a.indexOf('-type') + 1] as string
        const kind = want === 'd' ? 'dir' : 'file'
        return out([...kinds.entries()].filter(([k, v]) => dirnameOf(k) === a[1] && v === kind && names.includes(k.slice(k.lastIndexOf('/') + 1))).map(([k]) => `${k}\0`).join(''))
      }
      case 'ps': return st.psFail ? out('', 1) : out(st.claude.map((c: any) => `${c.pid} claude`).join('\n') + '\n')
      case 'lsof': return out(`p${a[2]}\nfcwd\nn${st.claude.find((c: any) => String(c.pid) === a[2])?.cwd}\n`)
      case 'sha256sum': return out(`${st.shaMap?.[a[2]!] ?? st.sha}  ${a[2]}\n`)
      case 'rmdir': { const p = a[2]!; if ([...kinds.keys()].some(k => k.startsWith(`${p}/`))) return out('', 1, 'not empty'); kinds.delete(p); return out() }
      case 'tar': kinds.set(a[2]!, 'file'); return out()
      case 'git': {
        if (a[1] === 'clone') { kinds.set(a[6]!, 'dir'); return out() }
        const sub = a[3]
        const rest = a.slice(4)
        if (sub === 'rev-parse') {
          if (rest.includes('--show-superproject-working-tree')) return out(st.superproject ?? '')
          if (rest.includes('--show-toplevel')) return out(`${st.top[path] ?? path}\n`)
          if (rest.includes('HEAD')) return out(`${path.includes('.rsm-rehearsal') ? st.cloneHead : st.head}\n`)
          return out(`false\n${path}/.git\n${path}/.git\n`)
        }
        if (sub === 'worktree') return out(`worktree ${path}\nbranch refs/heads/main\n`)
        if (sub === 'status') return out(st.status)
        if (sub === 'for-each-ref') return rest.some(x => x.includes('upstream')) ? out('main\to/m\t\n') : out(path.includes('.rsm-rehearsal') ? st.cloneRefs : st.refs)
        if (sub === 'stash') return out('')
        if (sub === 'log') return out('1500000000\n')
        if (sub === 'ls-files') return out(rest.includes('--others') ? (st.ignored ?? 'node_modules/\n') : st.tracked)
        if (sub === 'bundle' && rest[0] === 'create') { kinds.set(rest[1]!, 'file'); return out() }
        return out()
      }
    }
    return out('', 127)
  })
  on('fs.read', (_$: unknown, e: { path: string }) => { if (!(e.path in text)) throw new Error('ENOENT'); return { value: text[e.path] } })
  let writes = 0
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    if (e.path.endsWith('/journal.json') && st.journalWrites !== undefined && writes++ >= st.journalWrites) throw new Error('ENOSPC')
    text[e.path] = e.text
    return { value: undefined }
  })
  return { clock, kinds, text, calls, st }
}

const ask = (q: string) => ({ tool: 'AskUserQuestion', questions: [{ question: q, header: '確認', multiSelect: false, options: [{ label: 'はい、実行する', description: '' }, { label: 'いいえ', description: '' }] }] }) as any
const answer = (on: any, label: string) => on('tool.call', { tool: /^AskUserQuestion$/ }, () => ({ result: { answers: { 確認: label } } }))

const makePlan = async ($: any, operation = 'cache-only', extra: object = {}) =>
  JSON.parse((await $.tool.call({ tool: PLAN, paths: [REPO], operation, format: 'json', ...extra })).result)
const approve = async ($: any, q: string) => { await $.tool.call(ask(q)) }

/** どの操作でも、rm -f 系・シェル経由・退避ディレクトリ以外への rm -r をしていないこと。 */
const assertSafe = (calls: string[][]) => {
  for (const a of calls) {
    expect(['sh', 'bash'].includes(a[0]!)).toBe(false)
    if (a[0] === 'rm') {
      expect(a.some(x => /^-[a-zA-Z]*f/.test(x))).toBe(false)
      expect(a).toContain('--')
      expect(a[a.length - 1]).toMatch(/\.rsm-(trash|rehearsal)-[0-9a-f-]+$|\.bundle$|\.manifest\.json$|\.extras\.tar$/)
    }
  }
}

test('承認の純粋な照合: ID・全対象パスの復唱・期限・パスの境界', () => {
  const a = { text: '計画 RSM-0123456789 の /w/old と /w/other を実行しますか', at: 1000 }
  expect(approvalCovers(a, 2000, ['RSM-0123456789'], ['/w/old', '/w/other'])).toBeUndefined()
  expect(approvalCovers(undefined, 2000, [], [])).toContain('承認がない')
  expect(approvalCovers(a, 2000, ['RSM-0123456789'], ['/w/old', '/w/third'])).toContain('/w/third')
  expect(approvalCovers(a, 2000, ['RSM-aaaaaaaaaa'], [])).toContain('RSM-aaaaaaaaaa')
  expect(approvalCovers(a, 1000 + 181_000, ['RSM-0123456789'], [])).toContain('期限')
  expect(mentions('対象は /w/old2 です', '/w/old')).toBe(false)
  expect(mentions('対象は /w/old です', '/w/old')).toBe(true)
})

test('パス・ジャーナルの検証: 退避先の改ざんや想定外の対象を拒否する', () => {
  expect(isCacheTarget('/w/old', '/w/old/node_modules')).toBe(true)
  expect(isCacheTarget('/w/old', '/w/old/src')).toBe(false)
  expect(isCacheTarget('/w/old', '/w/old/node_modules/x')).toBe(false)
  expect(isCacheTarget('/w/old', '/w/old/../etc/node_modules')).toBe(false)
  const root = quarantineRoot('/w/old', 'RSM-0123456789-0')
  expect(root).toBe('/w/.rsm-trash-0123456789-0')
  expect(isQuarantineRoot(root, '/w/old')).toBe(true)
  expect(isQuarantineRoot('/w/.rsm-trash-zz', '/w/old')).toBe(false)
  expect(isQuarantineRoot('/other/.rsm-trash-0123456789-0', '/w/old')).toBe(false)
  const j = { schema: 'repo-preservation-journal-1', opId: 'RSM-0123456789-0', planId: 'RSM-0123456789', operation: 'cache-only', repo: '/w/old', status: 'staged', createdAt: '', entries: [{ name: 'node_modules', from: '/w/old/node_modules', to: `${root}/node_modules` }] }
  expect(parseJournal(JSON.stringify(j))).toBeDefined()
  expect(parseJournal(JSON.stringify({ ...j, entries: [{ ...j.entries[0], from: '/etc' }] }))).toBeUndefined()
  expect(parseJournal(JSON.stringify({ ...j, entries: [{ ...j.entries[0], to: '/etc/node_modules' }] }))).toBeUndefined()
  expect(parseJournal('{broken')).toBeUndefined()
  expect(claudePids('  10 claude\n  11 /usr/bin/claude --x\n  12 node /x/claude/server.js\n')).toEqual([10, 11])
  expect(cwdFromLsof('p10\nfcwd\nn/w/old\n')).toBe('/w/old')
  expect(digest('a')).not.toBe(digest('b'))
})

test('承認なしでは実行されず、dry_run が既定で何も変更しない', async ($: any, on: any) => {
  const w = world(on)
  const plan = await makePlan($)
  expect(plan.items[0].status).toBe('PLANNED')
  const dry = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO] })
  expect(dry.result).toContain('Dry Run')
  const denied = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(denied.deny).toContain('承認がない')
  expect(w.calls.some(a => ['mv', 'rm', 'mkdir'].includes(a[0]!))).toBe(false)
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
})

test('承認後に生成物を退避し、ジャーナルを残す。承認は 1 回限りで容量はまだ回収されない', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($)
  await approve($, `計画 ${plan.planId} で ${REPO} の生成物を退避します。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('OK')
  expect(r.result).toContain('容量は purge するまで回収されない')
  expect(w.kinds.has('/w/old/node_modules')).toBe(false)
  const opId = `${plan.planId}-0`
  const root = quarantineRoot(REPO, opId)
  expect(w.kinds.get(`${root}/node_modules`)).toBe('dir')
  expect(parseJournal(w.text[`${root}/journal.json`]!)?.status).toBe('staged')
  expect(w.calls.some(a => a[0] === 'rm')).toBe(false)
  const again = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(again.deny).toContain('承認がない')
  assertSafe(w.calls)
})

test('承認の質問が ID・対象を復唱していない、拒否された、期限切れのときは実行しない', async ($: any, on: any) => {
  const w = world(on)
  answer(on, 'はい、実行する')
  const plan = await makePlan($)
  await approve($, `計画 ${plan.planId} を実行しますか？`)
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })).deny).toContain(REPO)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  await w.clock.advance(181_000)
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })).deny).toContain('期限')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
})

test('利用者が「しない」を選んだ承認は記録されない', async ($: any, on: any) => {
  const w = world(on)
  answer(on, 'いいえ')
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })).deny).toContain('承認がない')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
})

test('TOCTOU: 計画後に git の状態が変わったら、承認があっても実行しない', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($)
  w.st.status += '1 .M src/x.ts\n'
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('STATE_CHANGED')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
})

test('稼働中セッション・セッション確認不能・symlink・パスの正規化違反は実行しない', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($)
  const run = async () => {
    await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
    return (await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })).result as string
  }
  w.st.claude = [{ pid: 7, cwd: '/w/old/src' }]
  expect(await run()).toContain('ACTIVE_SESSION')
  w.st.claude = []
  w.st.psFail = true
  expect(await run()).toContain('ACTIVE_SESSION_UNCHECKABLE')
  w.st.psFail = false
  w.kinds.set('/w/old/node_modules', 'link')
  expect(await run()).toContain('TARGET_NOT_DIR_OR_SYMLINK')
  w.kinds.set('/w/old/node_modules', 'dir')
  w.st.top[REPO] = '/real/old'
  expect(await run()).toContain('PATH_NOT_CANONICAL')
  w.st.top = {}
  w.st.tracked = 'node_modules/x\n'
  expect(await run()).toContain('TARGET_TRACKED')
  expect(w.calls.some(a => a[0] === 'mv' || a[0] === 'rm')).toBe(false)
})

test('部分失敗: 途中で mv が失敗したら、退避済みのものを元に戻す', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on, { kinds: { '/w/old/target': 'dir', '/w/old/Cargo.toml': 'file' }, st: { mvFail: '/w/old/target' } })
  const plan = await makePlan($)
  expect(plan.items[0].targets).toHaveLength(2)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('失敗')
  expect(r.result).toContain('元に戻した')
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
  expect(w.kinds.get('/w/old/target')).toBe('dir')
})

test('別ファイルシステムへ跨ぐ退避 (コピーになる移動) は拒否する', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on, { st: { mounts: { '/w/old/node_modules': '/mnt/nm' } } })
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('別ファイルシステム')
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
})

test('purge: 承認が必要で、検証済みの退避ディレクトリだけを rm -r -- で削除する。実測値を出す', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  const opId = `${plan.planId}-0`
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: 'x', dry_run: false })).deny).toContain('invalid')
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })).deny).toContain('承認がない')
  await approve($, `退避済みの ${opId} (${REPO}) を削除しますか？`)
  w.st.avail = 500
  const r = await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })
  expect(r.result).toContain('OK')
  expect(r.result).toContain('実測')
  const rms = w.calls.filter(a => a[0] === 'rm')
  expect(rms).toEqual([['rm', '-r', '--', quarantineRoot(REPO, opId)]])
  expect(w.kinds.has(quarantineRoot(REPO, opId))).toBe(false)
  assertSafe(w.calls)
})

test('restore: 元の場所に戻し、元の場所に何かあれば拒否する', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  const opId = `${plan.planId}-0`
  w.kinds.set('/w/old/node_modules', 'dir')
  expect((await $.tool.call({ tool: RESTORE, repo: REPO, op_id: opId })).result).toContain('両方に存在')
  w.kinds.delete('/w/old/node_modules')
  const r = await $.tool.call({ tool: RESTORE, repo: REPO, op_id: opId })
  expect(r.result).toContain('OK')
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
  expect(parseJournal(w.text[`${quarantineRoot(REPO, opId)}/journal.json`]!)?.status).toBe('restored')
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId })).result).toContain('Dry Run')
})

test('archive: bundle・verify・復元リハーサル・manifest が揃い、元は残る', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($, 'archive', { destination: '/backup' })
  expect(plan.items[0].status).toBe('PLANNED')
  await approve($, `${plan.planId} の ${REPO} を /backup へアーカイブします。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('OK')
  expect(r.result).toContain('復元リハーサル: ref 一覧と HEAD が一致')
  const manifest = JSON.parse(w.text[`/backup/old-${plan.planId}-0.manifest.json`]!)
  expect(manifest).toMatchObject({ schema: 'repo-preservation-manifest-1', sha256: 'a'.repeat(64), source: REPO, head: 'abc' })
  expect(w.kinds.get(REPO)).toBe('dir')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
  assertSafe(w.calls)
})

test('archive: 復元リハーサルが一致しなければ失敗し、作った bundle を片付けて元は触らない', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on, { st: { cloneRefs: 'refs/heads/main zzz' } })
  const plan = await makePlan($, 'relocate', { destination: '/backup' })
  await approve($, `${plan.planId} の ${REPO} を退避します。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('復元リハーサルで ref か HEAD が元と一致しない')
  expect(w.kinds.has(`/backup/old-${plan.planId}-0.bundle`)).toBe(false)
  expect(Object.keys(w.text).some(k => k.endsWith('.manifest.json'))).toBe(false)
  expect(w.kinds.get(REPO)).toBe('dir')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
  assertSafe(w.calls)
})

test('relocate: アーカイブ後に退避し、purge は bundle の sha256 が記録と一致するときだけ', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($, 'relocate', { destination: '/backup' })
  await approve($, `${plan.planId} の ${REPO} を退避します。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('OK')
  const opId = `${plan.planId}-0`
  expect(w.kinds.has(REPO)).toBe(false)
  expect(w.kinds.get(`${quarantineRoot(REPO, opId)}/old`)).toBe('dir')
  w.st.sha = 'b'.repeat(64)
  await approve($, `退避済みの ${opId} (${REPO}) を削除しますか？`)
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })).result).toContain('sha256 が記録と一致しない')
  expect(w.calls.some(a => a[0] === 'rm' && a[a.length - 1]!.includes('.rsm-trash-'))).toBe(false)
  w.st.sha = 'a'.repeat(64)
  await approve($, `退避済みの ${opId} (${REPO}) を削除しますか？`)
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })).result).toContain('OK')
  assertSafe(w.calls)
})

test('計画に無い・EXCLUDED・不正な入力は拒否する', async ($: any, on: any) => {
  world(on)
  const plan = await makePlan($)
  expect((await $.tool.call({ tool: EXEC, plan_id: 'RSM-nothex', paths: [REPO] })).deny).toContain('invalid')
  expect((await $.tool.call({ tool: EXEC, plan_id: 'RSM-0000000000', paths: [REPO] })).deny).toContain('見つからない')
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: ['/w/other'] })).deny).toContain('PLANNED でない')
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: ['/w/old/../x'] })).deny).toContain('absolute')
  expect((await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [] })).deny).toBeDefined()
})

/** 質問ごとの回答を返すモック。key は質問文。 */
const answerPer = (on: any, byQuestion: (q: string) => string) =>
  on('tool.call', { tool: /^AskUserQuestion$/ }, (_$: unknown, e: any) => ({ result: { answers: Object.fromEntries(e.questions.map((q: any) => [q.question, byQuestion(q.question)])) } }))
const ask2 = (...qs: string[]) => ({ tool: 'AskUserQuestion', questions: qs.map((question, i) => ({ question, header: `q${i}`, multiSelect: false, options: [{ label: 'はい、実行する', description: '' }, { label: 'いいえ', description: '' }] })) }) as any

test('複数質問: 別の質問への「はい」で、拒否した操作は承認されない (質問ごとに回答を対応づける)', async ($: any, on: any) => {
  const w = world(on)
  answerPer(on, q => (q.includes('[拒否]') ? 'いいえ' : 'はい、実行する'))
  const plan = await makePlan($)
  const q1 = `[拒否] ${plan.planId} の ${REPO} を実行しますか？`
  await $.tool.call(ask2(q1, 'この後ビルドを続けますか？'))
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.deny).toContain('承認がない')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
})

test('複数質問: 承認の対象は、肯定された質問に書かれた ID とパスだけ', async ($: any, on: any) => {
  const w = world(on, { kinds: { '/w/other': 'dir' } })
  answerPer(on, q => (q.includes('/w/other') ? 'いいえ' : 'はい、実行する'))
  const plan = await makePlan($)
  const yes = `${plan.planId} の ${REPO} を実行しますか？`
  const no = `RSM-ffffffffff の /w/other を実行しますか？`
  await $.tool.call(ask2(yes, no))
  expect((await $.tool.call({ tool: PURGE, repo: '/w/other', op_id: 'RSM-ffffffffff-0', dry_run: false })).deny).toContain('承認の質問文')
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('OK')
  expect(w.kinds.has('/w/old/node_modules')).toBe(false)
})

test('relocate: bundle に含まれない gitignore 済みのデータ (.env) があれば、アーカイブも退避もせず拒否する', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on, { st: { ignored: 'node_modules/\n.env\n' } })
  const plan = await makePlan($, 'relocate', { destination: '/backup' })
  await approve($, `${plan.planId} の ${REPO} を退避します。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('IGNORED_DATA_NOT_PRESERVED')
  expect(r.result).toContain('.env')
  expect(w.calls.some(a => a[0] === 'mv' || a[0] === 'rm' || (a[0] === 'git' && a[3] === 'bundle'))).toBe(false)
  expect(w.kinds.get(REPO)).toBe('dir')
})

test('relocate: .git の config / hooks / info を extras として保全し、purge は extras の sha256 も確認する', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($, 'relocate', { destination: '/backup' })
  await approve($, `${plan.planId} の ${REPO} を退避します。実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('extras 保全')
  const opId = `${plan.planId}-0`
  const extras = `/backup/old-${opId}.extras.tar`
  const tar = w.calls.find(a => a[0] === 'tar')!
  expect(tar).toEqual(['tar', '-cf', extras, '-C', '/w/old/.git', 'config', 'hooks'])
  expect(JSON.parse(w.text[`/backup/old-${opId}.manifest.json`]!).extras.contents).toEqual(['.git/config', '.git/hooks'])
  w.st.shaMap = { [extras]: 'c'.repeat(64) }
  await approve($, `退避済みの ${opId} (${REPO}) を削除しますか？`)
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })).result).toContain('extras')
  expect(w.calls.some(a => a[0] === 'rm' && a[a.length - 1]!.includes('.rsm-trash-'))).toBe(false)
  assertSafe(w.calls)
})

test('archive: 既にある同名のファイル・復元リハーサル用ディレクトリは、衝突として拒否し、削除しない', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on)
  const plan = await makePlan($, 'archive', { destination: '/backup' })
  const rehearsal = `/backup/.rsm-rehearsal-${plan.planId.slice(4)}-0`
  w.kinds.set(rehearsal, 'dir')
  w.kinds.set(`${rehearsal}/precious`, 'file')
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('既にある')
  expect(w.calls.some(a => a[0] === 'rm')).toBe(false)
  expect(w.kinds.get(`${rehearsal}/precious`)).toBe('file')
  expect(w.calls.some(a => a[0] === 'git' && (a[3] === 'bundle' || a[1] === 'clone'))).toBe(false)
})

test('ジャーナルを最初に書けなければ、何も動かさずに中止する', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w = world(on, { st: { journalWrites: 0 } })
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r.result).toContain('何も動かさずに中止')
  expect(w.calls.some(a => a[0] === 'mv')).toBe(false)
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
  expect(w.kinds.has(quarantineRoot(REPO, `${plan.planId}-0`))).toBe(false)
})

test('ジャーナルを確定できなければ、退避済みのものを元に戻す', async ($: any, on: any) => {
  answer(on, 'はい、実行する')
  const w2 = world(on, { st: { journalWrites: 1 } })
  const plan = await makePlan($)
  await approve($, `${plan.planId} の ${REPO} を実行しますか？`)
  const r2 = await $.tool.call({ tool: EXEC, plan_id: plan.planId, paths: [REPO], dry_run: false })
  expect(r2.result).toContain('ジャーナルを確定できなかった')
  expect(r2.result).toContain('元に戻した')
  expect(w2.kinds.get('/w/old/node_modules')).toBe('dir')
})

test('restore: 途中で止まった実行 (pending) も、エントリごとの状態を見て元に戻せる', async ($: any, on: any) => {
  const w = world(on)
  const opId = 'RSM-0123456789-0'
  const root = quarantineRoot(REPO, opId)
  w.kinds.delete('/w/old/node_modules')
  w.kinds.set(root, 'dir')
  w.kinds.set(`${root}/node_modules`, 'dir')
  w.kinds.set('/w/old/target', 'dir') // こちらは動かす前に止まった
  const entries = [
    { name: 'node_modules', from: '/w/old/node_modules', to: `${root}/node_modules` },
    { name: 'target', from: '/w/old/target', to: `${root}/target` },
  ]
  w.text[`${root}/journal.json`] = JSON.stringify({ schema: 'repo-preservation-journal-1', opId, planId: 'RSM-0123456789', operation: 'cache-only', repo: REPO, status: 'pending', entries, createdAt: '' })
  const r = await $.tool.call({ tool: RESTORE, repo: REPO, op_id: opId })
  expect(r.result).toContain('OK')
  expect(w.kinds.get('/w/old/node_modules')).toBe('dir')
  expect(w.kinds.get('/w/old/target')).toBe('dir')
  expect((await $.tool.call({ tool: PURGE, repo: REPO, op_id: opId, dry_run: false })).deny).toBeDefined()
})
