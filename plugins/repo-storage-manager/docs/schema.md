# レポートのスキーマと安全性ポリシー (Issue #30)

型の実体は [hooks/policy.ts](../hooks/policy.ts)、語彙は [hooks/types.ts](../hooks/types.ts)、サンプルは [fixtures/report-sample.ts](../fixtures/report-sample.ts)。契約テストがサンプルと語彙の一致を検査する。

## `repo-storage-report-1`

| フィールド | 意味 |
|---|---|
| `schema` | 固定値 `repo-storage-report-1`。互換を壊す変更で番号を上げる |
| `readOnly` | 常に `true` |
| `degraded` | 縮退動作と絞り込みの説明。空なら全 CLI が使えた |
| `totalDiscovered` / `analyzed` / `skipped` | 発見数、解析数、`maxRepos` で解析しなかった数 |
| `counts` | 分類ごとの件数 (絞り込み前) |
| `repos[].verdict` | `category` と `reasons[]` (理由コード) |
| `repos[].usageBytes` / `apparentBytes` | 使用量と見かけサイズ。不明は省略 (0 にしない)。`sizeSource` が `gdu` / `du` / `unavailable` |
| `repos[].nestedIn` | 別リポジトリの配下にあるときの親。容量は親に含まれ得るため合算しない |
| `repos[].caches[]` | 生成物ディレクトリ候補。`class` (`REGENERABLE_LIKELY` / `UNKNOWN_REGEN` / `PROTECTED_DATA`)、`evidence`、`regen`、`ignored`、`tracked` を持つ |

「回収可能量」「削除可」を表すフィールドは意図的に持たない。

## 判定 (deny-by-default)

評価は上から順で、最初に当たったものが結果になる。

1. `PROTECTED`: 現在の作業ディレクトリを含む、linked worktree、bare、submodule あり、追加 worktree あり
2. `UNKNOWN`: git のコマンド (submodule の確認を含む) が 1 つでも失敗、または stash 数が取れない
3. `DIRTY`: 未コミット、未追跡、未 push、upstream 無しのブランチ、stash
4. `UNKNOWN`: コミットが無い
5. `CANDIDATE`: `staleDays` 以上更新が無い (`STALE` + `REMOTE_UNVERIFIED`)
6. `PROTECTED`: それ以外 (`RECENT`)

`CANDIDATE` は「この後の確認に回す候補」で、削除・退避の許可ではない。古さ (`staleDays`) は候補の抽出条件にすぎない。承認付き操作 (#39) は、実行直前に本ポリシーを再評価し、結果が変わっていれば拒否する前提で別 PR で設計する。

## 状態遷移 (1 回のスキャン内)

発見 → 観測 (git / サイズ) → 分類 → 報告。観測に失敗した項目は `UNKNOWN` に落ち、`CANDIDATE` へは決して上がらない。

## 保全計画 `repo-preservation-plan-draft-1`

`plan_preservation` の出力。`dryRun` は常に `true`。各 `items[]` は `operation` (`cache-only` / `archive` / `relocate`)、`status` (`PLANNED` / `EXCLUDED`)、`excluded[]` (除外理由コード)、`estimatedReclaimBytes` (推定。実測ではない)、`sameFilesystem`、`steps` (表示のみ)、`restoreRehearsal`、`manifest` (案)、`requiresBeforeExecution`、`unconfirmed` を持つ。`PLANNED` は「承認を求める準備ができた」という意味で、実行許可ではない。名前に `draft` を付けているのは、実機での復元リハーサルが確認できるまで互換性を保証しないため。
