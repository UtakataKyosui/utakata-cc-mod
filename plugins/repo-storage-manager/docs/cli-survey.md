# 外部CLIの調査 (Issue #29)

調査は各プロジェクトの公開 README (2026-11-20 時点の既定ブランチ) を読んだ結果で、**実CLIは実行していない** (reposcan の JSON 形式のみ公開ソースの型定義で確認)。したがって fixtures は実機の出力ではなく、文書化された形式から手で作ったサンプルで、`fixtures/` の各ファイル先頭にそう明記している。最低対応バージョンは実機で検証するまで設定しない (`probe` は存在と解析可否のみを見る)。ghq は README を取得できなかったため、既存の `ghq-pane` が使っているコマンドだけを根拠にしている。

| ツール | 使えるもの (README 記載) | 採否 | 理由と方針 |
|---|---|---|---|
| git | porcelain v2 の status、`worktree list --porcelain`、`for-each-ref`、`stash list`、`log` | **採用 (必須)** | 一次確認。最終判定はこのプラグインのポリシー |
| ghq | `ghq list -p`、`ghq root --all` (ghq-pane が使用) | **採用 (任意)** | 無ければ `scan_roots`。縮退を報告 |
| gdu | `-n -p -o -` の ncdu 互換 JSON、`-x` (別マウントを跨がない)、`--output-attrs`。ディレクトリ合計は新しい版で `gdu_asize` / `gdu_dsize`、古い版で `asize` / `dsize`。読めないディレクトリは `read_error: true` | **採用 (任意)** | 使用量と見かけサイズ。新旧形式を区別して二重計上を防ぐ (`parseNcdu`)。無ければ `du -sk -x` |
| reposcan | `-r ROOT`、`-f all\|dirty\|uncommitted\|unpushed\|unpulled\|stash`、`--stale-days`、`-o json`、`--json-output-path`、`--no-telemetry`。git と jj を扱う。JSON は公開型 `pkg/report` の `ScanReport` (`version`、`repoStates[]`: `path` / `vcsType` / `uncommitedFiles` / `remoteStatus[]` (`ahead` / `behind`) / `stashes`、`warnings`)。Go の nil slice は `null` で出る | **採用 (任意・参考信号のみ)** | 形式はソース (公開型のタグ) で確認した。**匿名の利用統計 (mixpanel) を既定で送るため、必ず `--no-telemetry` を付ける**。uncommitted / 未 push / stash を報告したら CANDIDATE を DIRTY に倒すだけで、判定を安全側へ上げることはしない。未導入・失敗・形が違うときは縮退として報告し、判定は変えない。`--version` の有無は未確認 (存在確認は `reposcan --version` の終了コードで行い、127 または実行失敗のみ未導入と扱う) |
| gst | `gst list` / `--short` は人向けの出力のみ。`rm` `update` `fetch` `new` を持つ | **不採用** | 機械可読な出力が無い。`rm` / `update` / `fetch` は書き込みを伴うため、呼び出し面積に含めない。活動日時は git から取る: `git log -1` (最終コミット) と `git log -g -1 --date=unix --format=%gd HEAD` (reflog の最新エントリの時刻。checkout・pull など、コミット以外の利用。`%ct` は -g を付けてもコミット日時を返すため使えない) の新しいほう |
| ward | `scan --json`、`archive` (既定 dry-run、`--execute` で実行)、`restore --verify`、`clean`、`sweep`。bundle + extras tar + manifest、clone による検証。MIT | **MVP では不採用 (#38 で再評価)** | JSON のスキーマは README に無い。`--execute` を持つため、読み取り専用の MVP では呼ばない。#38 では `scan --json` と `archive` (dry-run のみ) を実機の出力で確認してから採否を決める |

## 横断方針

- 未導入・失敗・解析不能・出力過大・タイムアウトは、いずれも「安全」とは判定せず UNKNOWN か縮退として報告する (`runner.ts`)。
- 装飾された TUI 出力は解析しない。構造化出力があるものだけを対象にする。
- 外部ツールが外部へ通信するもの (reposcan の統計) は、無効化フラグが確認できるまで呼ばない。

## 未了

- 実機での出力採取、最低対応バージョン、終了コード表。reposcan / ward の JSON スキーマ確認が済んだ時点で fixtures を実機の出力に差し替える。
