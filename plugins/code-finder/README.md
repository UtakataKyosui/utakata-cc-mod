# code-finder

fd と ripgrep を使って、ファイルやコードを探すツールをモデルに提供する。

| ツール | 中身 | 主な引数 |
|---|---|---|
| `mcp__code-finder__find_files` | fd でファイル・ディレクトリを名前検索 | `pattern`、`extension`、`type`、`glob`、`hidden`、`max_depth`、`path` |
| `mcp__code-finder__search_code` | ripgrep でファイルの中身を検索 | `pattern`、`glob`、`type`、`file_pattern`、`ignore_case`、`fixed`、`word`、`files_only`、`context`、`path` |

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

