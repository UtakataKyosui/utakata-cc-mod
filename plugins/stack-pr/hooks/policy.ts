export type Config = {
  maxLines: number
  maxFiles: number
  maxLayers: number
}

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

export const readConfig = (options: Record<string, unknown>): Config => ({
  maxLines: clamp(options.maxLines, 400, 50, 5000),
  maxFiles: clamp(options.maxFiles, 15, 3, 200),
  maxLayers: clamp(options.maxLayers, 3, 2, 10),
})

const MARKER = '<stack-pr-playbook>'

const ISSUE_URL = /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/i
const ISSUE_WORD_NUMBER = /(?:\bissues?\b|イシュー|課題)\s*(?:#|no\.?|番号|番)?\s*\d+/i
const NUMBER_ISSUE_WORD = /#\d+\s*(?:の|を)?\s*(?:issue|イシュー)/i
const GH_ISSUE = /\bgh\s+issue\s+(?:view|develop)\b/i
const STACK_WORD = /\bgh\s+stack\b|stack(?:ed)?\s*pr|スタック\s*pr/i

export const mentionsIssue = (text: string): boolean => {
  if (text.includes(MARKER) || text.trimStart().startsWith('/')) return false
  return [ISSUE_URL, ISSUE_WORD_NUMBER, NUMBER_ISSUE_WORD, GH_ISSUE, STACK_WORD].some(re => re.test(text))
}

export const buildPlaybook = (cfg: Config): string => {
  const softLines = Math.round(cfg.maxLines / 2)
  const softFiles = Math.round(cfg.maxFiles / 2)
  return `${MARKER}
Issue の実装が依頼された。着手前に変更範囲を見積もり、「大規模」なら gh stack の Stack PR で、そうでなければ通常の単一 PR で進めること。

## 1. 変更範囲の見積もり
Issue 本文・コメント・受け入れ条件を読み、関連するコードを Grep / Glob で確認して、次を見積もる。
- 変更行数 (追加+削除)、変更ファイル数
- またがる層・領域: スキーマ/マイグレーション、バックエンド、フロントエンド、インフラ/CI、ドキュメント/テスト基盤など、独立してレビューできる単位
- 破壊的変更 (公開 API・スキーマ・設定形式) の有無
- 独立して検証できる受け入れ条件の数

## 2. 「変更範囲が大きい」の基準
次の A を1つでも満たす、または B を2つ以上満たすなら大規模。

| 区分 | 条件 |
|---|---|
| A (単独で大規模) | 見込み変更行数 ${cfg.maxLines} 以上 |
| A | 見込み変更ファイル数 ${cfg.maxFiles} 以上 |
| A | ${cfg.maxLayers} つ以上の層・領域にまたがる |
| A | 破壊的変更 (マイグレーション、公開 API・設定形式の変更) を含み、かつ他の変更と同居する |
| B (複合で大規模) | 見込み変更行数 ${softLines} 以上 |
| B | 見込み変更ファイル数 ${softFiles} 以上 |
| B | リファクタリングと機能追加が同居する |
| B | 独立して検証できる受け入れ条件が3つ以上ある |
| B | 新規依存の追加を含む |

大規模でないもの (変更行数 ${softLines} 未満かつファイル数 ${softFiles} 未満かつ単一層) は、通常の単一 PR で進める。Stack PR にしない。

見積もりは着手前に Issue 番号・各項目の値・判定 (大規模 / 通常) を1つの表で示す。実装中に実際の差分が基準を超えたら、その時点で再判定して Stack PR に切り替える。

## 3. Stack PR への分割
大規模と判定したら、レビュー可能な最小の層に分割する。
- 各層は単独でビルド・テストが通ること。下の層から順に積み、上の層は下の層を前提にしてよい。
- 1層の目安は変更行数 ${softLines} 以下、ファイル数 ${softFiles} 以下。
- 典型的な順序: 基盤 (型・スキーマ・リファクタ) → コアのロジック → 呼び出し側 (API・UI) → テスト・ドキュメントの仕上げ。
- 各層の「内容」「完了条件」を決めてから実装に入る。層が互いに独立なら SubAgent に並列で任せてもよいが、gh stack の操作 (add / submit / rebase / sync) は1つのチェックアウトで直列に行う。

## 4. gh stack の手順
1. \`gh stack init <最下層ブランチ>\` でスタックを作る (既存ブランチを積むなら \`gh stack init <下> ... <上>\`)。ベースは既定ブランチ。
2. 最下層を実装し、テストを通してから \`gh stack add -Am "<コミットメッセージ>" <次の層のブランチ>\` で次の層へ進む。以降、層ごとに繰り返す。
3. 全層が揃ったら \`gh stack view --short\` で構成を確認し、\`gh stack submit --auto\` で PR を作る。--auto で作られる PR はドラフトで、タイトルが自動生成になる。各 PR のタイトルを \`gh pr edit\` で「[n/N] 内容」の形に直し、本文にスタック内の位置・依存と Issue 番号を書く。Issue 番号は、最上層の PR だけ \`Closes #<番号>\`、それ以外は \`Refs #<番号>\` とする。
4. 下の層を修正したら \`gh stack rebase\` で上の層へ反映し、\`gh stack push\` で更新する。リモート側が進んだら \`gh stack sync\`。
5. rebase が衝突したら解消して \`gh stack rebase --continue\`。解消できなければ \`gh stack rebase --abort\` で元に戻し、ユーザーに報告する。

## 5. 守ること
- PR のマージ、ドラフト解除 (\`--open\`)、スタックの削除 (\`gh stack unstack\`)、\`gh stack merge\` は、ユーザーが明示的に求めるまで実行しない。
- 他人のブランチや既定ブランチへの force push はしない。\`gh stack push\` / \`sync\` が使う --force-with-lease の範囲に留める。
- 各層のコミット前に、その層のテストとリンターを実行する。通らない層を積み上げない。
- 完了報告には、スタックの構成 (\`gh stack view --short\` の出力)、各 PR の URL、各層のテスト結果、未解決事項を含める。
</stack-pr-playbook>`
}
