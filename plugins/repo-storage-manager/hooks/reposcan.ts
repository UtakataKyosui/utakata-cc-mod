// reposcan の JSON (pkg/report の ScanReport) を、参考信号として取り込む。
// 契約は reposcan の公開型 (Go 構造体のタグ) による。git の一次確認が正で、reposcan は判定を保守側にしか動かさない。
import type { Verdict } from './policy'

export type ReposcanState = {
  path: string
  vcsType: string
  uncommitedFiles: string[]
  remoteStatus: { remote?: string; ahead: number; behind: number }[]
  stashes: string[]
}
export type ReposcanReport = { version: number; repoStates: ReposcanState[]; warnings: string[] }

const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

const isState = (v: unknown): v is ReposcanState => {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && isStr(o.path) && o.path.startsWith('/') && isStr(o.vcsType)
    // null は「無し」として扱う (Go の nil slice は JSON で null になる)
    && (o.uncommitedFiles === null || isStrArr(o.uncommitedFiles)) && (o.stashes === null || isStrArr(o.stashes))
    && (o.remoteStatus === null || (Array.isArray(o.remoteStatus) && o.remoteStatus.every(r => !!r && isInt((r as any).ahead) && isInt((r as any).behind))))
}

/** 出力から ScanReport を取り出す。初回の通知文などが混ざっていても、最初の { から最後の } までを試す。形が違えば undefined。 */
export const parseReposcan = (stdout: string): ReposcanReport | undefined => {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const o = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    if (!isInt(o.version) || !Array.isArray(o.repoStates) || !o.repoStates.every(isState)) return undefined
    const norm = (s: any): ReposcanState => ({ ...s, uncommitedFiles: s.uncommitedFiles ?? [], stashes: s.stashes ?? [], remoteStatus: s.remoteStatus ?? [] })
    return { version: o.version, repoStates: (o.repoStates as ReposcanState[]).map(norm), warnings: Array.isArray(o.warnings) ? o.warnings.filter(isStr) : [] }
  } catch {
    return undefined
  }
}

export type Signal = { source: 'reposcan'; uncommitted: number; ahead: number; behind: number; stashes: number }

export const signalOf = (s: ReposcanState): Signal => ({
  source: 'reposcan',
  uncommitted: s.uncommitedFiles.length,
  ahead: s.remoteStatus.reduce((a, r) => a + r.ahead, 0),
  behind: s.remoteStatus.reduce((a, r) => a + r.behind, 0),
  stashes: s.stashes.length,
})

/** reposcan が uncommitted / 未 push / stash を報告するなら、git の判定が CANDIDATE でも DIRTY に倒す。逆 (CANDIDATE へ上げる) は決してしない。 */
export const applySignal = (v: Verdict, sig: Signal | undefined): Verdict =>
  v.category === 'CANDIDATE' && sig && (sig.uncommitted > 0 || sig.ahead > 0 || sig.stashes > 0)
    ? { category: 'DIRTY', reasons: ['SIGNAL_CONFLICT'] }
    : v

export const byPath = (r: ReposcanReport): Map<string, ReposcanState> => new Map(r.repoStates.map(s => [s.path.replace(/\/+$/, ''), s]))
