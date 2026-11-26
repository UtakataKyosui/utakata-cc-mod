import type { Register } from 'claude-code'
import {
  type Check, type Config, type Manifest, type Records, type Spec, type Status,
  INIT_FILES, INSTALL_HINT,
  applyMutation, axiomsProgram, changedStatements, cheatsInMutation, classifyMutation, coverNote, coveringSpecs, escapeHatches,
  formatCheck, formatJson, formatStatus, guidance, hatchNote, isProjectLean, judge, mutatedLines, parseAxioms, parseManifest,
  parseToolchain, playbook, readConfig, relativeTo, serializeManifest, statusOf, theoremNote, wantsPlaybook,
} from './policy'

const INIT = 'mcp__lean-spec__lean_spec_init'
const CHECK = 'mcp__lean-spec__lean_spec_check'
const MUTATION = 'mcp__lean-spec__lean_spec_mutation'
const STATUS = 'mcp__lean-spec__lean_spec_status'
const SYNC = 'mcp__lean-spec__lean_spec_sync'
const GIT_TIMEOUT_MS = 30_000

type Run = { exitCode: number; stdout: string; stderr: string }

const run = async ($: any, argv: string[], init: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<Run | null> => {
  try {
    return (await $.process.run(argv, { stdin: '', ...init })) as Run
  } catch {
    return null
  }
}

const git = async ($: any, root: string, args: string[]): Promise<string | null> => {
  const r = await run($, ['git', ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
  return r !== null && r.exitCode === 0 ? r.stdout : null
}

const fnv1a = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 仕様に関わるファイル (Lean プロジェクトと対象コード) の変更状態。git で取れなければ null。 */
async function fingerprint($: any, root: string, m: Manifest, spec: Spec): Promise<string | null> {
  const paths = ['--', m.project, ...spec.covers]
  const head = await git($, root, ['rev-parse', 'HEAD'])
  const status = await git($, root, ['status', '--porcelain=v1', '-uall', ...paths])
  const diff = await git($, root, ['diff', 'HEAD', ...paths])
  if (head === null || status === null || diff === null) return null
  const untracked = status.split('\n').filter(l => l.startsWith('?? ')).map(l => l.slice(3))
  const bodies = await Promise.all(untracked.slice(0, 200).map(p => $.fs.read(`${root}/${p}`).catch(() => '')))
  return fnv1a([head, status, diff, ...bodies].join('\u0000'))
}

/** syncCommit 以降に変わった対象コード (作業ツリーを含む)。比べられなければ null。 */
async function changedSince($: any, root: string, spec: Spec): Promise<string[] | null> {
  if (spec.syncCommit === undefined) return []
  const diff = await git($, root, ['diff', '--name-only', spec.syncCommit, '--', ...spec.covers])
  const untracked = await git($, root, ['ls-files', '-o', '--exclude-standard', '--', ...spec.covers])
  if (diff === null || untracked === null) return null
  return [...new Set([...diff.split('\n'), ...untracked.split('\n')].map(s => s.trim()).filter(s => s !== ''))]
}

async function rootOf($: any): Promise<string> {
  return String(await $.session.root()).replace(/\/+$/, '')
}

type Loaded = { manifest?: Manifest; error?: string; missing?: boolean }

async function loadManifest($: any, cfg: Config, root: string): Promise<Loaded> {
  const path = `${root}/${cfg.manifestPath}`
  if (!(await $.fs.exists(path).catch(() => false))) return { missing: true }
  const text = await $.fs.read(path).catch(() => null)
  if (text === null) return { error: `${cfg.manifestPath} を読めない` }
  const r = parseManifest(String(text))
  return r.error !== undefined ? { error: `${cfg.manifestPath}: ${r.error}` } : r
}

async function needManifest($: any, cfg: Config, root: string): Promise<Manifest | { deny: string }> {
  const r = await loadManifest($, cfg, root)
  if (r.missing) return { deny: `${cfg.manifestPath} がない。lean_spec_init で Lean プロジェクトとマニフェストを作ること` }
  if (r.error !== undefined) return { deny: r.error }
  return r.manifest!
}

async function records($: any, root: string): Promise<Records> {
  return ((await $.store.get(`records:${root}`)) as Records | undefined) ?? {}
}

async function saveRecords($: any, root: string, r: Records): Promise<void> {
  await $.store.set(`records:${root}`, r)
}

const lakeCache: { bin?: string } = {}

/** lake の実体。PATH になければ elan の既定の場所を探す。 */
async function findLake($: any, cfg: Config): Promise<string | null> {
  if (lakeCache.bin !== undefined) return lakeCache.bin
  const home = await Promise.resolve($.env.get('HOME')).catch(() => undefined)
  for (const cand of [cfg.lakeCommand, ...(home ? [`${home}/.elan/bin/lake`] : [])]) {
    const r = await run($, [cand, '--version'], { timeoutMs: 60_000 })
    if (r !== null && r.exitCode === 0) return (lakeCache.bin = cand)
  }
  return null
}

/** モジュールをビルドし、各定理の依存公理を調べる。 */
async function checkSpec($: any, cfg: Config, root: string, m: Manifest, spec: Spec, lakeBin: string): Promise<Omit<Check, 'at' | 'fingerprint'>> {
  const cwd = `${root}/${m.project}`
  const build = await run($, [lakeBin, 'build', spec.module], { cwd, timeoutMs: cfg.timeoutMs })
  if (build === null) return judge({ exitCode: 1, output: '' }, null, cfg.allowedAxioms)
  const buildOut = { exitCode: build.exitCode, output: `${build.stdout}\n${build.stderr}` }
  if (build.exitCode !== 0) return judge(buildOut, null, cfg.allowedAxioms)
  const ax = await run($, [lakeBin, 'env', 'lean', '--stdin'], { cwd, stdin: axiomsProgram(spec.module, spec.theorems), timeoutMs: cfg.timeoutMs })
  const axioms = ax === null ? null : parseAxioms(`${ax.stdout}\n${ax.stderr}`, spec.theorems)
  return judge(buildOut, axioms, cfg.allowedAxioms)
}

async function statusText($: any, cfg: Config): Promise<string> {
  const root = await rootOf($)
  const r = await loadManifest($, cfg, root)
  if (r.missing) return `lean-spec: ${cfg.manifestPath} がない。仕様はまだ登録されていない。`
  if (r.error !== undefined) return `lean-spec: ${r.error}`
  const m = r.manifest!
  const recs = await records($, root)
  const list: Status[] = []
  for (const s of m.specs) list.push(statusOf(s, recs[s.id], await fingerprint($, root, m, s), await changedSince($, root, s)))
  return formatStatus(list, cfg.requireMutation)
}

const pick = (m: Manifest, id: unknown): Spec[] | string => {
  if (typeof id !== 'string' || id === '') return m.specs
  const hit = m.specs.filter(s => s.id === id)
  return hit.length ? hit : `仕様 ${id} がマニフェストにない`
}

export const register: Register = (on, options) => {
  const cfg: Config = readConfig(options)
  /** 対象を編集したあと、まだ検査していない仕様 */
  const touched = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'lean_spec_init',
      description: 'Lean 4 の lake プロジェクト (lakefile.toml・lean-toolchain・ルートモジュール) と、仕様を記録するマニフェストを作る。既にあるファイルは上書きしない。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Lean プロジェクトのディレクトリ (リポジトリ相対)。既定 verification/lean' },
          lib: { type: 'string', description: 'ライブラリ名 (ルートモジュール名)。既定 Spec' },
        },
      },
    })
    await $.tool.register({
      name: 'lean_spec_check',
      description: '仕様の Lean モジュールを lake build し、各定理が sorry なし・許可した公理だけで証明されているかを #print axioms で確かめて記録する。id を省くと全仕様。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '仕様の id。省略時は全件' } } },
    })
    await $.tool.register({
      name: 'lean_spec_mutation',
      description:
        'Lean のモデル (def) を一時的に壊して検査し、定理がその壊れ方を検出できるか (証明が通らなくなるか) を記録する。終わったら必ず元に戻す。定理ではなくモデルを、「チェックを外す」「境界を 1 ずらす」など現実にありそうな形で壊すこと。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '仕様の id' },
          file: { type: 'string', description: '壊す Lean ファイル (Lean プロジェクト内)' },
          find: { type: 'string', description: '置き換える元の文字列。ファイル内で一意であること' },
          replace: { type: 'string', description: '壊したあとの文字列' },
          description: { type: 'string', description: 'どう壊したかを実装の言葉で 1 文 (例: 残高不足のチェックを外す)' },
        },
        required: ['id', 'file', 'find', 'replace', 'description'],
      },
    })
    await $.tool.register({
      name: 'lean_spec_status',
      description: '仕様ごとに、証明の状態・壊した実装の検出・対象コードとの同期 (syncCommit 以降の変更) を一覧する。完了を報告する前に確認する。',
      inputSchema: { type: 'object' },
    })
    await $.tool.register({
      name: 'lean_spec_sync',
      description: 'モデルが今のコードを表していると確かめたあとに、仕様の syncCommit を HEAD に進める。今の状態で証明済みで、対象コードに未コミットの変更がないときだけ進められる。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '仕様の id' } }, required: ['id'] },
    })
    await $.command.register({ name: 'lean-spec', description: 'Lean で証明した仕様の状態を一覧する' })
    return next(e)
  })

  on('tool.call', { tool: INIT }, async ($, e) => {
    const input = e as unknown as { project?: string; lib?: string }
    const root = await rootOf($)
    const project = (typeof input.project === 'string' && input.project.trim() !== '' ? input.project.trim() : 'verification/lean').replace(/^\.\//, '').replace(/\/+$/, '')
    if (relativeTo(root, project) === null || project.startsWith('/')) return { deny: 'project はリポジトリ内の相対パスで渡すこと' }
    const lib = typeof input.lib === 'string' && /^[A-Z][A-Za-z0-9_]*$/.test(input.lib) ? input.lib : 'Spec'
    const lakeBin = await findLake($, cfg)
    if (lakeBin === null) return { deny: INSTALL_HINT }
    const ver = await run($, [lakeBin, 'env', 'lean', '--version'], { timeoutMs: 60_000 })
    const toolchain = ver === null ? null : parseToolchain(ver.stdout)
    if (toolchain === null) return { deny: `lean --version から版を読めない: ${ver?.stdout ?? ''}${ver?.stderr ?? ''}` }

    const wrote: string[] = []
    const kept: string[] = []
    for (const [rel, text] of Object.entries(INIT_FILES(project, lib, toolchain))) {
      if (await $.fs.exists(`${root}/${rel}`)) kept.push(rel)
      else {
        await $.fs.write(`${root}/${rel}`, text)
        wrote.push(rel)
      }
    }
    const existing = await loadManifest($, cfg, root)
    if (existing.missing) {
      await $.fs.write(`${root}/${cfg.manifestPath}`, serializeManifest({ project, specs: [] }))
      wrote.push(cfg.manifestPath)
    } else kept.push(cfg.manifestPath)
    return {
      result: [
        `Lean プロジェクト ${project} (${toolchain}、ライブラリ ${lib}) を用意した。`,
        wrote.length ? `作成: ${wrote.join(', ')}` : '',
        kept.length ? `既存のため触らず: ${kept.join(', ')}` : '',
        `仕様は ${project}/${lib}/<名前>.lean に書き、${project}/${lib}.lean から import する。モジュール名は ${lib}.<名前>。マニフェストの specs に仕様を足してから lean_spec_check を実行する。`,
      ].filter(Boolean).join('\n'),
    }
  })

  on('tool.call', { tool: CHECK }, async ($, e) => {
    const root = await rootOf($)
    const m = await needManifest($, cfg, root)
    if ('deny' in m) return m
    const targets = pick(m, (e as unknown as { id?: string }).id)
    if (typeof targets === 'string') return { deny: targets }
    if (targets.length === 0) return { deny: `${cfg.manifestPath} の specs が空。仕様を足してから検査すること` }
    const lakeBin = await findLake($, cfg)
    if (lakeBin === null) return { deny: INSTALL_HINT }

    const recs = await records($, root)
    const out: string[] = []
    for (const spec of targets) {
      const result = await checkSpec($, cfg, root, m, spec, lakeBin)
      const check: Check = { ...result, at: new Date(await $.clock.now()).toISOString(), fingerprint: await fingerprint($, root, m, spec) }
      recs[spec.id] = { ...(recs[spec.id] ?? { mutations: [] }), check }
      touched.delete(spec.id)
      out.push(formatCheck(spec, check, cfg.allowedAxioms, cfg.outputTailChars))
    }
    await saveRecords($, root, recs)
    return { result: out.join('\n\n') }
  })

  on('tool.call', { tool: MUTATION }, async ($, e) => {
    const input = e as unknown as { id?: string; file?: string; find?: string; replace?: string; description?: string }
    const root = await rootOf($)
    const m = await needManifest($, cfg, root)
    if ('deny' in m) return m
    const spec = m.specs.find(s => s.id === input.id)
    if (spec === undefined) return { deny: `仕様 ${String(input.id)} がマニフェストにない` }
    if (typeof input.find !== 'string' || typeof input.replace !== 'string' || typeof input.file !== 'string') return { deny: 'file・find・replace を文字列で渡すこと' }
    const description = typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : null
    if (description === null) return { deny: 'description にどう壊したかを書くこと' }
    const cheat = cheatsInMutation(input.replace)
    if (cheat !== null) return { deny: cheat }

    let rel = relativeTo(root, input.file)
    if (rel !== null && !isProjectLean(m, rel)) rel = relativeTo(root, `${m.project}/${rel}`)
    if (rel === null || !isProjectLean(m, rel)) return { deny: `file は ${m.project} 内の .lean ファイルを渡すこと` }

    const recs = await records($, root)
    const before = statusOf(spec, recs[spec.id], await fingerprint($, root, m, spec), [])
    if (before.check !== 'proven') return { deny: '壊す前の状態で証明済みになっていない。先に lean_spec_check を通すこと (失敗が壊したせいか元からかを区別できないため)' }

    const lakeBin = await findLake($, cfg)
    if (lakeBin === null) return { deny: INSTALL_HINT }
    const path = `${root}/${rel}`
    const original = String(await $.fs.read(path))
    const mutated = applyMutation(original, input.find, input.replace)
    if (mutated.error !== undefined) return { deny: mutated.error }

    let result: Omit<Check, 'at' | 'fingerprint'>
    try {
      await $.fs.write(path, mutated.text!)
      result = await checkSpec($, cfg, root, m, spec, lakeBin)
    } finally {
      await $.fs.write(path, original)
    }
    if (String(await $.fs.read(path)) !== original) return { deny: `${rel} を元に戻せなかった。git diff で確認して手で戻すこと` }

    const kind = classifyMutation(result.verdict, result.errors, rel, mutatedLines(original, input.find, input.replace))
    if (kind === 'invalid') {
      return {
        result: `壊したモデルが構文・名前のエラーで読めず、性質を試せていない (記録しない)。型が合う形で振る舞いだけを変えること。\n${result.errors.map(d => `${d.file}:${d.line}: ${d.message}`).join('\n')}`,
      }
    }
    const caught = kind === 'caught'
    recs[spec.id] = { ...(recs[spec.id] ?? {}), mutations: [...(recs[spec.id]?.mutations ?? []), { description, file: rel, caught, at: new Date(await $.clock.now()).toISOString() }] }
    await saveRecords($, root, recs)
    if (caught) {
      const why = result.errors.slice(0, 3).map(d => `- ${d.file}:${d.line}: ${d.message.split('\n')[0]}`).join('\n')
      return { result: `検出した: 「${description}」と壊すと、定理が通らなくなった (${result.verdict})。${rel} は元に戻した。\n${why}` }
    }
    return {
      result: `検出できなかった: 「${description}」と壊しても定理 ${spec.theorems.join(', ')} は証明されたまま。性質が弱いか、モデルがこの部分を表していない。定理を強めるかモデルを直してから、同じ壊し方で再確認すること。${rel} は元に戻した。`,
    }
  })

  on('tool.call', { tool: STATUS }, async $ => ({ result: await statusText($, cfg) }))
  on('command.run', { command: 'lean-spec' }, async $ => ({ text: await statusText($, cfg) }))

  on('tool.call', { tool: SYNC }, async ($, e) => {
    const root = await rootOf($)
    const m = await needManifest($, cfg, root)
    if ('deny' in m) return m
    const id = (e as unknown as { id?: string }).id
    const spec = m.specs.find(s => s.id === id)
    if (spec === undefined) return { deny: `仕様 ${String(id)} がマニフェストにない` }
    const dirty = await git($, root, ['status', '--porcelain=v1', '--', ...spec.covers])
    if (dirty === null) return { deny: 'git で対象コードの状態を確かめられない' }
    if (dirty.trim() !== '') return { deny: `対象コードに未コミットの変更がある。コミットしてから同期すること:\n${dirty.trim()}` }
    const recs = await records($, root)
    const s = statusOf(spec, recs[spec.id], await fingerprint($, root, m, spec), [])
    if (s.check !== 'proven') return { deny: '今の状態で証明済みになっていない。lean_spec_check を通してから同期すること' }
    if (s.missed.length > 0) return { deny: '検出できなかった壊し方が記録されている。定理かモデルを直し、同じ壊し方で検出できることを確かめてから同期すること' }
    if (cfg.requireMutation && s.caught === 0) return { deny: '壊した実装を検出できることをまだ確かめていない。lean_spec_mutation を 1 回以上通してから同期すること' }
    const head = (await git($, root, ['rev-parse', 'HEAD']))?.trim()
    if (!head) return { deny: 'HEAD を読めない' }
    const raw = String(await $.fs.read(`${root}/${cfg.manifestPath}`))
    const json = JSON.parse(raw)
    for (const x of json.specs) if (x.id === spec.id) x.syncCommit = head
    await $.fs.write(`${root}/${cfg.manifestPath}`, `${formatJson(json)}\n`)
    return { result: `${spec.id} の syncCommit を ${head.slice(0, 12)} に進めた。マニフェストの変更をコミットすること。` }
  })

  // 対象コード・Lean ファイルの編集を見張る
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return next(e)
    const input = e as unknown as { file_path?: string }
    if (typeof input.file_path !== 'string') return next(e)
    let root: string
    let m: Manifest | undefined
    try {
      root = await rootOf($)
      m = (await loadManifest($, cfg, root)).manifest
    } catch {
      return next(e)
    }
    const rel = m ? relativeTo(root, input.file_path) : null
    if (!m || rel === null) return next(e)
    const covering = coveringSpecs(m, rel)
    const lean = isProjectLean(m, rel)
    if (covering.length === 0 && !lean) return next(e)

    const before = lean ? String(await $.fs.read(input.file_path).catch(() => '')) : ''
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const notes: string[] = []
    if (covering.length > 0) {
      for (const s of covering) touched.add(s.id)
      notes.push(coverNote(covering))
    }
    if (lean) {
      const after = String(await $.fs.read(input.file_path).catch(() => ''))
      for (const s of m.specs) touched.add(s.id)
      const hatches = escapeHatches(after)
      if (hatches.length > 0) notes.push(hatchNote(hatches))
      const changed = changedStatements(m.specs, before, after)
      if (changed.length > 0) notes.push(theoremNote(changed))
    }
    return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  })

  on('turn.complete', async ($, e, next) => {
    if (touched.size > 0) $.ui.toast(`lean-spec: 対象を編集したあと未検査の仕様がある (${[...touched].join(', ')})。lean_spec_check を実行すること`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!cfg.autoPlaybook || !wantsPlaybook(e.text)) return next(e)
    return next({ ...e, context: [...(e.context ?? []), playbook(cfg)] })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    try {
      const root = await rootOf($)
      if (!(await $.fs.exists(`${root}/${cfg.manifestPath}`))) return composed
    } catch {
      return composed
    }
    return { sections: [...composed.sections, { id: 'lean-spec:guidance', text: guidance, scope: 'session' }] }
  })
}
