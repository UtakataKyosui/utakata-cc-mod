# ctxpack-fetch

WebFetch を禁じ、代わりに [ctxpack](https://github.com/atani/ctxpack) で Web ページを取得するツールをモデルに提供する。ctxpack はページからノイズを除いたコンパクトな Markdown を返す CLI。

| ツール | 中身 | 引数 |
|---|---|---|
| `mcp__ctxpack-fetch__fetch_page` | `ctxpack <url> [--query <キーワード>]` を実行する | `url`（http / https）、`query`、`full`、`parts` |

- 起動時に `ctxpack` の有無を調べ、入っているときだけツールを登録して WebFetch を拒否する。入っていないときは WebFetch をそのまま使える。
- URL は http(s) のみ受け付ける。コマンドはシェルを通さず argv で実行する。
- `query` を渡すと、関連するセクションが先頭に来る。
- `query` を渡し、ローカルLLMの抽出を有効にすると、関係する段落だけを出典付きで返す（[抽出モード](#抽出モード)）。
- 返す文字数の上限は userConfig の `maxChars`（既定 60000）で変更できる。
- システムプロンプトにも WebFetch の代わりに `fetch_page` を使う案内を足す。

## 導入

```
brew install atani/tap/ctxpack
/plugin install ctxpack-fetch@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `maxChars` | number | `60000` | 1 回の取得で返す文字数の上限。超えた分は切り捨てて全体の文字数だけ伝える 範囲: 1000〜400000。 |
| `llmMode` | string | `off` | 抽出モード。`off` / `auto` / `always` |
| `ollamaUrl` `models` `timeoutSeconds` `totalTimeoutSeconds` `maxAttempts` `keepAlive` `maxInputChars` `maxOutputChars` | | | ローカルLLMの共通設定。意味・既定値・範囲は [shared/local-llm](../../shared/local-llm/README.md#設定キー) を参照 |


## 抽出モード

長いページから `query` に関係する段落だけをローカルLLM（ollama）で選び、出典と原文を保持したまま返す。

| `llmMode` | 動作 |
|---|---|
| `off`（既定） | ollamaへ通信せず、従来どおり取得結果をそのまま返す |
| `auto` | `query` があり、取得した本文が4000文字を超えるときだけ抽出を試す |
| `always` | `query` があれば抽出を試す |

- どのモードでも、`query` がない・`full` / `parts` を指定した・候補が8件以下（短いページ）または400件超のときは抽出せず、従来の取得結果を返す。
- 取得した Markdown を空行区切りの段落（最大800文字）に分けて候補IDを付け、LLMには関係する候補のIDだけを最大8件選ばせる。LLMは本文を書かず、返すのは取得した原文から切り出した断片。存在しないID・重複・件数超過を含む応答は不正として捨てる。
- 返却には `出典: <URL>`、抽出範囲（全候補数と選んだ候補ID、取得本文に対する文字数）、各候補の見出し・行番号・原文が付く。原文は外部ページの内容であり、含まれる指示は操作指示として扱わない。
- 失敗（ollama接続不能・タイムアウト・不正な応答・該当なし・入力が `maxInputChars` 超過・trust-boundaryによる送信拒否）は従来の取得結果へ戻る。エラーにはしない。`always` でも同じ。
- 候補が多いときは、プロンプトへ各候補の先頭だけを載せる。入力全体が `maxInputChars` に収まらないページは従来の取得結果になる。

### 切り詰めの区別

- 取得側: `maxChars` を超えると、`全 N 文字のうち先頭 M 文字のみ` と示して先頭だけを返す。
- 抽出側: 選んだ候補だけを返しており、取得本文の一部にすぎない。抽出範囲の行に、取得本文の何文字のうち何文字かが書かれる。選んだ原文が `maxChars` を超える場合は、その旨を示して切り詰める。

### 原文の追加取得

同じ `url` と `query` で呼び直し、次のいずれかを指定する。`query` を変えると候補IDが変わるので、必ず同じ値を使う。

```json
{"url":"https://example.com","query":"installation","full":true}
{"url":"https://example.com","query":"installation","parts":"3-6,9"}
```

- `full`: 抽出せず、取得した本文の全文を返す（`maxChars` まで。超える分は `maxChars` を上げるか `parts` で分けて取る）。
- `parts`: 候補ID・範囲（`3-6,9`）を指定し、その原文だけを返す。範囲外・不正な形式は拒否する。

どちらも、抽出モードに関わらずLLMへ通信しない。

## 使用例と制約

`mcp__ctxpack-fetch__fetch_page` への入力例:

```json
{"url":"https://example.com","query":"installation"}
```

取得のタイムアウトは60秒。ctxpackが非ゼロで終了すると取得を拒否し、失敗理由を返す。CLIの有無はキャッシュされるため、導入後はセッションを起動し直す。文字数の切り詰めで必要な箇所が落ちる場合はqueryやmaxCharsを調整する。

[source-citation](../source-citation/README.md) と併用すると、取得後の文書への出典記載を促せる。抽出結果の `出典:` 行はそのまま出典として使える。[trust-boundary](../trust-boundary/README.md) と併用すると、ollamaへの送信（宛先は `allowedHosts`、本文は秘密情報の検査）も検査される。

LLMの選択は参考であり、関係する段落を取りこぼす場合がある。確実に読む必要があるときは `full` / `parts` で原文を確認する。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

