# repo-storage-manager

ローカルに溜まった Git リポジトリと生成物 (`node_modules` / `target` など) の容量・活動状況・保全リスクを解析し、利用者の**明示承認があるときだけ**整理・退避する。

- 解析 (`/repo-storage`、`scan_repos`) と計画 (`plan_preservation`) は**読み取り専用**で、削除・移動・`git fetch` / `push` は行わない。
- 実行系 (`execute_preservation` / `purge_preservation` / `restore_preservation`) は承認・再検査・ジャーナルを経てだけ変更する。詳細は「承認付きの実行」。

| 入口 | 中身 |
|---|---|
| `/repo-storage` | 解析して上位N件のレポートを返す |
| `mcp__repo-storage-manager__scan_repos` | モデル向けの解析ツール。引数は後述 |
| `mcp__repo-storage-manager__plan_preservation` | 整理・退避の**計画だけ**を作る (Dry Run)。何も実行・変更しない。`plan_id` (RSM-...) を返す |
| `mcp__repo-storage-manager__execute_preservation` | 計画を実行する。`dry_run` が既定 `true`。`false` には承認が必要 |
| `mcp__repo-storage-manager__purge_preservation` | 退避済みのものを削除して容量を回収する。承認が必要 |
| `mcp__repo-storage-manager__restore_preservation` | 退避したものを元に戻す |

## 出力

- リポジトリごとに path、使用量、見かけサイズ (gdu 利用時のみ)、最終コミット日と最終活動 (reflog を含む)、分類と理由コード、nested の親、生成物候補を出す。
- 分類は `PROTECTED` / `DIRTY` / `UNKNOWN` / `CANDIDATE`。`CANDIDATE` は「古く、ローカル検査を通った」という意味で、**削除許可ではない**。リモートの到達性は検証しないため、理由に `REMOTE_UNVERIFIED` を残す。
- JSON のスキーマは `repo-storage-report-1` (`readOnly: true`、`degraded`、`counts`、`repos[]`)。仕様と判定順は [docs/schema.md](docs/schema.md)。
- ツールの引数: `sort`、`format`、`category` (分類で絞る)、`min_bytes`、`stale_only`。
- 容量の合計を「回収可能量」とは表示しない。親子・hardlink・symlink の重複を除けないため。

### 理由コード

| 分類 | コード |
|---|---|
| PROTECTED | `CURRENT_DIR` `LINKED_WORKTREE` `BARE_REPO` `SUBMODULE` `EXTRA_WORKTREE` `RECENT` |
| DIRTY | `UNCOMMITTED` `UNTRACKED` `UNPUSHED` `NO_UPSTREAM` `STASH` `DETACHED_HEAD` `SIGNAL_CONFLICT` |
| UNKNOWN | `GIT_FAILED` `NO_COMMITS` |
| CANDIDATE | `STALE` `REMOTE_UNVERIFIED` |

同じリポジトリを指す複数のパス (symlink 経由・二重登録) は git の common-dir で 1 件にまとめ、まとめた分は縮退として報告する。linked worktree は本体と別に列挙せず保護する。git のコマンドが 1 つでも失敗したら `UNKNOWN` にし、安全とは判定しない。追加の worktree を持つリポジトリ、現在の作業ディレクトリを含むリポジトリ、bare・submodule は保護側に倒す。

## 使う外部ツール

| ツール | MVP での扱い |
|---|---|
| git | 必須。status / worktree / stash / ブランチの upstream / 最終コミットの一次確認。最終判定はこのプラグインの保守的なポリシーで行う |
| ghq | あれば `ghq list -p` で探索。なければ `scan_roots` にフォールバックし、縮退を報告する |
| gdu | あれば `-o -` の ncdu 互換 JSON から使用量と見かけサイズを取る。なければ `du -sk -x` (使用量のみ) |
| reposcan | あれば**参考信号として**使う。`-f all -o json --no-telemetry` で呼び (匿名統計を送らせない)、uncommitted / 未 push / stash を報告したら CANDIDATE を DIRTY (`SIGNAL_CONFLICT`) に倒す。判定を安全側へ上げることはしない。未導入・失敗・JSON の形が違うときは判定を変えず、縮退として報告する |
| gst / ward | **呼び出さない**。gst は機械可読な出力が無く書き込み系を含むため、活動日時は git (最終コミットと reflog の新しいほう) で取る。ward は `--execute` を持つ。詳細は [docs/cli-survey.md](docs/cli-survey.md) |

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
- 実行は次の「承認付きの実行」に従う。

## 承認付きの実行

承認なしでは何も変更しない。実行は次の順で、すべてを満たすときだけ進む。

1. `plan_preservation` で計画を作り、`plan_id` を得る。
2. `execute_preservation` を `dry_run` (既定) で呼び、再検査の結果を確認する。
3. **`AskUserQuestion` で、`plan_id` と全対象パスを質問文に書いて**利用者に尋ねる。承認は質問への**実際の回答**からだけ記録され (モデルは書き込めない)、**質問ごとに**その質問自身への肯定の回答だけが有効 (別の質問への「はい」では、拒否した操作は承認されない。回答と対応づけられない質問も承認しない)。承認の対象は、肯定された質問に書かれた ID とパスだけ。**180 秒・1 回限り**で、使うと失敗しても消える。質問文に ID か対象パスが欠けていれば、承認があっても実行しない。
4. `dry_run: false` で呼ぶ。

実行直前の再検査 (TOCTOU 対策): パスの正規化 (symlink 経由・ルートでない場合は拒否)、対象が symlink でないこと、git の状態 (HEAD・status・refs・stash) と判定が計画時から変わっていないこと、稼働中の Claude セッション (`ps` + `lsof` で cwd を確認し、確認できなければ拒否) がそのリポジトリにいないこと、生成物は追跡されず gitignore 済みであること、退避先が使えること。

| 操作 | 実行内容 |
|---|---|
| `cache-only` | 生成物を `<リポジトリの親>/.rsm-trash-<id>/` へ **rename するだけ** (同一ファイルシステムのみ。コピーになる移動は拒否)。容量はまだ回収されない。途中で失敗したら退避済みのものを元に戻す |
| `archive` | `git bundle create --all` → `bundle verify` → 一時ディレクトリへの clone で ref と HEAD を照合 (復元リハーサル) → `.git` の config / hooks / info を extras tar に保全 → sha256 → manifest。一致しなければ**この実行が作ったファイルだけ**を片付けて失敗 (退避先に同名のファイルや復元リハーサル用ディレクトリが既にあれば、何も削除せず衝突として拒否)。元は残る |
| `relocate` | archive のあと、退避の直前に再検査し、元のリポジトリを退避ディレクトリへ rename。**bundle に含まれない gitignore 済みのデータ (`.env` など。再生成できる生成物を除く) が残っていれば、アーカイブも退避もせず拒否**する |

- 退避の記録 (ジャーナル) は退避ディレクトリの `journal.json`で、取引の一部として扱う。動かす前に意図 (`pending`) を書き、書けなければ何も動かさずに中止する。動かした後に確定 (`staged`) を書けなければ元に戻す。途中で止まった `pending` も、エントリごとの状態を見て `restore_preservation` で戻せる (`purge` は `staged` だけ)。`restore_preservation` はこれを読み、元の場所に何かあれば拒否する。
- 削除は `purge_preservation` だけで、承認 (`op_id` と `repo` の復唱) が必要。検証済みの退避ディレクトリに対する `rm -r -- <path>` のみを実行する (`rm -rf`、シェル経由、glob は使わない)。relocate は、アーカイブの bundle と extras が存在し、sha256 が記録と一致するときだけ。復元できない可能性があれば拒否する。
- purge の結果は、削除した退避データのサイズ (du、実測) と空き容量の変化 (df、実測。他のプロセスの影響を含む) を分けて出す。計画時の推定値とは区別する。
- 自動実行・定期実行・リモート操作・force push・GitHub リポジトリの削除はしない。

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
- worktree の解析は ghq-pane と共有している (`hooks/git-worktree/` は [shared/git-worktree](../../shared/git-worktree/parse.ts) の同梱コピーで、直接編集しない)。探索 (`ghq list -p`) と重複排除は本プラグイン側にある。ghq-pane の Pane UI との統合は未実施。
- `git` 2.31 以上が必要 (`rev-parse --path-format=absolute`)。古い場合は UNKNOWN になる。
- 承認付き実行は、実機 (macOS を含む) での検証が未了。テストは模擬した `process.run` / ファイルシステムの上で、承認・再検査・失敗・部分失敗・rm の引数を確認している。
- `ps` / `lsof` が無い環境では実行を拒否する (fail-closed)。ward は使わない。
- 退避ディレクトリはリポジトリの親に作るため、親に書き込めない場合は実行できない。
- ホームディレクトリ外のマウントポイントを跨ぐ操作 (別ファイルシステムへの退避) は rename できないため拒否する。

## 実装と検証

純粋ロジックは [hooks/policy.ts](hooks/policy.ts)、子プロセス基盤 (argv 検証・出力上限・バージョン検査・JSON 検証) は [hooks/runner.ts](hooks/runner.ts)、スキャン本体は [hooks/register.ts](hooks/register.ts)、テストは [hooks/register.test.ts](hooks/register.test.ts)。検証は `claude plugin validate` / `claude plugin test` で行う。

[プラグイン一覧へ戻る](../../README.md)
