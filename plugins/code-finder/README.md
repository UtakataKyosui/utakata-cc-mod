# code-finder

fd と ripgrep を使って、ファイルやコードを探すツールをモデルに提供する。

| ツール | 中身 | 主な引数 |
|---|---|---|
| `mcp__code-finder__find_files` | fd でファイル・ディレクトリを名前検索 | `pattern`、`extension`、`type`、`glob`、`hidden`、`max_depth`、`path` |
| `mcp__code-finder__search_code` | ripgrep でファイルの中身を検索 | `pattern`、`glob`、`type`、`file_pattern`、`ignore_case`、`fixed`、`word`、`files_only`、`context`、`path`、`purpose`、`raw` |

- `search_code` に `file_pattern` を渡すと、fd でファイル名を絞ってからその中だけを rg で検索する（`fd PATTERN | xargs rg` 相当、絞り込みは最大 1000 ファイル）。
- 起動時に `fd` / `rg` の有無を調べ、入っているほうのツールだけ登録する。システムプロンプトにも使い分けの案内を足す。
- コマンドはシェルを通さず argv で実行し、パターンの前に `--` を置くので、`-` で始まる文字列もオプションとして解釈されない。
- 返す行数の上限は userConfig の `maxResults`（既定 200）で変更できる。

## 導入

```
brew install fd ripgrep
/plugin install code-finder@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `maxResults` | number | `200` | 1 回の検索で返す行数の上限。超えた分は切り捨てて件数だけ伝える 範囲: 10〜2000。 |
| `llmMode` | string | `off` | ローカルLLMによる絞り込みの利用モード (`off` / `auto` / `always`) |
| `ollamaUrl`、`models`、`timeoutSeconds`、`totalTimeoutSeconds`、`maxAttempts`、`keepAlive`、`maxInputChars`、`maxOutputChars` | | | 共通のローカルLLM基盤の設定。意味と既定値は [shared/local-llm](../../shared/local-llm/README.md) を参照 |

## ローカルLLMによる絞り込み

`search_code` に調査目的 `purpose` を渡すと、検索後にローカルLLM (ollama) が関係する行だけを選んで返す。多数の一致をClaudeが読む前に減らすための補助で、検索そのものはこれまでどおり `rg` が行う。

- LLMには各行に振った候補IDを選ばせるだけで、検索コマンドの実行やコードの変更はさせない。返す行は検索結果の原文をそのまま元の順序で並べたもので、LLMが書いた文字列は含めない。
- 候補は `maxResults` で切り詰めた後の行。入力と出力は参考データとして扱い、存在しないID・重複・範囲外・0件の選択は不正として捨てる。
- 絞り込み時は結果の末尾に、候補数・返却数・除外数、返却上限 (30行)、入力上限 (`maxInputChars`)、検索自体の切り詰めの有無 (`maxResults` による切り詰めとLLMによる除外は別に示す) を付ける。
- `find_files` は対象外で、従来どおり。`search_code` も `purpose` を渡さなければ従来どおり。
- 候補が `maxInputChars` に収まらない大きな結果は絞り込まれない。`maxResults` や `maxInputChars` を調整するか、検索範囲を絞る。

| mode | 動作 |
|---|---|
| `off` (既定) | 通信しない。`purpose` は無視し、従来の返却形式・動作のまま |
| `auto` | 結果が 30 行以上、または 3000 文字以上のときだけ絞り込む。それ未満は通信せず従来の結果を返す |
| `always` | `purpose` があり一致があれば必ず試す |

失敗時の動作: 接続不能・タイムアウト・不正な応答・不正な選択・入力上限超過 (`maxInputChars` を超える結果は送らない)・trust-boundary による拒否のいずれでも、従来の検索結果をそのまま返し、末尾に絞り込みを行わなかった理由を1行付ける。`always` でも同じ。一致なし、`raw: true`、`purpose` なしでは通信しない。

### 原文の追加取得

絞り込みで除外された行や、選ばれた行の前後が必要なときは次のいずれかで取る。

```json
{"pattern":"login","path":"src","purpose":"ログイン処理の入口を知りたい"}
```

- 絞り込みなしで再検索する: 同じ入力から `purpose` を外すか `"raw": true` を付ける。
  ```json
  {"pattern":"login","path":"src","purpose":"ログイン処理の入口を知りたい","raw":true}
  ```
- 前後の行を見る: `context` を付ける (最大 20)。例: `{"pattern":"login","path":"src/auth.ts","context":5}`
- 行範囲を読む: 結果の `path:行番号` を使い、Read ツールの `offset` / `limit` でその周辺を読む。
- 一致が `maxResults` で切り詰められた場合は、`path`・`glob`・`type`・`file_pattern` で検索範囲を絞る。


## 使用例

モデルが呼び出すツールへの入力例:

```json
{"pattern":"register","extension":"ts","path":"plugins"}
```

上記は `find_files` 用。`search_code` では次のように内容とファイルを絞れる。

```json
{"pattern":"timeoutMs","glob":"*.ts","path":"plugins","context":2}
```

検索対象がなければ空の検索結果を返し、CLIが失敗した場合はエラーを返す。CLIの検出結果はキャッシュするため、起動後にインストールした場合はセッションを起動し直す。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

