import { DRIP_PROMPTS, isLoopbackUrl, LARGE_CHARS } from './policy'
import type { Analysis, Prompt } from './policy'

export type Verdict = 'adopt' | 'revise' | 'discard'

export type Llm = {
  /** 改善案の下書きを作る生成モデル。 */
  draft: (prompt: string) => Promise<string>
  /** 選択肢の記号1文字を返す判断モデル。 */
  judge: (prompt: string) => Promise<string>
}

export type Finding = { id: string; title: string; summary: string; examples: string[] }

export type Proposal = {
  finding: Finding
  rule: string
  status: 'adopted' | 'needs-review' | 'discarded'
  rounds: number
}

export const MAX_ROUNDS = 2

const clip = (text: string, n: number): string => {
  const one = text.replace(/\s+/g, ' ')
  return [...one].length > n ? `${[...one].slice(0, n).join('')}…` : one
}

const sample = (ps: Prompt[]): string[] => ps.slice(0, 5).map(p => clip(p.text, 80))

/** 機械集計の結果から、改善案を作る対象を取り出す。 */
export const findingsOf = (a: Analysis): Finding[] => {
  const out: Finding[] = []
  if (a.drips.length > 0)
    out.push({
      id: 'drips',
      title: '要件の小出し',
      summary: `1セッションで${DRIP_PROMPTS}件以上のプロンプトを送ったセッションが${a.drips.length}個あった。最多は${a.drips[0].count}件。`,
      examples: a.drips.slice(0, 5).map(d => `セッション ${d.sessionId.slice(0, 8)}: ${d.count}件`),
    })
  if (a.deictic.length > 0)
    out.push({
      id: 'deictic',
      title: '指示語だけのプロンプト',
      summary: `対象を示さない短い指示が${a.deictic.length}件あった。`,
      examples: sample(a.deictic),
    })
  if (a.large.length > 0)
    out.push({
      id: 'large',
      title: '肥大したプロンプト',
      summary: `${LARGE_CHARS}文字以上のプロンプトが${a.large.length}件あった。`,
      examples: sample(a.large),
    })
  if (a.fragments.length > 0)
    out.push({
      id: 'fragments',
      title: '誤送信の疑い',
      summary: `3文字以下の断片的なプロンプトが${a.fragments.length}件あった。`,
      examples: sample(a.fragments),
    })
  return out
}

export const draftPrompt = (f: Finding, feedback?: string): string =>
  [
    'あなたは、AI コーディングエージェントへの指示の出し方を改善する助言者です。',
    '次の観察結果をもとに、利用者が今後守るべき規則を日本語で1〜3行にまとめてください。',
    '規則は、具体的な行動として書き、前置きや見出しは付けないでください。',
    '',
    `観察: ${f.title}`,
    f.summary,
    '例:',
    ...f.examples.map(e => `- ${e}`),
    ...(feedback ? ['', `前回の案への指摘: ${feedback}`, '指摘を踏まえて書き直してください。'] : []),
  ].join('\n')

const OPTIONS = [
  ['A', '採用する'],
  ['B', '具体性が足りず、修正が必要'],
  ['C', '観察結果と関係が薄く、棄却する'],
] as const

export const judgePrompt = (f: Finding, rule: string): string =>
  [
    'Decision task: 観察結果に対する改善案を採用するか選ぶ。',
    '採用の条件: 具体的な行動として書かれている / 観察結果の原因に対応している / 3行以内。',
    '',
    '<state>',
    `観察: ${f.title}。${f.summary}`,
    `改善案: ${rule}`,
    '</state>',
    '',
    'Options:',
    ...OPTIONS.map(([k, v]) => `${k}. ${v}`),
    '',
    'Answer:',
  ].join('\n')

/** 判断モデルの出力から選択肢を読む。考察が混ざっても、最後に単独で現れた記号を採る。 */
export const parseVerdict = (text: string): Verdict | undefined => {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '')
  const m = [...body.matchAll(/(?:^|[\s"'「(])([ABC])(?=$|[\s"'」).。:：])/g)].pop()
  return m ? ({ A: 'adopt', B: 'revise', C: 'discard' } as const)[m[1] as 'A' | 'B' | 'C'] : undefined
}

const FEEDBACK = '行動が曖昧だった。誰が・いつ・何をするかを明示して、具体的に書くこと。'

/** 下書き → 判断 → (修正が必要なら) 書き直し、を最大 MAX_ROUNDS 回まわす。 */
export const refine = async (llm: Llm, f: Finding): Promise<Proposal> => {
  let rule = ''
  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rule = (await llm.draft(draftPrompt(f, feedback))).trim()
    if (rule === '') return { finding: f, rule, status: 'needs-review', rounds: round }
    const verdict = parseVerdict(await llm.judge(judgePrompt(f, rule)))
    if (verdict === 'adopt') return { finding: f, rule, status: 'adopted', rounds: round }
    if (verdict === 'discard') return { finding: f, rule, status: 'discarded', rounds: round }
    feedback = FEEDBACK
  }
  return { finding: f, rule, status: 'needs-review', rounds: MAX_ROUNDS }
}

export const improve = async (llm: Llm, a: Analysis): Promise<Proposal[]> => {
  const proposals: Proposal[] = []
  for (const f of findingsOf(a)) proposals.push(await refine(llm, f))
  return proposals
}

export const improvementFileName = (now: number): string => `${new Date(now).toISOString().slice(0, 10)}-prompt-improvements.md`

const section = (title: string, ps: Proposal[]): string[] =>
  ps.length === 0 ? [] : [`## ${title}`, '', ...ps.flatMap(p => [`### ${p.finding.title}`, '', p.rule, ''])]

export const renderImprovements = (proposals: Proposal[], models: { draft: string; judge: string }, endpoint: string): string => {
  const adopted = proposals.filter(p => p.status === 'adopted')
  const review = proposals.filter(p => p.status === 'needs-review')
  const discarded = proposals.filter(p => p.status === 'discarded')
  const body = [
    ...section('採用された改善案', adopted),
    ...section('人の確認が必要な案', review),
    ...(discarded.length > 0 ? ['## 棄却された観察', '', ...discarded.map(p => `- ${p.finding.title}`), ''] : []),
  ]
  return [
    '# プロンプトの改善案',
    '',
    `下書きは ${models.draft}、採否の判断は ${models.judge} が担当した。${isLoopbackUrl(endpoint) ? 'ローカルで処理しており、外部には送っていない。' : `プロンプトの抜粋を ${endpoint} に送って処理した。`}`,
    '採用された案も自動では反映していない。内容を確認して、CLAUDE.md などへ手で移す。',
    '',
    ...(body.length > 0 ? body : ['改善案を作る対象がなかった。', '']),
  ].join('\n')
}

export const improveSummary = (proposals: Proposal[], path: string): string =>
  [
    `改善案を${proposals.length}件作った。`,
    `採用 ${proposals.filter(p => p.status === 'adopted').length} / 要確認 ${proposals.filter(p => p.status === 'needs-review').length} / 棄却 ${proposals.filter(p => p.status === 'discarded').length}`,
    `レポート: ${path}`,
  ].join('\n')
