# repo-storage-manager

ローカルに溜まった Git リポジトリと生成物 (`node_modules` / `target` など) の容量・活動状況・保全リスクを**読み取り専用**で解析する。Issue #28 の MVP (読み取り専用の解析) にあたり、削除・移動・アーカイブ・`git fetch` / `push` は行わない。

| 入口 | 中身 |
|---|---|
| `/repo-storage` | 解析して上位N件のレポートを返す |
| `mcp__repo-storage-manager__scan_repos` | モデル向けの解析ツール。引数は後述 |
| `mcp__repo-storage-manager__plan_preservation` | 整理・退避の**計画だけ**を作る (Dry Run)。何も実行・変更しない |

## 出力

- リポジトリごとに path、使用量、見かけサイズ (gdu 利用時のみ)、最終コミット日、分類と理由コード、nested の親、生成物候補を出す。
- 分類は `PROTECTED` / `DIRTY` / `UNKNOWN` / `CANDIDATE`。`CANDIDATE` は「古く、ローカル検査を通った」という意味で、**削除許可ではない**。リモートの到達性は検証しないため、理由に `REMOTE_UNVERIFIED` を残す。
- JSON のスキーマは `repo-storage-report-1` (`readOnly: true`、`degraded`、`counts`、`repos[]`)。仕様と判定順は [docs/schema.md](docs/schema.md)。
- ツールの引数: `sort`、`format`、`category` (分類で絞る)、`min_bytes`、`stale_only`。
- 容量の合計を「回収可能量」とは表示しない。親子・hardlink・symlink の重複を除けないため。

### 理由コード

| 分類 | コード |
|---|---|
| PROTECTED | `CURRENT_DIR` `LINKED_WORKTREE` `BARE_REPO` `SUBMODULE` `EXTRA_WORKTREE` `RECENT` |
| DIRTY | `UNCOMMITTED` `UNTRACKED` `UNPUSHED` `NO_UPSTREAM` `STASH` `DETACHED_HEAD` |
| UNKNOWN | `GIT_FAILED` `NO_COMMITS` |
| CANDIDATE | `STALE` `REMOTE_UNVERIFIED` |

同じリポジトリを指す複数のパス (symlink 経由・二重登録) は git の common-dir で 1 件にまとめ、まとめた分は縮退として報告する。linked worktree は本体と別に列挙せず保護する。git のコマンドが 1 つでも失敗したら `UNKNOWN` にし、安全とは判定しない。追加の worktree を持つリポジトリ、現在の作業ディレクトリを含むリポジトリ、bare・submodule は保護側に倒す。

## 使う外部ツール

| ツール | MVP での扱い |
|---|---|
| git | 必須。status / worktree / stash / ブランチの upstream / 最終コミットの一次確認。最終判定はこのプラグインの保守的なポリシーで行う |
| ghq | あれば `ghq list -p` で探索。なければ `scan_roots` にフォールバックし、縮退を報告する |
| gdu | あれば `-o -` の ncdu 互換 JSON から使用量と見かけサイズを取る。なければ `du -sk -x` (使用量のみ) |
| reposcan / gst / ward | **呼び出さない**。reposcan は JSON の契約が未確認で匿名統計を既定で送る、gst は機械可読な出力が無く書き込み系を含む、ward は `--execute` を持つため #38 で再評価。詳細は [docs/cli-survey.md](docs/cli-survey.md) |

子プロセスは argv 配列で実行し (シェル結合なし)、タイムアウトを付ける。外部出力の制御文字は表示前に無害化する。

## 生成物候補

リポジトリ直下の `node_modules` / `target` / `.next` / `dist` / `build` / `.venv` / `__pycache__` / `.gradle` を候補にし、次の 3 つに分類して根拠と再生成方法を示す。使用量はリポジトリ本体に含まれるため、合算しない。

| 分類 | 条件 |
|---|---|
| `REGENERABLE_LIKELY` | gitignore 済みで、追跡ファイルを含まず、再生成の根拠になる設定ファイル (`package.json`、`Cargo.toml` など) がある。「再生成できそう」であって削除許可ではない |
| `UNKNOWN_REGEN` | gitignore されていない、判定に失敗、設定ファイルが無い、`dist` / `build` のように名前だけでは判断できない |
| `PROTECTED_DATA` | git の追跡対象のファイルを含む |

## 保全の計画 (`plan_preservation`)

`paths` (絶対パスの配列)、`operation`、`destination` を渡すと、対象・推定回収量・実行予定・復元リハーサル・manifest 案を出す。**手順は表示だけで実行しない**。

- `cache-only`: `REGENERABLE_LIKELY` の生成物だけが対象。
- `archive`: `git bundle --all` の作成のみ (元は残る)。`relocate`: 退避。元の削除は別操作・別承認。どちらも `CANDIDATE` のみ。
- 退避先が同じファイルシステムなら「空き容量は増えない」と表示する。判定できないときは回収量を不明にする。
- 退避先が存在しない・書き込めないなど復元を確認できない計画は `EXCLUDED` にする。
- `UNKNOWN`、現在の作業ディレクトリは除外する。
- ward は未実査のため使わない。手順は git の bundle で組み立てた案で、実機での復元リハーサルは未確認。
- 実行には、対象ごとの明示承認と、実行直前の再検査が必要 (#39 で別 PR)。

## ツールの引数

設定ファイル (userConfig) は持たず、すべて `scan_repos` の引数で呼び出しごとに指定する。範囲外の値は丸め、絶対パスでない `scan_roots` は無視する。`/repo-storage` は引数を取らず、既定値で実行する。

| 引数 | 既定値 | 内容 |
|---|---|---|
| `scan_roots` | なし | ghq 管理外で探索する絶対パスの配列 |
| `max_depth` | `3` | scan_roots 配下で `.git` を探す深さ (1〜8) |
| `max_repos` | `200` | 解析する上限 (1〜2000)。超えた分は件数のみ報告 |
| `stale_days` | `180` | 古いとみなす日数。候補抽出の条件にすぎない |
| `top_n` | `20` | レポートに載せる件数 (1〜200) |
| `sort` / `format` / `category` / `min_bytes` / `stale_only` | 上記参照 | 並び順・出力形式・絞り込み |

## 導入

```
brew install ghq gdu
/plugin install repo-storage-manager@utakata-cc-mod
```

## 制約と未対応

- 生成物候補はリポジトリ直下のディレクトリ名 (`node_modules` など) の一致のみ。名前だけで安全とは断定せず、gitignore 済みかを併記する。
- 稼働中の別セッションの作業ディレクトリは検出しない (現在のディレクトリのみ)。session-guard / workspace-isolation との連携は今後。
- リモートの到達性は検証しない。ネットワークを使う操作はしない。
- ghq-pane との共通化は未実施。プラグイン間でコードを共有する仕組み (shared の同期) が必要で、ghq-pane の表示を壊すリスクがあるため、ghq-pane は変更していない。重複排除と worktree の扱いは本プラグイン側で実装している。
- `git` 2.31 以上が必要 (`rev-parse --path-format=absolute`)。古い場合は UNKNOWN になる。
- 承認付きの実際の整理・退避 (#39) は未実装。

## 実装と検証

純粋ロジックは [hooks/policy.ts](hooks/policy.ts)、子プロセス基盤 (argv 検証・出力上限・バージョン検査・JSON 検証) は [hooks/runner.ts](hooks/runner.ts)、スキャン本体は [hooks/register.ts](hooks/register.ts)、テストは [hooks/register.test.ts](hooks/register.test.ts)。検証は `claude plugin validate` / `claude plugin test` で行う。

[プラグイン一覧へ戻る](../../README.md)
