# repo-storage-manager

ローカルに溜まった Git リポジトリと生成物 (`node_modules` / `target` など) の容量・活動状況・保全リスクを**読み取り専用**で解析する。Issue #28 の MVP (読み取り専用の解析) にあたり、削除・移動・アーカイブ・`git fetch` / `push` は行わない。

| 入口 | 中身 |
|---|---|
| `/repo-storage` | 解析して上位N件のレポートを返す |
| `mcp__repo-storage-manager__scan_repos` | モデル向けツール。`sort` (`size` / `activity` / `risk`) と `format` (`text` / `json`) を渡せる |

## 出力

- リポジトリごとに path、使用量、見かけサイズ (gdu 利用時のみ)、最終コミット日、分類と理由コード、nested の親、生成物候補を出す。
- 分類は `PROTECTED` / `DIRTY` / `UNKNOWN` / `CANDIDATE`。`CANDIDATE` は「古く、ローカル検査を通った」という意味で、**削除許可ではない**。リモートの到達性は検証しないため、理由に `REMOTE_UNVERIFIED` を残す。
- JSON のスキーマは `repo-storage-report-1` (`readOnly: true`、`degraded`、`counts`、`repos[]`)。
- 容量の合計を「回収可能量」とは表示しない。親子・hardlink・symlink の重複を除けないため。

### 理由コード

| 分類 | コード |
|---|---|
| PROTECTED | `CURRENT_DIR` `BARE_REPO` `SUBMODULE` `EXTRA_WORKTREE` `RECENT` |
| DIRTY | `UNCOMMITTED` `UNTRACKED` `UNPUSHED` `NO_UPSTREAM` `STASH` |
| UNKNOWN | `GIT_FAILED` `NO_COMMITS` |
| CANDIDATE | `STALE` `REMOTE_UNVERIFIED` |

git のコマンドが 1 つでも失敗したら `UNKNOWN` にし、安全とは判定しない。追加の worktree を持つリポジトリ、現在の作業ディレクトリを含むリポジトリ、bare・submodule は保護側に倒す。

## 使う外部ツール

| ツール | MVP での扱い |
|---|---|
| git | 必須。status / worktree / stash / ブランチの upstream / 最終コミットの一次確認。最終判定はこのプラグインの保守的なポリシーで行う |
| ghq | あれば `ghq list -p` で探索。なければ `scanRoots` にフォールバックし、縮退を報告する |
| gdu | あれば `-o -` の ncdu 互換 JSON から使用量と見かけサイズを取る。なければ `du -sk -x` (使用量のみ) |
| reposcan / gst / ward | **MVP では呼び出さない**。出力契約をこの環境で実査できていないため、推測で実装していない。#29 の調査後に別 PR で追加する |

子プロセスは argv 配列で実行し (シェル結合なし)、タイムアウトを付ける。外部出力の制御文字は表示前に無害化する。

## 設定

| 項目 | 既定値 | 内容 |
|---|---|---|
| `scanRoots` | 空 | ghq 管理外で探索する絶対パス (カンマ区切り) |
| `maxDepth` | `3` | scanRoots 配下で `.git` を探す深さ |
| `maxRepos` | `200` | 解析する上限。超えた分は件数のみ報告 |
| `staleDays` | `180` | 古いとみなす日数。候補抽出の条件にすぎない |
| `topN` | `20` | レポートに載せる件数 |

## 導入

```
brew install ghq gdu
/plugin install repo-storage-manager@utakata-cc-mod
```

## 制約と未対応

- 生成物候補はリポジトリ直下のディレクトリ名 (`node_modules` など) の一致のみ。名前だけで安全とは断定せず、gitignore 済みかを併記する。
- 稼働中の別セッションの作業ディレクトリは検出しない (現在のディレクトリのみ)。session-guard / workspace-isolation との連携は今後。
- リモートの到達性は検証しない。ネットワークを使う操作はしない。
- ghq-pane との共通化 (discovery・worktree 解析) は未実施。`parseWorktrees` は ghq-pane と同じ解釈で、共通化は別 PR で行う。
- 承認付きの整理・退避 (#38 / #39) は別 PR。

## 実装と検証

純粋ロジックは [hooks/policy.ts](hooks/policy.ts)、プロセス実行は [hooks/register.ts](hooks/register.ts)、テストは [hooks/register.test.ts](hooks/register.test.ts)。検証は `claude plugin validate` / `claude plugin test` で行う。

[プラグイン一覧へ戻る](../../README.md)
