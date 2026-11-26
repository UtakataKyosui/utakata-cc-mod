export type Config = {
  manifestPath: string
  lakeCommand: string
  timeoutMs: number
  allowedAxioms: string[]
  outputTailChars: number
  requireMutation: boolean
  autoPlaybook: boolean
}

const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def

const str = (v: unknown, def: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : def)

export const DEFAULT_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound']

export const readConfig = (options: Record<string, unknown> | undefined): Config => ({
  manifestPath: str(options?.manifestPath, '.claude/lean-spec.json').replace(/^\.\//, ''),
  lakeCommand: str(options?.lakeCommand, 'lake'),
  timeoutMs: num(options?.timeoutSec, 600, 10, 1800) * 1000,
  allowedAxioms: str(options?.allowedAxioms, DEFAULT_AXIOMS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== ''),
  outputTailChars: num(options?.outputTailChars, 3000, 200, 20000),
  requireMutation: options?.requireMutation !== false,
  autoPlaybook: options?.autoPlaybook !== false,
})

// ---------- マニフェスト ----------

/** 1 つの仕様。「機能が何をできるべきか」を 1 文で書き、それを表す定理と、対応するコードを記録する。 */
export type Spec = {
  id: string
  feature: string
  /** 機能が満たすべき性質を平易な 1 文で */
  property: string
  /** 性質が破れたときの害を 1 文で */
  harm?: string
  /** 証明の前提と範囲。範囲外は保証しない */
  scope?: string
  /** 定理を置く Lean モジュール (例: Spec.Account) */
  module: string
  /** 完全修飾の定理名 */
  theorems: string[]
  /** 検証が表しているコード。パス、または末尾 / のディレクトリ */
  covers: string[]
  /** モデルがコードを正しく表していると最後に確認したコミット */
  syncCommit?: string
}

export type Manifest = { project: string; specs: Spec[] }

const ID = /^[A-Za-z0-9_-]{1,60}$/
const LEAN_NAME = /^[A-Za-z_À-￿][\w'À-￿]*(\.[A-Za-z_À-￿][\w'À-￿]*)*$/
const SHA = /^[0-9a-f]{7,40}$/

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '') ? (v as string[]).map(s => s.trim()) : null

const safeRel = (p: string): boolean => !p.startsWith('/') && !p.split('/').includes('..')

export const parseManifest = (text: string): { manifest?: Manifest; error?: string } => {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `JSON として読めない: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof raw !== 'object' || raw === null) return { error: 'オブジェクトではない' }
  const project = typeof raw.project === 'string' ? raw.project.trim().replace(/^\.\//, '').replace(/\/+$/, '') : ''
  if (project === '' || !safeRel(project)) return { error: 'project には Lean (lake) プロジェクトのディレクトリをリポジトリからの相対パスで書くこと' }
  if (!Array.isArray(raw.specs)) return { error: 'specs が配列ではない' }
  const specs: Spec[] = []
  for (const [i, s] of (raw.specs as any[]).entries()) {
    const at = `specs[${i}]`
    if (typeof s?.id !== 'string' || !ID.test(s.id)) return { error: `${at}.id は英数字・_・- の 60 文字以内` }
    if (specs.some(x => x.id === s.id)) return { error: `id が重複している: ${s.id}` }
    for (const k of ['feature', 'property', 'module'] as const) {
      if (typeof s[k] !== 'string' || s[k].trim() === '') return { error: `${s.id}: ${k} が空` }
    }
    if (!LEAN_NAME.test(s.module.trim())) return { error: `${s.id}: module は Lean のモジュール名 (例: Spec.Account)` }
    const theorems = strings(s.theorems)
    if (theorems === null || theorems.length === 0) return { error: `${s.id}: theorems は 1 件以上の定理名の配列` }
    const bad = theorems.find(t => !LEAN_NAME.test(t))
    if (bad !== undefined) return { error: `${s.id}: 定理名として読めない: ${bad}` }
    const covers = strings(s.covers)
    if (covers === null || covers.length === 0) return { error: `${s.id}: covers は検証が表すコードのパスを 1 件以上` }
    if (!covers.every(safeRel)) return { error: `${s.id}: covers はリポジトリ内の相対パスで書くこと` }
    if (s.syncCommit !== undefined && (typeof s.syncCommit !== 'string' || !SHA.test(s.syncCommit))) {
      return { error: `${s.id}: syncCommit はコミットのハッシュ` }
    }
    const opt = (k: string) => (typeof s[k] === 'string' && s[k].trim() !== '' ? s[k].trim() : undefined)
    specs.push({
      id: s.id,
      feature: s.feature.trim(),
      property: s.property.trim(),
      harm: opt('harm'),
      scope: opt('scope'),
      module: s.module.trim(),
      theorems,
      covers: covers.map(c => c.replace(/^\.\//, '')),
      syncCommit: s.syncCommit,
    })
  }
  return { manifest: { project, specs } }
}

/** JSON を 2 字下げで書く。文字列や数だけの配列は手書きと同じく 1 行に収め、同期の差分を小さくする。 */
export const formatJson = (value: unknown, indent = ''): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(v => v === null || typeof v !== 'object')) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`
    const inner = `${indent}  `
    return `[\n${value.map(v => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return '{}'
    const inner = `${indent}  `
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

export const serializeManifest = (m: Manifest): string => `${formatJson(m)}\n`

/** 変更したファイル (リポジトリ相対) を対象にしている仕様。 */
export const coveringSpecs = (m: Manifest, rel: string): Spec[] =>
  m.specs.filter(s => s.covers.some(c => (c.endsWith('/') ? rel.startsWith(c) : rel === c || rel.startsWith(`${c}/`))))

export const relativeTo = (root: string, path: string): string | null => {
  const base = root.replace(/\/+$/, '')
  if (!path.startsWith('/')) return safeRel(path) ? path.replace(/^\.\//, '') : null
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

/** Lean プロジェクト内の .lean ファイルか。 */
export const isProjectLean = (m: Manifest, rel: string): boolean => rel.startsWith(`${m.project}/`) && rel.endsWith('.lean')

// ---------- Lean の出力の解釈 ----------

export type Diagnostic = { severity: 'error' | 'warning'; file: string; line: number; col: number; message: string }

// lake は "error: Spec/A.lean:3:4: msg"、lean は "Spec/A.lean:3:4: error(lean.code): msg" と出す (コードは版によって付かない)
const LAKE_DIAG = /^(error|warning)(?:\([\w.]+\))?:\s+(?:\.\/)*([^\s:][^:]*\.lean):(\d+):(\d+):\s*(.*)$/
const LEAN_DIAG = /^(?:\.\/)*([^\s:][^:]*\.lean|<stdin>):(\d+):(\d+):\s*(error|warning)(?:\([\w.]+\))?:\s*(.*)$/

export const parseDiagnostics = (output: string): Diagnostic[] => {
  const out: Diagnostic[] = []
  const lines = output.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let d: Diagnostic | undefined
    const a = LAKE_DIAG.exec(line)
    if (a) d = { severity: a[1] as Diagnostic['severity'], file: a[2]!, line: Number(a[3]), col: Number(a[4]), message: a[5]! }
    const b = d ? null : LEAN_DIAG.exec(line)
    if (b) d = { severity: b[4] as Diagnostic['severity'], file: b[1]!, line: Number(b[2]), col: Number(b[3]), message: b[5]! }
    if (!d) continue
    // 続く行 (ゴールの表示など) を、次の診断か空行まで本文に含める
    const more: string[] = []
    while (i + 1 < lines.length && !LAKE_DIAG.test(lines[i + 1]!) && !LEAN_DIAG.test(lines[i + 1]!) && !/^[✖✔⚠]|^\s*$|^(error|warning|info|trace)\b/.test(lines[i + 1]!)) {
      more.push(lines[++i]!)
      if (more.length >= 30) break
    }
    if (more.length > 0) d.message = `${d.message}\n${more.join('\n')}`
    out.push(d)
  }
  return out
}

export const usesSorry = (d: Diagnostic): boolean => d.severity === 'warning' && /declaration uses [`']sorry[`']/.test(d.message)

export type AxiomReport = { theorem: string; found: boolean; axioms: string[] }

/** `#print axioms` を並べた Lean プログラム。標準入力で lake env lean に渡す。 */
export const axiomsProgram = (module: string, theorems: readonly string[]): string =>
  [`import ${module}`, ...theorems.map(t => `#print axioms ${t}`)].join('\n') + '\n'

export const parseAxioms = (output: string, theorems: readonly string[]): AxiomReport[] =>
  theorems.map(t => {
    const q = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const none = new RegExp(`'${q}' does not depend on any axioms`)
    if (none.test(output)) return { theorem: t, found: true, axioms: [] }
    const some = new RegExp(`'${q}' depends on axioms: \\[([^\\]]*)\\]`).exec(output)
    if (some) return { theorem: t, found: true, axioms: some[1]!.split(',').map(s => s.trim()).filter(s => s !== '') }
    return { theorem: t, found: false, axioms: [] }
  })

export type Verdict = 'proven' | 'sorry' | 'axiom' | 'missing' | 'error'

export type Check = {
  verdict: Verdict
  at: string
  fingerprint: string | null
  /** 定理ごとの依存公理 */
  axioms: AxiomReport[]
  errors: Diagnostic[]
  sorries: Diagnostic[]
  detail?: string
}

export const judge = (
  build: { exitCode: number; output: string },
  axioms: AxiomReport[] | null,
  allowed: readonly string[],
): Pick<Check, 'verdict' | 'axioms' | 'errors' | 'sorries' | 'detail'> => {
  const diags = parseDiagnostics(build.output)
  const errors = diags.filter(d => d.severity === 'error')
  const sorries = diags.filter(usesSorry)
  if (build.exitCode !== 0 || errors.length > 0) {
    return { verdict: 'error', axioms: axioms ?? [], errors, sorries, detail: errors.length === 0 ? `lake build が exit ${build.exitCode} で終わった` : undefined }
  }
  if (axioms === null) return { verdict: 'error', axioms: [], errors, sorries, detail: '#print axioms を実行できなかった' }
  if (axioms.some(a => !a.found)) return { verdict: 'missing', axioms, errors, sorries }
  if (sorries.length > 0 || axioms.some(a => a.axioms.includes('sorryAx'))) return { verdict: 'sorry', axioms, errors, sorries }
  if (axioms.some(a => a.axioms.some(x => !allowed.includes(x)))) return { verdict: 'axiom', axioms, errors, sorries }
  return { verdict: 'proven', axioms, errors, sorries }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  proven: '証明済み',
  sorry: '未完 (sorry が残っている)',
  axiom: '未確定 (標準外の公理に依存)',
  missing: '定理が見つからない',
  error: 'ビルド失敗',
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n…(以下 ${text.length - max} 文字省略)`)

export const formatCheck = (spec: Spec, c: Check, allowed: readonly string[], tailChars: number): string => {
  const lines = [`## ${spec.id}: ${VERDICT_LABEL[c.verdict]}`, `性質: ${spec.property}`]
  for (const a of c.axioms) {
    if (!a.found) lines.push(`- ${a.theorem}: 見つからない (定理名か module を確かめる)`)
    else {
      const extra = a.axioms.filter(x => !allowed.includes(x))
      lines.push(`- ${a.theorem}: 公理 [${a.axioms.join(', ') || 'なし'}]${extra.length ? ` ← 標準外: ${extra.join(', ')}` : ''}`)
    }
  }
  const where = (d: Diagnostic) => `${d.file}:${d.line}:${d.col}`
  if (c.errors.length > 0) lines.push('', '### エラー', clip(c.errors.map(d => `${where(d)}: ${d.message}`).join('\n'), tailChars))
  if (c.sorries.length > 0) lines.push('', '### sorry の場所', ...c.sorries.map(d => `- ${where(d)}`))
  if (c.detail) lines.push('', c.detail)
  const next: Record<Verdict, string> = {
    proven: '定理は sorry なしで、許可した公理だけで証明された。性質が壊れた実装を検出できるか lean_spec_mutation で確かめていなければ確かめること。',
    sorry: '証明が終わっていない。「証明済み」と報告しないこと。',
    axiom: '標準外の公理 (axiom 宣言、native_decide が作る補助公理など) に依存している。カーネルだけで検査された証明ではないので、「証明済み」と報告しないこと。',
    missing: 'マニフェストの theorems と Lean の定理名が合っていない。',
    error: 'エラーを直す。定理が成り立たない (反例がある) と分かった場合は、主張を弱めずに反例をコードの言葉で利用者へ報告すること。',
  }
  lines.push('', next[c.verdict])
  return lines.join('\n')
}

// ---------- 壊れた実装の検出 (Able to fail) ----------

/** key は壊し方の識別子 (ファイル・置き換え前後)、spec はそのときの証拠キー (evidenceKey)。 */
export type Mutation = { key: string; spec: string; description: string; file: string; caught: boolean; at: string }

/** 非暗号用の FNV-1a。変更状態と仕様の比較にだけ使う。 */
export const fnv1a = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 検証の結果を左右する仕様のフィールド。syncCommit や説明文は含めない。 */
export const specKey = (m: Manifest, spec: Spec): string =>
  fnv1a(JSON.stringify([m.project, spec.module, spec.theorems, spec.covers]))

/** 壊した実装の記録が証拠になる範囲。仕様キーと、壊す前の Lean ソースの内容で決まる。 */
export const evidenceKey = (spec: string, source: string): string => fnv1a(JSON.stringify([spec, source]))

export const mutationKey = (file: string, find: string, replace: string): string => fnv1a(JSON.stringify([file, find, replace]))

/** 同じ壊し方の記録は最新の 1 件に置き換える。 */
export const recordMutation = (list: readonly Mutation[], m: Mutation): Mutation[] => [...list.filter(x => x.key !== m.key), m]

export const applyMutation = (text: string, find: string, replace: string): { text?: string; error?: string } => {
  if (find === '') return { error: 'find が空' }
  if (find === replace) return { error: 'find と replace が同じで、何も壊していない' }
  const first = text.indexOf(find)
  if (first < 0) return { error: 'find がファイルに見つからない' }
  if (text.indexOf(find, first + 1) >= 0) return { error: 'find がファイルに 2 回以上あり、どこを壊すか一意に決まらない。前後を含めて長くすること' }
  return { text: text.slice(0, first) + replace + text.slice(first + find.length) }
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length

/** 置き換えた範囲の行 (1 始まり、両端を含む)。 */
export const mutatedLines = (original: string, find: string, replace: string): { from: number; to: number } => {
  const from = lineOf(original, original.indexOf(find))
  return { from, to: from + replace.split('\n').length - 1 }
}

/**
 * 壊した実装に対する検査の結果を分類する。
 * missed: 定理がまだ通る。invalid: 置き換えた行そのものがエラーになり、モデルとして読めていない。
 */
export const classifyMutation = (
  verdict: Verdict,
  errors: Diagnostic[],
  fileRel: string,
  range: { from: number; to: number },
): 'caught' | 'missed' | 'invalid' | 'inconclusive' => {
  if (verdict === 'proven') return 'missed'
  // 診断のない失敗 (タイムアウト・起動失敗) や定理が見つからない場合は、定理が反例を捉えたとは言えない
  if (verdict !== 'error' || errors.length === 0) return 'inconclusive'
  // 証明の失敗は定理の位置に出る。置き換えた行にエラーがあれば、構文・名前・型 (インスタンス合成など) のどれであれ
  // モデルが elaborate できておらず、後ろの定理のエラーもその連鎖にすぎない
  const broken = errors.some(d =>
    d.severity === 'error' && fileRel.endsWith(d.file.replace(/^\.\//, '')) && d.line >= range.from && d.line <= range.to)
  return broken ? 'invalid' : 'caught'
}

/** 証明の書き換えで壊れたことにする抜け道。モデル (def) を壊すこと。 */
export const cheatsInMutation = (replace: string): string | null => {
  if (/\bsorry\b|\badmit\b/.test(replace)) return 'replace に sorry / admit を入れると、壊れた実装ではなく証明を消すことになる'
  if (/^\s*(theorem|lemma)\b/m.test(replace)) return '定理を書き換えるのではなく、定理が述べているモデル (def) を壊すこと'
  return null
}

// ---------- 状態 ----------

export type Record_ = { check?: Check; mutations: Mutation[] }
export type Records = Record<string, Record_>

export type Status = {
  spec: Spec
  check: 'unrun' | 'stale' | Verdict
  sync: 'unsynced' | 'changed' | 'synced' | 'unknown'
  changed: string[]
  caught: number
  missed: Mutation[]
}

export const statusOf = (spec: Spec, evidence: string, rec: Record_ | undefined, now: string | null, changed: string[] | null): Status => {
  const c = rec?.check
  const check: Status['check'] = c === undefined ? 'unrun' : now === null || c.fingerprint !== now ? 'stale' : c.verdict
  const sync: Status['sync'] = spec.syncCommit === undefined ? 'unsynced' : changed === null ? 'unknown' : changed.length > 0 ? 'changed' : 'synced'
  // 仕様や Lean ソースが変わる前の記録は、今の定理の証拠にならない
  const muts = (rec?.mutations ?? []).filter(m => m.spec === evidence)
  return { spec, check, sync, changed: changed ?? [], caught: muts.filter(m => m.caught).length, missed: muts.filter(m => !m.caught) }
}

export const isTrusted = (s: Status, requireMutation: boolean): boolean =>
  s.check === 'proven' && s.sync === 'synced' && (!requireMutation || s.caught > 0) && s.missed.length === 0

const CHECK_LABEL: Record<Status['check'], string> = { ...VERDICT_LABEL, unrun: '未検査', stale: '検査後に変更あり (要再検査)' }
const SYNC_LABEL: Record<Status['sync'], string> = {
  unsynced: '未同期 (syncCommit なし)',
  changed: '対象コードが syncCommit 以降に変わった',
  synced: '同期済み',
  unknown: '判定不可 (git で比べられない)',
}

export const formatStatus = (list: Status[], requireMutation: boolean): string => {
  if (list.length === 0) return 'lean-spec: 仕様が登録されていない。'
  const rows = list.map(s => {
    const mut = s.missed.length > 0 ? `検出漏れ ${s.missed.length}` : s.caught > 0 ? `検出 ${s.caught}` : '未確認'
    return `| ${s.spec.id} | ${s.spec.property.replace(/\|/g, '\\|')} | ${CHECK_LABEL[s.check]} | ${mut} | ${SYNC_LABEL[s.sync]} | ${isTrusted(s, requireMutation) ? '○' : '×'} |`
  })
  const notes: string[] = []
  for (const s of list) {
    if (s.changed.length > 0) notes.push(`- ${s.spec.id}: syncCommit ${s.spec.syncCommit?.slice(0, 8)} 以降に変わった対象: ${s.changed.join(', ')}。モデルがまだコードを表しているか読み比べること。`)
    for (const m of s.missed) notes.push(`- ${s.spec.id}: 「${m.description}」を壊しても定理が通った。性質が弱いか、モデルがその部分を表していない。`)
    if (s.spec.scope) notes.push(`- ${s.spec.id} の前提と範囲: ${s.spec.scope}`)
  }
  return [
    '| id | 機能ができるべきこと | 証明 | 壊した実装の検出 | コードとの同期 | 信頼 |',
    '|---|---|---|---|---|---|',
    ...rows,
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n')
}

// ---------- 編集の監視 ----------

/** Lean ファイルへの書き込みに含まれる、証明を素通りさせる要素。 */
export const escapeHatches = (text: string): string[] => {
  const code = text.replace(/--.*$/gm, '').replace(/\/-[\s\S]*?-\//g, '')
  const found: string[] = []
  if (/\bsorry\b/.test(code)) found.push('sorry')
  if (/\badmit\b/.test(code)) found.push('admit')
  if (/^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+)?axiom\s/m.test(code)) found.push('axiom 宣言')
  if (/\bnative_decide\b/.test(code)) found.push('native_decide')
  if (/@\[\s*implemented_by\b/.test(code)) found.push('implemented_by')
  if (/debug\.skipKernelTC/.test(code)) found.push('debug.skipKernelTC')
  return found
}

const shortName = (t: string): string => t.split('.').pop()!

/** 定理の主張 (名前から := まで) を空白を詰めて返す。見つからなければ null。 */
export const statementOf = (text: string, theorem: string): string | null => {
  const name = shortName(theorem).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`\\b(?:theorem|lemma)\\s+(?:[\\w.']+\\.)?${name}(?![\\w'])([\\s\\S]*?):=`).exec(text)
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : null
}

/** 編集の前後で主張が変わった・消えた定理。証明を通すために主張を弱める変更を見逃さないために使う。 */
export const changedStatements = (specs: Spec[], before: string, after: string): string[] =>
  specs.flatMap(s => s.theorems).filter(t => {
    const was = statementOf(before, t)
    return was !== null && statementOf(after, t) !== was
  })

export const coverNote = (specs: Spec[]): string =>
  `lean-spec: このファイルは次の仕様の検証対象。\n${specs.map(s => `- ${s.id}: ${s.property} (定理 ${s.theorems.join(', ')})`).join('\n')}\n変更が性質に関わるなら、Lean のモデルがまだこのコードを表しているか読み比べ、lean_spec_check を実行すること。意図して振る舞いを変えたならモデルと定理を先に直す。`

export const hatchNote = (found: string[]): string =>
  `lean-spec: この Lean ファイルに ${found.join('・')} がある。証明の下書きなら構わないが、残っている間は lean_spec_check が「証明済み」にしないので、完了と報告しないこと。`

export const theoremNote = (names: string[]): string =>
  `lean-spec: 仕様の定理 ${names.join(', ')} の主張を変えた。証明を通すために主張を弱めたのなら元に戻し、反例を利用者へ報告すること。要件が変わったのなら、マニフェストの property も合わせて直すこと。`

// ---------- 起動の判定と手順書 ----------

const MARKER = '<lean-spec-playbook>'
const INTENT = [
  /形式(?:検証|的に検証|仕様)/,
  /定理証明/,
  /\blean\s*4?\b/i,
  /(?:性質|仕様|不変条件|ルール)を?(?:証明|検証)/,
  /証明して/,
  /\b(?:formal(?:ly)?\s+verif\w*|prove\s+(?:that|this|the)|theorem\s+prov\w*)/i,
]

export const wantsPlaybook = (text: string): boolean =>
  !text.includes(MARKER) && !text.trimStart().startsWith('/') && INTENT.some(re => re.test(text))

export const playbook = (cfg: Config): string => `${MARKER}
Lean 4 による形式検証で「この機能は何をできるべきか」を確かめる依頼として扱う。テストが具体的な入力で確かめるのに対し、ここでは前提と範囲を決めて、その範囲のすべての入力で性質が成り立つことを Lean のカーネルに検査させる。

## 1. 対象を選ぶ
- 利用者が機能やバグを挙げていればそこから始める。挙げていなければ、壊れると利用者が害を受けるのにテストが届きにくい約束 (残高・権限・状態遷移・パーサ・境界値) をコードから選ぶ。易しさで選ばない。
- 操作の順序や並行性が問題なら、Lean より TLA+ などのモデル検査が合う。入力の大きさに上限を置かずに成り立たせたい性質が Lean の対象。合わないときはそう言う。

## 2. 「できるべきこと」を文にする
機能ごとに、要件を平易な 1 文の性質に書き出し、利用者が読んで同意できる形にする。
- 安全性: 起きてはいけないこと (例: どの金額で引き出しても残高は負にならない)
- 能力: できるべきこと (例: 残高が足りていれば引き出しは成功し、残高はちょうど引き出し額だけ減る)
安全性だけでは「常に拒否する実装」でも成り立ってしまう。能力の性質を必ず 1 つ以上入れる。各性質に、破れたときの害を 1 文添える。

## 3. Lean でモデルと定理を書く
- マニフェスト \`${cfg.manifestPath}\` の project にある lake プロジェクトに置く。なければ lean_spec_init で作る。
- モデルの def は対象コードの関数と 1 対 1 に対応させ、名前もコードから取る。コードで 1 ステップの処理はモデルでも 1 ステップにする。対応するファイルと関数をコメントで書く。
- 性質ごとに theorem を書く。前提 (引数の範囲など) は仮定として明示する。
- 証明に sorry・admit・axiom 宣言・native_decide を残さない。

## 4. 検査する
- lean_spec_check で検査する。sorry が残る・標準外の公理に依存する・定理が見つからない場合は「証明済み」にならない。
- 定理が証明できず反例が見つかったら、それは発見である。主張やモデルを弱めて通さず、反例をコードの言葉 (どの入力で、どの手順で、何が起きるか) で利用者へ報告する。利用者に頼まれない限りプロダクトコードは直さない。

## 5. 壊れた実装を検出できるか確かめる
- 性質ごとに lean_spec_mutation で、モデルの def を「チェックを外す」「順序を入れ替える」「境界を 1 ずらす」など現実にありそうな形で壊し、定理が通らなくなることを確かめる。ツールが元に戻す。
- 壊しても通るなら、性質が弱いかモデルがその部分を表していない。定理を強めるかモデルを直す。

## 6. 記録する
- マニフェストに id・feature・property・harm・scope (前提と範囲)・module・theorems・covers (対象コードのパス) を書く。
- 検査と壊した実装の検出が済んだら lean_spec_sync で syncCommit を今のコミットに進める。対象コードが後で変わると lean_spec_status が知らせる。

## 7. 報告する
何を検証したか (性質を平易な文で)、なぜ Lean か、前提と範囲、見つかったこと、壊した実装の検出結果、再実行の方法 (lean_spec_check)、対象外のことを書く。Lean のモデルは実際のコードとは別物で、両者が一致することはコードを読み比べて確かめた範囲でしか言えないことも書く。
</lean-spec-playbook>`

export const guidance = `## lean-spec
このリポジトリには Lean 4 で証明した機能の仕様がある (lean_spec_status で一覧)。仕様の対象コードを変えたら lean_spec_check を実行し、Lean のモデルがまだコードを表しているか確かめること。sorry・標準外の公理が残る証明、壊した実装を検出できなかった証明は「証明済み」と報告しない。証明を通すために定理の主張を弱めない。`

export const INIT_FILES = (project: string, lib: string, toolchain: string): Record<string, string> => ({
  [`${project}/lean-toolchain`]: `${toolchain}\n`,
  [`${project}/lakefile.toml`]: `name = "${lib.toLowerCase()}"\ndefaultTargets = ["${lib}"]\n\n[[lean_lib]]\nname = "${lib}"\n`,
  [`${project}/${lib}.lean`]: `-- 仕様のモジュールをここから import する\n`,
  [`${project}/.gitignore`]: `/.lake\n`,
})

export const parseToolchain = (versionOutput: string): string | null => {
  const m = /version\s+(\d+\.\d+\.\d+(?:-rc\d+)?)/.exec(versionOutput)
  return m ? `leanprover/lean4:v${m[1]}` : null
}

export const INSTALL_HINT = 'Lean が見つからない。elan (Lean のツールチェーン管理) を入れること: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y --default-toolchain stable` のあと、新しいシェルで `lake --version` が動くことを確かめる。'
