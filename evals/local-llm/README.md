# ローカルLLM併用の評価 (evals/local-llm)

code-finder・ctxpack-fetch・verification-gate のローカルLLM機能 (`llmMode`: `off` / `auto` / `always`) を、同じ課題で比較するための評価手順・フィクスチャ・計測レコード・レポート生成。

**効果は未測定である。** この評価は、入力を減らしても必要情報の取りこぼしによる再調査や待ち時間で効果が相殺される可能性を、節約量・品質・所要時間の3つで確かめるためにある。削減率は保証しない。自動テストの数値は配線の確認用のモックの結果で、効果の根拠にならない。実測は下記の手動手順で行い、結果を見てから [harness-profile](../../plugins/harness-profile/README.md) の推奨構成を確定する。

## 構成

| 場所 | 内容 |
|---|---|
| [cases/cases.json](cases/cases.json) | 比較ケースの定義 (入力・必要情報・誤誘導・モックの選び方) |
| [fixtures/](fixtures/) | 機密を含まない合成データ (検索結果・Web ページ・失敗ログ) |
| [schema.ts](schema.ts) | 計測レコードの形式と検証 |
| [judge.ts](judge.ts) | 必要情報の取りこぼし判定 |
| [mock-ollama.ts](mock-ollama.ts) | ollama の代役 (決定的な選択戦略) |
| [runner.ts](runner.ts) | 実際の plugin の `register.ts` を模擬エンジンで走らせ、レコードを作る |
| [ollama-control.ts](ollama-control.ts) | 実 ollama のモデルの cold / warm を操作し、`/api/ps` で観測する |
| [report.ts](report.ts) | 集計と Markdown レポート |
| [run.ts](run.ts) | 実行・レポート・手動記録の雛形のコマンド |
| [evals.test.ts](evals.test.ts) | 自動テスト |

runner は plugin の挙動 (auto の条件・返却形式・失敗時の戻り方) を再実装せず、plugin 本体の `register.ts` を [tests/integration/harness.ts](../../tests/integration/harness.ts) の模擬エンジンに載せて呼ぶ。

## ケース

| ケース | 種類 | 配置 | 必要情報 |
|---|---|---|---|
| search-tail | 検索 (code-finder `search_code`) | 関連する定義が結果の末尾。直前に似た名前の旧実装 | 関数の定義行 |
| search-similar | 検索 | `retryWithBackOff` / `retryable` など似た名前が混在。必要箇所は中間と末尾 | 呼び出し箇所と定義 |
| search-small | 検索 | 結果が小さい (auto の条件未満) | 定義行 |
| web-tail | Web 抽出 (ctxpack-fetch `fetch_page`) | 関連段落が末尾。途中に指示文の混入、似た項目 (ログの保持期間) | メッセージ保持期間の既定値 |
| web-injection | Web 抽出 | 関連段落が中間。後ろに誤った答えを促す指示文 | 最大ペイロードサイズの既定値 |
| log-head | ログ抽出 (verification-gate `verify_run`) | 原因が先頭。末尾は無関係な成功ログと要約 | エラー行と位置 |
| log-middle | ログ抽出 | 原因が中間。先頭は準備ログ、末尾はカバレッジ表 | エラー行と位置 |

各ケースは「必要情報」(`required`) を期待値として持つ。応答に残っているかを、空白の違いを無視した部分一致で判定する。誤誘導・指示文 (`distractors`) が初回の返却に混入した件数も数える。Web のフィクスチャの指示文は合成データで、URL は `.invalid` ドメインのみ。

## 自動テスト (モック・課金なし)

```sh
pnpm run test:evals        # bun test ./evals
pnpm run test:integration  # evals を含む
```

実 ollama・実 Claude は使わない。次を検証する。

- 取りこぼし判定: 必要情報が落ちたことを検出し、追加取得を含めても揃わなければ `passed: false` になる
- レコード生成: 3種類 × `off` / `auto` / `always` のレコードが形式を満たし、`auto` が条件未満の入力で通信しないこと、`off` で末尾だけを返すログが原因を落とすこと
- 集計・レポート: 試行ごとの集計、source を混ぜないこと、取得不能の理由の表示

モックの選び方 (`mock-ollama.ts`) は決定的で、実際のモデルの挙動ではない。

| 戦略 | 動作 |
|---|---|
| `oracle` | 必要情報を持つ候補だけを選ぶ |
| `head-biased` | 先頭の候補だけを選ぶ (中間・末尾を取りこぼす) |
| `bait-follower` | 誤誘導・指示文の候補を選ぶ |
| `down` | 接続先が 503 を返す (フォールバック) |
| `invalid` | 存在しない ID を返す (不正な応答としてフォールバック) |

手元でモックを走らせてレポートを見るには次を使う。結果は `evals/local-llm/out/` (コミットしない) に書く。

```sh
pnpm run eval:local-llm mock --trials 3 [--strategy head-biased] [--cases search-tail,log-head]
```

### 追加取得の模擬

初回の返却に必要情報が足りなかったとき、決まった手順で原文を取り直す。取り直しの回数と文字数をレコードに残し、取り直しを含めて必要情報が揃ったかを `passed` とする。

| 種類 | 取り直し |
|---|---|
| 検索 | 同じ入力に `raw: true` を付けて再実行 (plugin 本体を呼ぶ) |
| Web | 同じ `url` と `query` に `full: true` を付けて再実行 (plugin 本体を呼ぶ) |
| ログ | verification-gate に全文を返す手段がないため、検証コマンドの再実行を模擬して全出力を返す |

これは再調査の判断を決まった規則で置き換えたもので、実 Claude が再調査するかどうか・何回するかを表すものではない。実際の再調査は手動測定で記録する。

## 計測レコード

1 試行 1 行の JSON Lines。形式は [schema.ts](schema.ts) (`schemaVersion: 1`)。

| フィールド | 内容 |
|---|---|
| `source` | `mock` (モック) / `ollama` (実 ollama・Claude なし) / `manual` (実 Claude・手動)。集計では混ぜない |
| `caseId` `kind` `condition` `trial` | ケース、種類、`off` / `auto` / `always`、同じ条件の繰り返しの通し番号 |
| `warmth` | `ollama` と `claudeCache` の `cold` / `warm` / `not_applicable` / `unknown` |
| `environment` | Claude のモデル、ローカルLLMのモデル、ollama の URL とバージョン、plugin の設定 (`llmMode` と共通基盤の9キー)、plugin のバージョン、OS・ランタイム |
| `claude.usage` | 入力・出力・キャッシュ読込・キャッシュ書込のトークン。`source` が `measured` (本体の集計値) / `estimated` (推計) / `unavailable` (取得不能)。取得できない値は `null` で、理由を `note` に書く |
| `claude.deliveredChars` | Claude へ返したツール結果の文字数 (追加取得を含む)。計測値で、トークン数ではない |
| `claude.estimatedInputTokens` `estimateMethod` | 文字数からの推計トークン。推計の方法を必ず書く。実測とは別のフィールド |
| `timing` | `totalMs` (総所要時間)、`localLlmMs` (ollama の応答待ち) |
| `localLlm` | 通信したか、回数、結果を返却に使ったか、通信したが使えず既存の動作へ戻ったか (`fallback`)、失敗理由コード |
| `followUps` | 追加取得・再調査の回数・文字数・手順 |
| `accuracy` | 必要情報の数、初回で揃った数、初回・最終の取りこぼし、追加取得を含めた達成 (`passed`)、誤誘導の混入件数 |

`mock` と `ollama` では Claude を使わないので、`claude.usage` は `unavailable` で数値はすべて `null`、理由が `note` に入る。

## レポート

```sh
pnpm run eval:local-llm report evals/local-llm/out/*.jsonl --out evals/local-llm/out/report.md [--chars-per-token 4]
```

source ごとに節を分け、ケース × 条件で次を示す。節約量だけでなく、品質と所要時間を並べる。

- 必要情報の達成 (追加取得を含む) と、初回で揃った試行
- 追加取得の平均回数
- Claude へ返した文字数と、同じケースの `off` に対する比
- 総所要時間 (平均・中央値)、ローカルLLMの待ち時間
- ollama へ通信した / 結果を使った / フォールバックした試行数
- Claude の使用量 (実測 / 推計 / 取得不能の試行数と、取得不能の理由)

`mock` の節は「`off` に対する比」を算出しない。試行が 3 回未満の組には注意書きを付ける。`--chars-per-token` を渡すと文字数から推計トークンの列を足す (`mock` を除く)。仮定値であり、実測ではない。形式エラーのレコードは集計から外し、一覧にして示す。生成したレポートの数値はコミットしない。

## 手動評価

通常のテストとは混ぜない。ollama と、実 Claude を使う場合は Claude Code・[execution-budget](../../plugins/execution-budget/README.md) が必要になる。

### A. 実 ollama で plugin を通す (Claude なし)

ローカルLLMの待ち時間・フォールバック・取りこぼしを、実モデルで確かめる。課金は発生しないが、ollama とモデルが要る。

```sh
ollama pull tev1:4b
pnpm run eval:local-llm ollama --models tev1:4b,nimble --trials 3 --warmth cold
```

- `--warmth` は申告ではなく操作で状態を作り、観測した状態を各レコードの `warmth.ollama` に記録する。`off` の試行は通信しないので `not_applicable`。
  - `cold`: ローカルLLMを使う試行 (`auto` / `always`) の前に、`/api/generate` の `keep_alive: 0` で全モデルを解除し、`/api/ps` で解除を確かめる。
  - `warm`: 試行の前に先頭のモデルを読み込み (空のプロンプトの `/api/generate`)、`/api/ps` で読み込みを確かめる。
  - `observe` (既定): 操作せず、試行の前の `/api/ps` の状態 (先頭のモデルが読み込み済みか) を記録する。
  - 確かめられなかったとき (`/api/ps` が使えない・解除や読み込みができない) は `unknown` になる。cold / warm のどちらとも断定しない。
  - この操作は ollama の API 仕様に基づく実装で、実機での確認は未実施。
- plugin の `timeoutSeconds` / `totalTimeoutSeconds` は実時間で働く。cold のモデル読み込みが長引いてタイムアウトすれば、`fallback` の記録になる。
- 条件の順序は試行ごとに回る。`--cases` と `--conditions` で絞れる。
- 出力は `source: ollama` のレコード。Claude の使用量は `unavailable` で、Claude が再調査するかは含まない。

### B. 実 Claude での測定

実 Claude のトークン・所要時間・再調査は自動化できない。同じ課題を `llmMode` を変えて実行し、結果を記録する。

準備:

1. 比較する3本 (code-finder・ctxpack-fetch・verification-gate) と execution-budget を有効にする。
2. 同じ課題を `off` / `auto` / `always` の順を試行ごとに入れ替えて実行する。条件を変えるのは `llmMode` だけにする。モデル・プロンプト・作業ツリーの状態は揃える。
3. 各条件を 3 回以上実施する。1 回の結果から傾向を判断しない。

課題:

- ログ: [fixtures/log-head.txt](fixtures/log-head.txt) の内容を出力して失敗する検証コマンドを登録する。例: `verify_define` の `command` に `["sh","-c","cat evals/local-llm/fixtures/log-head.txt >&2; exit 1"]`。依頼は「検証が失敗した原因のエラーとその位置を答える」。必要情報は cases.json の `required`。
- 検索・Web: フィクスチャは検索結果・ページ本文の形そのもので、実リポジトリや実ページにはそのまま対応しない。自分のリポジトリやページで、ケースの配置 (関連箇所が末尾にある・似た名前がある・指示文が混入している) に合う課題を選び、必要情報を先に決めておく。ローカルページを ctxpack で取得できるかは未確認。

測り方:

- cold / warm: ollama は A と同じ。Claude のキャッシュは、新規セッションで始めた試行を cold、直前の試行と同じセッションで続けた試行を warm として記録する。キャッシュの有効期間は環境依存で、この評価では確かめていない。
- トークン: 試行の前に `/budget reset`、後に `/budget status` を実行し、「トークン: 入力 / 出力 / キャッシュ読込 / キャッシュ書込」を転記する。取得できないときは `null` にして `note` に理由を書く。費用は `/budget status` のセッション全体の値で試行単位ではないため、新規セッションで 1 試行だけ実行したときに限り参考にする。
- 所要時間: 依頼を送ってから最終回答までを計り、`timing.totalMs` に入れる。
- ローカルLLMの待ち時間・フォールバック: plugin は debug ログ (`$.ui.log` の debug) に `local-llm ok model=… ms=…` / `reason=…` を出す。debug ログの見方は環境依存で未確認。確認できなければ `localLlm` は A の結果で代用するか、`reasons` を空にして `notes` にその旨を書く。
- 再調査: 初回の返却で必要情報が足りず、原文の取り直し (検索の `raw: true`・Web の `full: true`・コマンドの再実行・Read) をした回数を `followUps.count` に数える。
- 達成: 最終回答に必要情報が揃っているかを人が判定し、`accuracy` に入れる。

記録:

```sh
pnpm run eval:local-llm template --case log-head --condition auto > evals/local-llm/out/manual.jsonl
```

雛形 (1 行の JSON) の `null`・`0`・`unknown` を埋めて、試行ごとに 1 行ずつ足す。`source` は `manual` のままにする。自前の課題のときは `caseId` と `kind` を書き換えてよい。形式は `report` コマンドが検証し、誤りは「除外したレコード」に出る。

```sh
pnpm run eval:local-llm report evals/local-llm/out/manual.jsonl --out evals/local-llm/out/report.md
```

結果を共有するときは、レポートの数値だけでなく、環境の節 (モデル・cold / warm・試行回数) とあわせて貼る。

## execution-budget との連携

[plugins/execution-budget](../../plugins/execution-budget/README.md) のコードを読んで確認した範囲。

| 情報 | 現在取得できるか |
|---|---|
| Claude のトークン (入力・出力・キャッシュ読込・キャッシュ書込・モデル別の入力と出力) | 取得できる。`turn.complete` の `usage` を集計し、`/budget status` に出る。ホストが `usage` を渡したターンだけの集計で、渡されなかったターンは数えない (「取得できたターンのみ」と表示される)。実セッションで全ターンに `usage` が付くかは未確認 |
| `/budget log` のトークン | 入力・出力のみ。キャッシュ値は `/budget status` の累計にしか出ない |
| 費用 | セッション全体の USD (ホストの集計)。ゴール単位・試行単位ではない。ホストが集計していなければ「不明」 |
| 試行単位の区切り | `/budget reset` で新しい予算区間を作り、使用量を 0 から数え直せる。自動では区切らない (手動で試行ごとに実行する) |
| SubAgent の起動数・再試行数・経過時間 | 取得できる。ただし SubAgent の起動に限る。再試行は同じ種類・説明・本文の起動の回数で、ツールの取り直しや再調査は数えない |
| compaction 前後のトークン | 取得できる (`/budget log`) |
| ツール結果・plugin ごとのトークン | 取得できない。ターンの合計しか持たず、どのツールの結果が入力に入ったかは分からない |
| ローカルLLMの待ち時間・フォールバック | 取得できない。基盤は debug ログに出すだけで、execution-budget の保存先には入らない |
| 再調査の回数・必要情報の取りこぼし | 取得できない |
| 機械可読な出力 | ない。`/budget status` と `/budget log` のテキスト表示のみ |

追加の実装が必要なもの (本評価では実装していない): ローカルLLMの結果 (待ち時間・フォールバック理由) を execution-budget の診断ログへ渡す経路、ツール結果ごとの使用量の帰属、試行ごとの自動区切り。いずれも、取得できない間は手動記録 (`claude.usage` の `null` と `note`) で補う。
