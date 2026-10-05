export type Config = { skipMaxFiles: number; skipMaxLines: number; maxReviews: number }

const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def

export const readConfig = (options: Record<string, unknown> | undefined): Config => ({
  skipMaxFiles: num(options?.skipMaxFiles, 2, 0, 100),
  skipMaxLines: num(options?.skipMaxLines, 30, 0, 5000),
  // 初回レビュー + 再レビューの合計
  maxReviews: 1 + num(options?.maxReReviews, 2, 0, 10),
})

export const REVIEWER = 'change-review:reviewer'

export type Stat = { files: number; lines: number }

/** `git diff --shortstat` の出力から変更規模を読む。 */
export const parseShortstat = (text: string): Stat => {
  const pick = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0)
  return {
    files: pick(/(\d+) files? changed/),
    lines: pick(/(\d+) insertions?\(\+\)/) + pick(/(\d+) deletions?\(-\)/),
  }
}

export const judgeSkip = (stat: Stat, cfg: Config): { skip: boolean; reason: string } => {
  if (stat.files === 0) return { skip: true, reason: '変更差分がない' }
  const small = stat.files <= cfg.skipMaxFiles && stat.lines <= cfg.skipMaxLines
  const scale = `${stat.files} ファイル / ${stat.lines} 行`
  return small
    ? { skip: true, reason: `小さな変更 (${scale}、上限 ${cfg.skipMaxFiles} ファイル / ${cfg.skipMaxLines} 行)` }
    : { skip: false, reason: `上限 (${cfg.skipMaxFiles} ファイル / ${cfg.skipMaxLines} 行) を超える変更 (${scale})` }
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'
export type Finding = { severity: Severity; location: string; issue: string; evidence: string }
export type Parsed = { findings: Finding[]; problems: string[]; verdict: 'clean' | 'fix' | undefined }

const FINDING = /^\s*[-*]\s*\[(blocker|major|minor|nit)\]\s*(\S+?:\d+(?:-\d+)?)\s*\|\s*(.+?)\s*\|\s*根拠:\s*(.+?)\s*$/
const MIN_EVIDENCE = 6

/** レビュアーの報告を検証する。形式に合わない指摘と、判定・確認範囲の欠落を problems にする。 */
export const parseReport = (text: string): Parsed => {
  const findings: Finding[] = []
  const problems: string[] = []
  for (const line of text.split('\n')) {
    if (!/^\s*[-*]\s*\[/.test(line)) continue
    const m = FINDING.exec(line)
    if (m === null) {
      problems.push(`形式に合わない指摘: ${line.trim().slice(0, 80)}`)
    } else if (m[4].length < MIN_EVIDENCE) {
      problems.push(`根拠が空に近い指摘: ${m[2]}`)
    } else {
      findings.push({ severity: m[1] as Severity, location: m[2], issue: m[3], evidence: m[4] })
    }
  }
  const v = /^\s*判定:\s*(指摘なし|要修正)/m.exec(text)
  const verdict = v === null ? undefined : v[1] === '指摘なし' ? 'clean' : 'fix'
  if (verdict === undefined) problems.push('「判定: 指摘なし」または「判定: 要修正」の行がない')
  if (!/^\s*確認範囲:\s*\S/m.test(text)) problems.push('「確認範囲:」の行がない')
  if (verdict === 'clean' && findings.some(f => severe(f))) problems.push('判定が指摘なしだが blocker/major の指摘がある')
  if (verdict === 'fix' && findings.length === 0 && problems.length === 0) problems.push('判定が要修正だが有効な指摘がない')
  return { findings, problems, verdict }
}

export const severe = (f: Finding): boolean => f.severity === 'blocker' || f.severity === 'major'

export const reportNote = (p: Parsed): string =>
  p.problems.length === 0
    ? ''
    : ['[change-review] レビュー報告に形式の不備がある。不備のある指摘は根拠のない指摘として扱わず、レビュアーに出し直させること。', ...p.problems.map(s => `- ${s}`)].join('\n')

export type ReviewState = {
  reviews: number
  /** 直近のレビューで残っている blocker/major の件数。undefined は報告が検証に通らなかった */
  severe: number | undefined
  skipped: string | undefined
}

export const initialState = (): ReviewState => ({ reviews: 0, severe: undefined, skipped: undefined })

export const exceeded = (state: ReviewState, cfg: Config): boolean => state.reviews >= cfg.maxReviews

export const limitDenyText = (cfg: Config): string =>
  [
    `レビュアーの起動回数が上限 (初回 + 再レビュー ${cfg.maxReviews - 1} 回) に達した。`,
    'これ以上レビューを回さず、直近のレビューで残った指摘を「未解決」として完了報告に明記すること。',
    '上限は userConfig の maxReReviews で変えられ、ユーザーは /change-review reset で数え直せる。',
  ].join('\n')

/** 完了報告に載せるべきレビュー状況。未実施・未解決を必ず明示する。 */
export const formatStatus = (state: ReviewState, cfg: Config): string => {
  const lines = [`change-review: レビュー ${state.reviews}/${cfg.maxReviews} 回 (初回 + 再レビュー ${cfg.maxReviews - 1} 回まで)`]
  if (state.reviews === 0) {
    lines.push(
      state.skipped === undefined
        ? 'レビュー未実施: 完了報告に「レビュー未実施」とその理由を書くこと'
        : `レビュー省略: ${state.skipped} (完了報告に省略の理由を書くこと)`,
    )
  } else if (state.severe === undefined) {
    lines.push('直近のレビュー報告は形式検証に通っていない: 未解決の指摘が不明なので、その旨を完了報告に書くこと')
  } else if (state.severe > 0) {
    lines.push(`未解決の重大指摘 (blocker/major) が ${state.severe} 件残っている可能性がある: 修正して再レビューするか、未解決として完了報告に明記すること`)
  } else {
    lines.push('重大な未解決指摘はない')
  }
  if (exceeded(state, cfg)) lines.push('再レビューの上限に達している')
  return lines.join('\n')
}

const MUTATING_BASH =
  /(^|[;&|(]\s*|\s)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|truncate|dd|patch)\s|(^|[^>&0-9])>{1,2}\s*[^&\s]|\bsed\s+(-\w*\s+)*-i|\bgit\s+(add|commit|checkout|switch|reset|restore|clean|apply|am|stash|merge|rebase|cherry-pick|revert|push|pull|fetch|rm|mv|tag|branch\s+-[dDmM])\b|\b(npm|pnpm|yarn|bun|pip|cargo|brew)\s+(install|add|remove|uninstall|update|upgrade)\b/

/** 読み取り専用のレビュアーに許さない Bash か。正規表現による近似で、完全な保証ではない。 */
export const isMutatingBash = (command: unknown): boolean => typeof command === 'string' && MUTATING_BASH.test(command)

export const reviewerDescription =
  '実装後の差分を、実装者とは別の視点で読み取り専用レビューする。正しさ・回帰・セキュリティ・不要な変更を点検し、ファイル位置・根拠・重要度付きで指摘を返す。修正はしない'

export const reviewerPrompt = [
  'あなたは実装者とは独立した差分レビュアーである。渡された要求と差分を読み、問題を指摘する。',
  '',
  '制約',
  '- 読み取り専用。ファイルの編集・作成・削除、コミット、パッケージ導入、状態を変える Bash は行わない。修正は実装側が行う',
  '- 差分は `git diff` / `git diff --staged` / `git show` などで自分でも確認し、渡された説明を鵜呑みにしない',
  '- 検証結果 (テスト・型検査・lint など) が渡された場合は参考にするが、通っていることを正しさの根拠にしない。渡されなければ、検証結果なしでレビューしたと報告に書く',
  '',
  '観点',
  '1. 正しさ: 要求・受け入れ条件を満たすか。仕様からの逸脱、境界値、エラー処理',
  '2. 回帰: 既存の呼び出し元・挙動・テストを壊さないか (呼び出し元は Grep で実際に確認する)',
  '3. セキュリティ: 入力検証、秘密情報、コマンド・パス・SQL の組み立て、権限',
  '4. 不要な変更: 要求と無関係な差分、不要な整形・リネーム・依存追加、触ってはいけない範囲への変更',
  '',
  '指摘の書式 (1 指摘 1 行。この書式に合わない指摘は無効として扱われる)',
  '- [重要度] ファイルパス:行 | 指摘の内容 | 根拠: 差分やコードのどこからそう言えるか',
  '重要度は blocker (マージ不可・動かない・脆弱性)、major (要求未達・回帰の恐れ)、minor (直した方がよい)、nit (好みの範囲) のいずれか。',
  '',
  '指摘の条件',
  '- 位置は差分内の実在する行にする。行が特定できない指摘は書かない',
  '- 根拠は、実際に読んだコードや再現できる条件で示す。「一般にこうすべき」「念のため」だけの指摘は書かない',
  '- 推測で重要度を上げない。確証がなければ minor にして根拠に「未確認」と書く',
  '',
  '報告の最後に必ず次の 2 行を書く',
  '確認範囲: 読んだ差分とファイル、実行した確認コマンド、確認できなかったこと',
  '判定: 指摘なし または 判定: 要修正',
  '',
  '指摘がなければ指摘行は書かず、確認範囲と判定だけを返す。',
].join('\n')

export const guidance = (cfg: Config): string =>
  [
    '実装を終えたら、完了報告の前に、実装者とは別のレビュアー SubAgent (subagent_type: change-review:reviewer) で差分を点検する。',
    '',
    `省略してよい場合: 変更が ${cfg.skipMaxFiles} ファイル以下かつ ${cfg.skipMaxLines} 行以下 (\`git diff --shortstat\` で確認)。ただし認証・権限・秘密情報・削除を伴う変更は小さくても省略しない。省略したら完了報告にその理由を書く`,
    '',
    'レビュアーへの依頼 (レビュアーは会話履歴を持たない。次を必ずプロンプトに含める)',
    '- 要求と受け入れ条件 (ユーザーの依頼文、Issue、触ってはいけない範囲)',
    '- 対象の差分の取り方 (`git diff` / `git diff --staged` / コミット範囲)',
    '- 検証結果 (verification-gate などで得たテスト・型検査・lint の結果。なければ「検証結果なし」)',
    '',
    '指摘への対応',
    '- 修正は実装者が行う。レビュアーには編集させない',
    '- blocker/major は直して、修正後の差分を同じレビュアー手順でもう一度確認する。minor/nit は対応するか、見送る理由を報告に書く',
    `- 再レビューは初回を除いて ${cfg.maxReviews - 1} 回まで。上限後も残る指摘は、直さず未解決として報告する`,
    '- 根拠のない指摘や書式不備の指摘は、レビュアーに根拠付きで出し直させるか、採用しない理由を書く',
    '',
    '完了報告に必ず書く項目',
    '- レビュー: 実施 (回数) / 省略 (理由) / 未実施 (理由) のいずれか。実施していないのに「問題なし」と書かない',
    '- 未解決の重大指摘 (blocker/major) の一覧。なければ「なし」',
    '- 修正後に再確認した差分の範囲',
    '/change-review で現在のレビュー状況と省略可否を確認できる。',
  ].join('\n')
