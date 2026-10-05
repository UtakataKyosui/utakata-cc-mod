# change-review

実装者とは別のSubAgentへ差分レビューを依頼する手順と、レビュー回数・報告形式・書き込み操作の制御を提供する。

## 使い方

モデルに `subagent_type: change-review:reviewer` でAgentを起動させ、要求と受け入れ条件、差分の取り方、検証結果、触ってはいけない範囲を渡す。フック自身が自動でレビュアーを起動するわけではない。

```text
/change-review
/change-review reset
```

最初のコマンドはレビュー状況と省略可否を表示する。resetはセッション内の回数・報告状態を初期化する。

## レビューの扱い

初回と既定2回の再レビューを許可し、上限以降のレビュアー起動は拒否する。既定では2ファイル以下かつ追加・削除30行以下の変更は省略できる。認証・権限・秘密情報・削除を伴う変更は小さくても省略しないようモデルへ指示する。

指摘の書式:

```text
- [major] src/example.ts:12 | 指摘内容 | 根拠: コードから判断できる理由
確認範囲: 読んだ差分とファイル、確認できなかったこと
判定: 要修正
```

重要度はblocker / major / minor / nit。修正は実装側で行い、完了報告にはレビューの実施・省略・未実施と未解決指摘を記載する。

## ローカルLLMによる一次点検 (任意)

`llmMode` を `auto` または `always` にすると、読み取り専用ツール `mcp__change-review__precheck_diff` が使える。plugin が固定の `git diff` を実行し、要求・受け入れ条件・検証結果とともに上限付きでローカルLLM (ollama) へ渡して、重点確認箇所の候補を得る。既定の `off` ではツールを登録せず、通信もしない。

| 引数 | 内容 |
|---|---|
| `request` | ユーザーの要求 |
| `acceptance` | 受け入れ条件 |
| `verification` | テスト・型検査・lint などの検証結果 |
| `staged` | `true` でステージ済みの差分を対象にする |
| `range` | git の範囲 (例: `main...HEAD`)。省略すると `HEAD` との差分 |

返す内容:

- 確認範囲: ローカルLLMへ送ったファイルと行
- 未確認範囲: 入力の上限 (`maxInputChars`) で切り詰めた部分、送れなかったファイル、バイナリ・削除など対象外のファイル、未追跡ファイル
- 候補指摘: ファイル・行・引用・根拠。ファイルが差分にあること、行が送った範囲にあること、引用が差分に存在すること、根拠があることだけを検証する。実在しない候補は除外し、件数と理由だけ示す。内容の正しさは検証しない
- 原差分の取得コマンド: reviewer が自分で差分を読むために渡す

使い分け:

| | 一次点検 | 正式レビュー |
|---|---|---|
| 担い手 | ローカルLLM | `change-review:reviewer` SubAgent |
| 役割 | 重点確認箇所の絞り込み (参考データ) | 正しさ・回帰・セキュリティの判定 |
| レビューへの計上 | 数えない | 回数に数え、報告形式を検証する |
| 指摘なしの扱い | 問題がない証拠ではない。省略や合格の根拠にしない | `判定: 指摘なし` として扱う |

一次点検の記録はレビューの記録と別に持ち、`/change-review` に併記する。一次点検だけではレビュー完了にならず、省略条件・再レビュー回数の上限・報告形式は変わらない。候補は reviewer への依頼へ「未検証の参考データ」として添え、reviewer は原差分を確認して判断する。

ollama へ送る入力は差分を含むため、送信は trust-boundary の対象になる。ollama への接続失敗・タイムアウト・不正な応答・入力の上限超過のときは、一次点検が実施されなかった旨を返し、既存のレビュー手順をそのまま続ける。`auto` では省略できない規模の変更 (`skipMaxFiles` / `skipMaxLines` 超) のときだけ試す。診断ログにはコードも差分も残さない。

## 制約と連携

レビュアーのWrite / Edit / NotebookEditと、検出できた状態変更Bashを拒否する。Bash検査は正規表現による近似で、完全な読み取り専用サンドボックスではない。指摘の形式検証は指摘の正しさや実在行を保証しない。

省略可否のコマンドは `git diff --shortstat HEAD` を使うため、未追跡ファイルは含まれない。状態はメモリ内で管理し、永続化しない。[verification-gate](../verification-gate/README.md) の結果はレビュアーへの依頼に明示的に含める。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install change-review@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `skipMaxFiles` | number | `2` | 変更ファイル数と変更行数の両方がこの上限以下なら、レビューを省略してよい。0 にすると省略しない 範囲: 0〜100。 |
| `skipMaxLines` | number | `30` | 追加行と削除行の合計がこの値以下なら、ファイル数の条件と合わせてレビューを省略してよい。0 にすると省略しない 範囲: 0〜5000。 |
| `maxReReviews` | number | `2` | 初回レビューを除く、修正後の再レビューの上限。超えたレビュアーの起動は拒否し、未解決の指摘を完了報告に書かせる 範囲: 0〜10。 |
| `llmMode` | string | `"off"` | `off` / `auto` / `always`。一次点検の利用モード |
| `ollamaUrl` | string | `"http://localhost:11434"` | ollama サーバーのベース URL |
| `models` | string | `"tev1:4b,nimble"` | 先頭から試すモデルの優先順 (カンマ区切り) |
| `timeoutSeconds` | number | `30` | 1 モデルあたりのタイムアウト。範囲: 5〜120 |
| `totalTimeoutSeconds` | number | `60` | 全モデル合計の待ち時間の上限。範囲: 5〜600 |
| `maxAttempts` | number | `2` | 試すモデルの最大数。範囲: 1〜10 |
| `keepAlive` | string | `"1m"` | ollama の keep_alive |
| `maxInputChars` | number | `12000` | モデルへ送る入力の上限 (文字数)。差分はこの範囲に切り詰める。範囲: 500〜200000 |
| `maxOutputChars` | number | `4000` | モデルの出力の上限 (文字数)。範囲: 200〜100000 |


## 実装と検証

共通のローカルLLM基盤は [shared/local-llm](../../shared/local-llm/README.md) を `hooks/local-llm/` に同梱している。動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

