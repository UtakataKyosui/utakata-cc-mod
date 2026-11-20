// 承認付き操作の純粋ロジック (承認の照合・パス検証・ジャーナル)。プロセス実行は executor.ts が担当する。
import { CACHE_NAMES } from './policy'

/** 衝突しにくさだけが目的の非暗号ハッシュ (cyrb53)。計画と実行の状態が変わったかの検出に使う。 */
export const digest = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

export const PLAN_ID = /^RSM-[0-9a-f]{10}$/
export const OP_ID = /^RSM-[0-9a-f]{10}-\d{1,3}$/

export const isAbsolutePath = (p: unknown): p is string =>
  typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !p.split('/').some(s => s === '..' || s === '.') && !p.includes('//')

export const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
export const dirname = (p: string): string => trimSlash(p).slice(0, trimSlash(p).lastIndexOf('/')) || '/'
export const basename = (p: string): string => trimSlash(p).slice(trimSlash(p).lastIndexOf('/') + 1)

/** 退避 (ゴミ箱代わり) ディレクトリ。元のディレクトリの隣に作り、同一 FS 上の rename だけで退避する。 */
export const quarantineRoot = (repo: string, opId: string): string => `${dirname(repo)}/.rsm-trash-${opId.slice(4)}`

export const isQuarantineRoot = (path: string, repo: string): boolean => {
  if (!isAbsolutePath(path) || !isAbsolutePath(repo)) return false
  const m = /^\.rsm-trash-([0-9a-f]{10}-\d{1,3})$/.exec(basename(path))
  return m !== null && dirname(path) === dirname(repo)
}

/** 生成物の削除対象として許すのは `<repo>/<既知の生成物名>` だけ。 */
export const isCacheTarget = (repo: string, target: string): boolean =>
  isAbsolutePath(repo) && isAbsolutePath(target) && dirname(target) === trimSlash(repo) && (CACHE_NAMES as readonly string[]).includes(basename(target))

export type Journal = {
  schema: 'repo-preservation-journal-1'
  opId: string
  planId: string
  operation: 'cache-only' | 'archive' | 'relocate'
  repo: string
  status: 'pending' | 'staged' | 'purged' | 'restored' | 'failed'
  entries: { name: string; from: string; to: string }[]
  archive?: { bundle: string; manifest: string; sha256: string; extras?: string; extrasSha256?: string }
  measuredBytes?: number
  note?: string
  createdAt: string
}

export const parseJournal = (text: string): Journal | undefined => {
  try {
    const j = JSON.parse(text) as Journal
    if (j.schema !== 'repo-preservation-journal-1' || !OP_ID.test(j.opId) || !PLAN_ID.test(j.planId)) return undefined
    if (!isAbsolutePath(j.repo) || !Array.isArray(j.entries)) return undefined
    if (!['pending', 'staged', 'purged', 'restored', 'failed'].includes(j.status)) return undefined
    const root = quarantineRoot(j.repo, j.opId)
    // 退避先と復元先が、ジャーナル自身の主張と矛盾しない (改ざん・取り違えの検出)
    for (const e of j.entries) {
      if (!isAbsolutePath(e.from) || !isAbsolutePath(e.to) || e.to !== `${root}/${e.name}` || basename(e.from) !== e.name) return undefined
      if (!(e.from === j.repo || isCacheTarget(j.repo, e.from))) return undefined
    }
    return j
  } catch {
    return undefined
  }
}

// ---- 承認 ----

export type Approval = { text: string; at: number }
export const APPROVAL_TTL_MS = 180_000

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const mentions = (text: string, token: string): boolean => new RegExp(`(?<![\\w/.-])${escape(token)}(?![\\w/.-])`).test(text)

/** 承認が、この ID と、すべての対象パスを質問文で復唱し、期限内であるか。 */
export const approvalCovers = (a: Approval | undefined, now: number, ids: string[], paths: string[]): string | undefined => {
  if (!a) return '承認がない。AskUserQuestion で対象と操作を復唱して承認を取ること'
  if (now - a.at > APPROVAL_TTL_MS) return '承認の期限 (180 秒) が切れている。改めて承認を取ること'
  for (const id of ids) if (!mentions(a.text, id)) return `承認の質問文に ${id} が含まれていない`
  for (const p of paths) if (!mentions(a.text, p)) return `承認の質問文に対象 ${p} が含まれていない`
  return undefined
}

/**
 * 肯定の回答は、明示した形に完全一致するものだけ。「しません」「できません」「do not approve」のような否定や、
 * 自由記述 (Other) の曖昧な文は、動詞を含んでいても承認にしない。
 */
export const isAffirmative = (answer: string): boolean =>
  /^(はい|yes|y|ok|承認(する)?|(はい)?(実行|削除|退避|復元)(する)?|approve)$/i.test(answer.trim().replace(/[\s、。,.!！]/g, ''))

export const idsIn = (text: string): string[] => [...new Set(text.match(/RSM-[0-9a-f]{10}(?:-\d{1,3})?/g) ?? [])]

/** `df -P` の Mounted on 列。 */
export const mountFromDf = (out: string): string | undefined => {
  const line = out.trim().split('\n')[1]
  return line ? line.split(/\s+/).slice(5).join(' ') || undefined : undefined
}

/** `ps -eo pid,args` から claude プロセスの PID を取り出す。claude で始まるものだけ (サブプロセスは数えない)。 */
export const claudePids = (ps: string): number[] =>
  ps.split('\n').map(l => /^\s*(\d+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null)
    .filter(m => /(^|\/)claude$/.test(m[2]!)).map(m => Number(m[1]))

/** `lsof -Fn` の cwd。 */
export const cwdFromLsof = (out: string): string | undefined => out.split('\n').find(l => l.startsWith('n'))?.slice(1)

export const within = (dir: string, root: string): boolean => dir === trimSlash(root) || dir.startsWith(`${trimSlash(root)}/`)

type Q = { question?: unknown; header?: unknown }

/**
 * 質問ごとに、その質問自身への回答で承認されたものだけを取り出す。
 * 複数の質問の回答を混ぜない (別の質問への「はい」で、拒否した操作が承認されない)。
 * 回答と質問を対応づけられないものは承認しない。
 */
export const approvedQuestionText = (questions: Q[], answers: Record<string, unknown> | undefined): string => {
  const values = Object.values(answers ?? {})
  const approved: string[] = []
  for (const q of questions) {
    const text = String(q?.question ?? '')
    if (idsIn(text).length === 0) continue
    const own = answers?.[text] ?? (typeof q?.header === 'string' ? answers?.[q.header] : undefined) ?? (questions.length === 1 && values.length === 1 ? values[0] : undefined)
    if (own !== undefined && isAffirmative(String(own))) approved.push(text)
  }
  return approved.join('\n')
}
