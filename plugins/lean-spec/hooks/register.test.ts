import { test, expect, mock } from 'claude-code/testing'
import {
  applyMutation, changedStatements, classifyMutation, escapeHatches, judge, parseAxioms, parseDiagnostics, parseManifest,
  formatJson, parseToolchain, readConfig, wantsPlaybook, type Spec,
} from './policy'
import { REAL } from './fixtures'

const CHECK = 'mcp__lean-spec__lean_spec_check'
const MUTATION = 'mcp__lean-spec__lean_spec_mutation'
const STATUS = 'mcp__lean-spec__lean_spec_status'
const SYNC = 'mcp__lean-spec__lean_spec_sync'
const INIT = 'mcp__lean-spec__lean_spec_init'

const SPEC: Spec = {
  id: 'withdraw',
  feature: '口座からの引き出し',
  property: '残高不足の引き出しは拒否されるので、どの金額でも残高は負にならない',
  module: 'Spec.Account',
  theorems: ['Spec.Account.withdraw_nonneg', 'Spec.Account.withdraw_succeeds'],
  covers: ['src/account.ts'],
}

// ---------- policy ----------

test('マニフェスト: 正しい形は読め、欠けや危ないパスは理由付きで拒否する', () => {
  const ok = parseManifest(JSON.stringify({ project: './verification/lean/', specs: [SPEC] }))
  expect(ok.manifest?.project).toBe('verification/lean')
  expect(ok.manifest?.specs[0]!.theorems).toHaveLength(2)
  expect(parseManifest('{').error).toContain('JSON')
  expect(parseManifest(JSON.stringify({ project: '../x', specs: [] })).error).toContain('project')
  expect(parseManifest(JSON.stringify({ project: 'v', specs: [{ ...SPEC, theorems: [] }] })).error).toContain('theorems')
  expect(parseManifest(JSON.stringify({ project: 'v', specs: [{ ...SPEC, covers: ['/etc/passwd'] }] })).error).toContain('covers')
  expect(parseManifest(JSON.stringify({ project: 'v', specs: [SPEC, SPEC] })).error).toContain('重複')
  expect(parseManifest(JSON.stringify({ project: 'v', specs: [{ ...SPEC, syncCommit: 'HEAD' }] })).error).toContain('syncCommit')
})

test('診断: lake と lean の両方の書式を読み、続く行を本文に含める', () => {
  const out = [
    '✖ [2/3] Building Spec.Account',
    'error: ./././Spec/Account.lean:12:2: unsolved goals',
    'b a : Nat',
    '⊢ False',
    'warning: ./Spec/Other.lean:3:8: declaration uses \'sorry\'',
    'Spec/X.lean:1:0: error: unknown identifier \'foo\'',
  ].join('\n')
  const d = parseDiagnostics(out)
  expect(d).toHaveLength(3)
  expect(d[0]).toEqual({ severity: 'error', file: 'Spec/Account.lean', line: 12, col: 2, message: 'unsolved goals\nb a : Nat\n⊢ False' })
  expect(d[1]!.severity).toBe('warning')
  expect(d[2]!.file).toBe('Spec/X.lean')
})

test('公理: #print axioms の出力から定理ごとの依存公理を読む', () => {
  const out = "'A.t1' depends on axioms: [propext, sorryAx]\n'A.t2' does not depend on any axioms\nerror: unknown constant 'A.t3'"
  expect(parseAxioms(out, ['A.t1', 'A.t2', 'A.t3'])).toEqual([
    { theorem: 'A.t1', found: true, axioms: ['propext', 'sorryAx'] },
    { theorem: 'A.t2', found: true, axioms: [] },
    { theorem: 'A.t3', found: false, axioms: [] },
  ])
})

test('判定: sorry・標準外の公理・見つからない定理・ビルド失敗は証明済みにしない', () => {
  const allowed = ['propext', 'Classical.choice', 'Quot.sound']
  const ok = { exitCode: 0, output: '' }
  expect(judge(ok, [{ theorem: 't', found: true, axioms: ['propext'] }], allowed).verdict).toBe('proven')
  expect(judge(ok, [{ theorem: 't', found: true, axioms: ['sorryAx'] }], allowed).verdict).toBe('sorry')
  expect(judge({ exitCode: 0, output: "warning: ./A.lean:1:0: declaration uses 'sorry'" }, [{ theorem: 't', found: true, axioms: [] }], allowed).verdict).toBe('sorry')
  expect(judge(ok, [{ theorem: 't', found: true, axioms: ['Lean.ofReduceBool'] }], allowed).verdict).toBe('axiom')
  expect(judge(ok, [{ theorem: 't', found: false, axioms: [] }], allowed).verdict).toBe('missing')
  expect(judge({ exitCode: 1, output: 'error: ./A.lean:1:0: unsolved goals' }, null, allowed).verdict).toBe('error')
})

test('抜け道の検出: コメント内は無視し、sorry・axiom・native_decide を拾う', () => {
  expect(escapeHatches('-- sorry はまだない\n/- axiom foo : False -/\ntheorem t : 1 = 1 := rfl')).toEqual([])
  expect(escapeHatches('theorem t : P := by sorry')).toEqual(['sorry'])
  expect(escapeHatches('axiom cheat : False\ntheorem t : 2 + 2 = 4 := by native_decide')).toEqual(['axiom 宣言', 'native_decide'])
})

test('定理の主張の変更を、証明の変更と区別して検出する', () => {
  const before = 'theorem withdraw_nonneg (b a : Nat) (h : a ≤ b) : 0 ≤ withdraw b a := by\n  omega'
  const proofOnly = 'theorem withdraw_nonneg (b a : Nat) (h : a ≤ b) : 0 ≤ withdraw b a := by\n  simp [withdraw]'
  const weaker = 'theorem withdraw_nonneg (b a : Nat) (h : a ≤ b) (h2 : a = 0) : 0 ≤ withdraw b a := by\n  omega'
  expect(changedStatements([SPEC], before, proofOnly)).toEqual([])
  expect(changedStatements([SPEC], before, weaker)).toEqual(['Spec.Account.withdraw_nonneg'])
  expect(changedStatements([SPEC], before, '')).toEqual(['Spec.Account.withdraw_nonneg'])
})

test('壊し方: 一意な置き換えだけを受け付け、構文エラーは試せていないとみなす', () => {
  expect(applyMutation('a b a', 'a', 'c').error).toContain('2 回以上')
  expect(applyMutation('a b', 'x', 'c').error).toContain('見つからない')
  expect(applyMutation('a b', 'b', 'b').error).toContain('同じ')
  expect(applyMutation('a b', 'b', 'c').text).toBe('a c')
  const range = { from: 3, to: 3 }
  expect(classifyMutation('proven', [], 'v/Spec/A.lean', range)).toBe('missed')
  expect(classifyMutation('error', [{ severity: 'error', file: 'Spec/A.lean', line: 3, col: 0, message: 'unexpected token' }], 'v/Spec/A.lean', range)).toBe('invalid')
  expect(classifyMutation('error', [{ severity: 'error', file: 'Spec/A.lean', line: 9, col: 0, message: 'unsolved goals' }], 'v/Spec/A.lean', range)).toBe('caught')
  expect(classifyMutation('error', [{ severity: 'error', file: 'Spec/A.lean', line: 3, col: 0, message: 'failed to synthesize\n  OfNat (Option Nat) 0' }], 'v/Spec/A.lean', range)).toBe('invalid')
  expect(classifyMutation('error', [], 'v/Spec/A.lean', range)).toBe('inconclusive')
  expect(classifyMutation('missing', [], 'v/Spec/A.lean', range)).toBe('inconclusive')
})

test('実際の Lean 4.36 の出力: 証明済み・反例・sorry・構文エラーを正しく分ける', () => {
  const allowed = ['propext', 'Classical.choice', 'Quot.sound']
  const theorems = ['Spec.Account.withdraw_exact', 'Spec.Account.withdraw_succeeds']
  const axioms = parseAxioms(REAL.axioms, [...theorems, 'Spec.Account.nope'])
  expect(axioms.map(a => [a.found, a.axioms.join()])).toEqual([[true, 'propext,Quot.sound'], [true, 'propext'], [false, '']])
  expect(parseDiagnostics(REAL.axioms)[0]).toMatchObject({ severity: 'error', file: '<stdin>', line: 4, col: 14 })
  expect(judge({ exitCode: 0, output: REAL.buildOk }, axioms.slice(0, 2), allowed).verdict).toBe('proven')

  // 残高チェックを外した: omega が反例を示し、壊した行 (5 行目) の外で落ちる
  const mutated = judge({ exitCode: 1, output: REAL.mutated }, null, allowed)
  expect(mutated.verdict).toBe('error')
  expect(mutated.errors[0]).toMatchObject({ file: 'Spec/Account.lean', line: 12 })
  expect(mutated.errors[0]!.message).toContain('a possible counterexample')
  expect(classifyMutation('error', mutated.errors, 'verification/lean/Spec/Account.lean', { from: 5, to: 5 })).toBe('caught')

  // sorry は exit 0 でも未完。警告はバッククォートで囲まれる
  expect(judge({ exitCode: 0, output: REAL.sorry }, axioms.slice(0, 2), allowed).sorries[0]).toMatchObject({ line: 16 })
  expect(judge({ exitCode: 0, output: REAL.sorry }, axioms.slice(0, 2), allowed).verdict).toBe('sorry')

  // 構文エラーは後ろの定理にも連鎖するが、試せていないとみなす
  const syntax = judge({ exitCode: 1, output: REAL.syntax }, null, allowed)
  expect(syntax.errors.map(d => d.line)).toEqual([5, 16])
  expect(classifyMutation('error', syntax.errors, 'verification/lean/Spec/Account.lean', { from: 5, to: 5 })).toBe('invalid')

  // native_decide は 4.36 では定理ごとの補助公理になる
  expect(judge({ exitCode: 0, output: '' }, parseAxioms("'nd' depends on axioms: [nd._native.native_decide.ax_1_1]", ['nd']), allowed).verdict).toBe('axiom')
})

test('マニフェストの整形: 文字列の配列は 1 行に収め、手書きの形を保つ', () => {
  const text = '{\n  "project": "v",\n  "specs": [\n    {\n      "id": "a",\n      "theorems": ["A.x", "A.y"],\n      "covers": []\n    }\n  ]\n}'
  expect(formatJson(JSON.parse(text))).toBe(text)
})

test('起動の判定・設定・版の読み取り', () => {
  expect(wantsPlaybook('この関数を Lean で形式検証して')).toBe(true)
  expect(wantsPlaybook('残高が負にならないことを証明して')).toBe(true)
  expect(wantsPlaybook('prove that the parser never loops')).toBe(true)
  expect(wantsPlaybook('README を直して')).toBe(false)
  expect(wantsPlaybook('/lean-spec')).toBe(false)
  expect(readConfig({}).allowedAxioms).toEqual(['propext', 'Classical.choice', 'Quot.sound'])
  expect(readConfig({ timeoutSec: 1 }).timeoutMs).toBe(10_000)
  expect(parseToolchain('Lean (version 4.15.0, arm64-apple-darwin, commit abc, Release)')).toBe('leanprover/lean4:v4.15.0')
})

// ---------- フック ----------

const ROOT = '/proj'
const LEAN = `${ROOT}/verification/lean/Spec/Account.lean`
const GOOD_MODEL = 'def withdraw (b a : Nat) : Option Nat :=\n  if a ≤ b then some (b - a) else none\n'

type World = {
  files: Record<string, string>
  head: string
  status: string
  changed: string
  axiomOut: string
  toasts: string[]
  runs: string[][]
}

const setup = (on: any, over: Partial<World> = {}): World => {
  const w: World = {
    files: {
      [`${ROOT}/.claude/lean-spec.json`]: JSON.stringify({ project: 'verification/lean', specs: [SPEC] }),
      [LEAN]: GOOD_MODEL,
      [`${ROOT}/src/account.ts`]: 'export const withdraw = () => {}\n',
    },
    head: 'aaaaaaa1111111',
    status: '',
    changed: '',
    axiomOut: "'Spec.Account.withdraw_nonneg' depends on axioms: [propext]\n'Spec.Account.withdraw_succeeds' does not depend on any axioms",
    toasts: [],
    runs: [],
    ...over,
  }
  const kv = new Map<string, unknown>()
  mock.clock(on)
  on('session.root', () => ({ value: ROOT }))
  on('env.get', () => ({ value: '/home/u' }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: kv.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    kv.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in w.files }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (!(e.path in w.files)) throw new Error('ENOENT')
    return { value: w.files[e.path] }
  })
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$: unknown, e: { text?: string }) => {
    w.toasts.push(e.text ?? '')
    return { value: undefined }
  })
  on('process.run', (_$: unknown, e: { argv: readonly string[]; stdin?: string }) => {
    w.runs.push([...e.argv])
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    const [cmd, sub] = e.argv
    if (cmd === 'git') {
      if (sub === 'rev-parse') return ok(`${w.head}\n`)
      if (sub === 'status') return ok(w.status)
      if (sub === 'diff') return e.argv.includes('--name-only') ? ok(w.changed) : ok(w.status === '' ? '' : `diff ${w.status}`)
      if (sub === 'ls-files' && e.argv.includes('-co')) {
        const dir = `${ROOT}/${e.argv[e.argv.length - 1]}/`
        return ok(Object.keys(w.files).filter(p => p.startsWith(dir)).map(p => p.slice(ROOT.length + 1)).join('\n'))
      }
      return ok('')
    }
    if (cmd === 'lake') {
      if (sub === '--version') return ok('Lake version 5.0.0')
      if (sub === 'env' && e.argv[3] === '--version') return ok('Lean (version 4.15.0, arm64-apple-darwin, commit abc, Release)')
      if (sub === 'env') return ok(w.axiomOut)
      if (sub === 'build') {
        const model = w.files[LEAN] ?? ''
        if (/crash!/.test(model)) return ok('', 137)
        if (/\|>\.map id/.test(model) && /-- strengthened/.test(model)) return ok('error: ./././Spec/Account.lean:9:2: unsolved goals', 1)
        if (/then 0 else/.test(model)) return ok('error: ./././Spec/Account.lean:2:16: failed to synthesize\n  OfNat (Option Nat) 0\nnumerals are polymorphic in Lean', 1)
        if (/if a ≤ b then/.test(model)) return ok('✔ [3/3] Built Spec.Account')
        if (/oops\(/.test(model)) return ok('error: ./././Spec/Account.lean:2:5: unexpected token \'(\'', 1)
        return ok('error: ./././Spec/Account.lean:9:2: unsolved goals\nb a : Nat\n⊢ False', 1)
      }
    }
    return ok('', 127)
  })
  on('tool.call', { tool: 'Edit' }, (_$: unknown, e: { file_path: string; old_string: string; new_string: string }) => {
    w.files[e.file_path] = (w.files[e.file_path] ?? '').replace(e.old_string, e.new_string)
    return { result: { filePath: e.file_path } }
  })
  on('tool.call', { tool: 'Write' }, (_$: unknown, e: { file_path: string; content: string }) => {
    w.files[e.file_path] = e.content
    return { result: { filePath: e.file_path } }
  })
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context }))
  return w
}

const call = ($: any, tool: string, input: object = {}) => $.tool.call({ tool, ...input })
const mutate = ($: any, find: string, replace: string, description = '残高不足のチェックを外す') =>
  call($, MUTATION, { id: 'withdraw', file: 'Spec/Account.lean', find, replace, description })

test('検査: 証明済みならビルドと #print axioms の両方を通したことを記録する', async ($: any, on: any) => {
  const w = setup(on)
  const r = (await call($, CHECK)).result as string
  expect(r).toContain('withdraw: 証明済み')
  expect(r).toContain('Spec.Account.withdraw_nonneg: 公理 [propext]')
  expect(w.runs.some(a => a.join(' ') === 'lake build Spec.Account')).toBe(true)
  expect(w.runs.some(a => a.join(' ') === 'lake env lean --stdin')).toBe(true)
  expect((await call($, STATUS)).result).toContain('| withdraw |')
})

test('検査: sorry と標準外の公理は証明済みにしない', async ($: any, on: any) => {
  const w = setup(on, { axiomOut: "'Spec.Account.withdraw_nonneg' depends on axioms: [sorryAx]\n'Spec.Account.withdraw_succeeds' does not depend on any axioms" })
  expect((await call($, CHECK)).result).toContain('未完 (sorry が残っている)')
  w.axiomOut = "'Spec.Account.withdraw_nonneg' depends on axioms: [Lean.ofReduceBool]\n'Spec.Account.withdraw_succeeds' does not depend on any axioms"
  const r = (await call($, CHECK)).result as string
  expect(r).toContain('標準外: Lean.ofReduceBool')
  expect(r).toContain('「証明済み」と報告しない')
})

test('検査: 定理が通らなければ反例を弱めずに報告するよう求める', async ($: any, on: any) => {
  setup(on, { files: { [`${ROOT}/.claude/lean-spec.json`]: JSON.stringify({ project: 'verification/lean', specs: [SPEC] }), [LEAN]: 'def withdraw (b a : Nat) := some (b - a)\n' } })
  const r = (await call($, CHECK)).result as string
  expect(r).toContain('ビルド失敗')
  expect(r).toContain('Spec/Account.lean:9:2: unsolved goals')
  expect(r).toContain('主張を弱めずに')
})

test('マニフェストがなければ init へ誘導し、init は既存を上書きしない', async ($: any, on: any) => {
  const w = setup(on, { files: {} })
  expect((await call($, CHECK)).deny).toContain('lean_spec_init')
  const r = (await call($, INIT)).result as string
  expect(r).toContain('leanprover/lean4:v4.15.0')
  expect(w.files[`${ROOT}/verification/lean/lakefile.toml`]).toContain('name = "Spec"')
  expect(w.files[`${ROOT}/verification/lean/lean-toolchain`]).toBe('leanprover/lean4:v4.15.0\n')
  expect(JSON.parse(w.files[`${ROOT}/.claude/lean-spec.json`]!)).toEqual({ project: 'verification/lean', specs: [] })
  w.files[`${ROOT}/verification/lean/lakefile.toml`] = 'custom'
  expect((await call($, INIT)).result).toContain('既存のため触らず')
  expect(w.files[`${ROOT}/verification/lean/lakefile.toml`]).toBe('custom')
})

test('壊した実装: 検出したら記録し、ファイルを必ず元に戻す', async ($: any, on: any) => {
  const w = setup(on)
  expect((await mutate($, 'if a ≤ b then', 'if true then')).deny).toContain('先に lean_spec_check')
  await call($, CHECK)
  const r = (await mutate($, 'if a ≤ b then', 'if true then')).result as string
  expect(r).toContain('検出した')
  expect(r).toContain('unsolved goals')
  expect(w.files[LEAN]).toBe(GOOD_MODEL)
  expect((await call($, STATUS)).result).toContain('検出 1')
})

test('壊した実装: 構文エラーは記録せず、証明の抜け道は拒否する', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  expect((await mutate($, 'if a ≤ b then', 'if oops( then')).result).toContain('記録しない')
  expect(w.files[LEAN]).toBe(GOOD_MODEL)
  expect((await mutate($, 'if a ≤ b then', 'sorry')).deny).toContain('sorry')
  expect((await call($, MUTATION, { id: 'withdraw', file: '../../etc/x.lean', find: 'a', replace: 'b', description: 'x' })).deny).toContain('.lean')
  expect((await call($, STATUS)).result).toContain('未確認')
})

test('壊した実装: 検出できなければ性質が弱いと伝え、同期させない', async ($: any, on: any) => {
  setup(on)
  await call($, CHECK)
  // 置き換え後も「if a ≤ b then」が残るので、モックでは証明が通る
  const r = (await mutate($, 'some (b - a)', 'some (b - a) |>.map id', '結果を恒等写像に通す')).result as string
  expect(r).toContain('検出できなかった')
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('検出できなかった壊し方')
})

test('同期: 証明済み・検出済み・未コミットなしのときだけ syncCommit を進め、以後の変更を知らせる', async ($: any, on: any) => {
  const w = setup(on)
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('lean_spec_check')
  await call($, CHECK)
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('lean_spec_mutation')
  await mutate($, 'if a ≤ b then', 'if true then')
  w.status = ' M src/account.ts'
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('未コミット')
  w.status = ''
  expect((await call($, SYNC, { id: 'withdraw' })).result).toContain('aaaaaaa11111')
  expect(JSON.parse(w.files[`${ROOT}/.claude/lean-spec.json`]!).specs[0].syncCommit).toBe('aaaaaaa1111111')
  expect(w.files[`${ROOT}/.claude/lean-spec.json`]).toContain('"covers": ["src/account.ts"],\n      "syncCommit": "aaaaaaa1111111"')
  const synced = (await call($, STATUS)).result as string
  expect(synced).toContain('同期済み')
  expect(synced).toContain('| ○ |')

  w.changed = 'src/account.ts\n'
  w.status = ' M src/account.ts'
  const stale = (await call($, STATUS)).result as string
  expect(stale).toContain('検査後に変更あり')
  expect(stale).toContain('syncCommit aaaaaaa1 以降に変わった対象: src/account.ts')
  expect(stale).toContain('| × |')
})

test('編集の見張り: 対象コード・sorry・定理の主張の変更に注意を付け、未検査ならターン終わりに知らせる', async ($: any, on: any) => {
  const w = setup(on)
  w.files[LEAN] = `${GOOD_MODEL}theorem withdraw_nonneg (b a : Nat) : ∀ r, withdraw b a = some r → 0 ≤ r := by\n  omega\n`
  const code = await call($, 'Edit', { file_path: `${ROOT}/src/account.ts`, old_string: '{}', new_string: '{ return 1 }' })
  expect(code.context?.join()).toContain('withdraw: 残高不足の引き出しは拒否')

  const weaken = await call($, 'Edit', { file_path: LEAN, old_string: ': ∀ r,', new_string: '(h : a = 0) : ∀ r,' })
  expect(weaken.context?.join()).toContain('主張を変えた')

  const sorry = await call($, 'Edit', { file_path: LEAN, old_string: '  omega', new_string: '  sorry' })
  expect(sorry.context?.join()).toContain('sorry がある')

  const other = await call($, 'Write', { file_path: `${ROOT}/README.md`, content: 'x' })
  expect(other.context).toBeUndefined()

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(w.toasts.join()).toContain('未検査の仕様がある (withdraw)')
  w.toasts.length = 0
  await call($, CHECK)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(w.toasts).toEqual([])
})

test('形式検証の依頼に手順書を付け、能力の性質を求める', async ($: any, on: any) => {
  setup(on)
  const hit = await $.prompt.submit({ text: '引き出し処理を Lean で形式検証して' })
  const text = hit.context?.join() ?? ''
  expect(text).toContain('<lean-spec-playbook>')
  expect(text).toContain('能力の性質を必ず 1 つ以上')
  expect(text).toContain('lean_spec_mutation')
  expect((await $.prompt.submit({ text: 'テストを実行して' })).context).toBeUndefined()
})

test('/lean-spec で状態を一覧する', async ($: any, on: any) => {
  setup(on)
  const r = await $.command.run({ command: 'lean-spec', args: '' })
  expect(r.text).toContain('| withdraw |')
  expect(r.text).toContain('未検査')
})

test('レビュー対応: 検査後にマニフェストの定理を差し替えると、証明済みのまま同期できない', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  await mutate($, 'if a ≤ b then', 'if true then')
  const path = `${ROOT}/.claude/lean-spec.json`
  w.files[path] = JSON.stringify({ project: 'verification/lean', specs: [{ ...SPEC, theorems: ['Spec.Account.does_not_exist'] }] })
  const status = (await call($, STATUS)).result as string
  expect(status).toContain('検査後に変更あり')
  expect(status).toContain('| 未確認 |')
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('lean_spec_check')
})

test('レビュー対応: 検出漏れのあと定理を直して同じ壊し方で検出できれば、同期できる', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  expect((await mutate($, 'some (b - a)', 'some (b - a) |>.map id', '結果を恒等写像に通す')).result).toContain('検出できなかった')
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('検出できなかった壊し方')
  w.files[LEAN] = `${GOOD_MODEL}-- strengthened\n`
  await call($, CHECK)
  expect((await mutate($, 'some (b - a)', 'some (b - a) |>.map id', '結果を恒等写像に通す')).result).toContain('検出した')
  const status = (await call($, STATUS)).result as string
  expect(status).toContain('検出 1')
  expect(status).not.toContain('検出漏れ')
  expect((await call($, SYNC, { id: 'withdraw' })).result).toContain('syncCommit')
})

test('レビュー対応: 診断のないビルド失敗 (タイムアウト・起動失敗) は検出として数えない', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  const r = (await mutate($, 'if a ≤ b then', 'if crash! then')).result as string
  expect(r).toContain('判定できなかった')
  expect(w.files[LEAN]).toBe(GOOD_MODEL)
  expect((await call($, STATUS)).result).toContain('| 未確認 |')
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('lean_spec_mutation')
})

test('レビュー対応: 検出したあとに Lean のソースを変えると、以前の検出は証拠に数えない', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  expect((await mutate($, 'if a ≤ b then', 'if true then')).result).toContain('検出した')
  expect((await call($, STATUS)).result).toContain('検出 1')
  // 名前を変えずに定理やモデルを書き換え、検査し直しても、壊した実装の検出はやり直しになる
  w.files[LEAN] = `${GOOD_MODEL}-- weakened\n`
  await call($, CHECK)
  const status = (await call($, STATUS)).result as string
  expect(status).toContain('証明済み')
  expect(status).toContain('| 未確認 |')
  expect((await call($, SYNC, { id: 'withdraw' })).deny).toContain('lean_spec_mutation')
  expect((await mutate($, 'if a ≤ b then', 'if true then')).result).toContain('検出した')
  expect((await call($, SYNC, { id: 'withdraw' })).result).toContain('syncCommit')
})

test('レビュー対応: 置き換えた行の型エラー (インスタンス合成の失敗) は検出として数えない', async ($: any, on: any) => {
  const w = setup(on)
  await call($, CHECK)
  const r = (await mutate($, 'some (b - a)', '0', '成功時に 0 を返す')).result as string
  expect(r).toContain('記録しない')
  expect(r).toContain('failed to synthesize')
  expect(w.files[LEAN]).toBe(GOOD_MODEL)
  expect((await call($, STATUS)).result).toContain('| 未確認 |')
})
