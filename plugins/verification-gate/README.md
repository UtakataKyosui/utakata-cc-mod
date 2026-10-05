# verification-gate

受け入れ条件ごとに検証コマンドを実行し、終了コードと作業ツリーの状態から完了判定の証跡を提供する。

## 前提

検証に使用するCLIと、変更状態を取得するためのGitが必要。Git管理外ではコマンドが成功しても、再変更の有無を判断できないため未検証扱いになる。

## 使い方

1. `mcp__verification-gate__verify_define` で条件を登録する。
2. 必要なら変更前に `verify_run` を `{"baseline":true}` で実行する。
3. 変更後に `verify_run` を `{}` で実行する。
4. `verify_status` または `/verification` で現在の状態を確認する。

登録例（ツールへの入力）:

```json
{"conditions":[{"id":"tests","description":"既存テストが通る","command":["pnpm","test"],"timeout_sec":300}]}
```

条件は最大20件、idは英数字・_・-で40文字以内。commandはシェルを介さないargv配列。再登録は条件全体を置き換え、実行記録を消す。`verify_run` にidを渡すとその条件だけを実行する。省略時は全件を順番に実行する。

## 判定と保存

成功、失敗、未実行、タイムアウト、検証不可、成功後の再変更を区別する。変更前の成功後に失敗すれば回帰、変更前と同じ終了コードの失敗なら既存の失敗として表示する。既存の失敗も成功には数えない。

条件と実行時刻・終了コード・所要時間・変更状態をプラグインstoreにプロジェクトルート単位で保存する。出力本文は保存せず、失敗時だけ末尾をモデルへ返す。

## 制約と連携

完了報告そのものは止められず、モデルへの案内と通知で判定を守らせる。既存失敗の分類は終了コードの比較による近似。未追跡ファイルの内容ハッシュは最大500件で、Gitが無視するファイルは変更判定に含まれない。

[change-review](../change-review/README.md) へ検証結果を渡せる。[task-checkpoint](../task-checkpoint/README.md) のverifyは結果の記録であり、このツールの実行結果が自動転記されるわけではない。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install verification-gate@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `defaultTimeoutSec` | number | `300` | 条件ごとにタイムアウトを指定しなかったときに使う。超えたコマンドは強制終了し、タイムアウトとして記録する 範囲: 5〜600。 |
| `outputTailChars` | number | `2000` | 失敗した検証コマンドの出力の末尾をこの文字数だけモデルへ返す。出力は保存しない 範囲: 0〜20000。 |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

