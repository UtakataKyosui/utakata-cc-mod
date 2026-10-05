# ctxpack-fetch

WebFetch を禁じ、代わりに [ctxpack](https://github.com/atani/ctxpack) で Web ページを取得するツールをモデルに提供する。ctxpack はページからノイズを除いたコンパクトな Markdown を返す CLI。

| ツール | 中身 | 引数 |
|---|---|---|
| `mcp__ctxpack-fetch__fetch_page` | `ctxpack <url> [--query <キーワード>]` を実行する | `url`（http / https）、`query` |

- 起動時に `ctxpack` の有無を調べ、入っているときだけツールを登録して WebFetch を拒否する。入っていないときは WebFetch をそのまま使える。
- URL は http(s) のみ受け付ける。コマンドはシェルを通さず argv で実行する。
- `query` を渡すと、関連するセクションが先頭に来る。
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


## 使用例と制約

`mcp__ctxpack-fetch__fetch_page` への入力例:

```json
{"url":"https://example.com","query":"installation"}
```

取得のタイムアウトは60秒。ctxpackが非ゼロで終了すると取得を拒否し、失敗理由を返す。CLIの有無はキャッシュされるため、導入後はセッションを起動し直す。文字数の切り詰めで必要な箇所が落ちる場合はqueryやmaxCharsを調整する。

[source-citation](../source-citation/README.md) と併用すると、取得後の文書への出典記載を促せる。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

