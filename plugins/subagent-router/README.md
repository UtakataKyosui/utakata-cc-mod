# subagent-router

SubAgent の起動時に、タスクに合う model と effort を ollama の決定モデルに判断させて振り分ける。

| 項目 | 内容 |
|---|---|
| 判断の材料 | agent type、description、prompt の先頭 4000 文字 |
| 判断の結果 | model: `haiku` / `sonnet` / `opus`、effort: `low` / `medium` / `high` / `xhigh` / `max` |
| 既定の決定モデル | `tev1:4b` → `nimble`（9B）の順 |

- ollama の構造化出力（JSON スキーマ）で応答を縛り、スキーマ外の値は失敗として扱う。
- 接続失敗・タイムアウト・メモリ不足による異常・不正な応答のいずれかで、次のモデルへ回す。失敗したモデルは次の 5 回の SubAgent 起動のあいだ試さない。
- 全モデルが失敗したときは振り分けず、元の指定のまま起動する。
- model は `agent.spawn` フックで、effort は SubAgent 自身のリクエストの `turn.step` フックで適用する。
- `tev1:0.8b` は軽すぎて、試した 8 件のうち 5 件で model を外した（ほぼ常に opus を返す）ため既定には入れていない。`models` に追記すれば使える。
- Agent 呼び出しが model を明示している場合と fork は対象外。
- ollama の呼び出し・モデルの切り替え・応答の検証は [shared/local-llm](../../shared/local-llm/README.md) の共通基盤を `hooks/local-llm/` に同梱して使う。
- ollama の URL、モデルの優先順、タイムアウト、失敗時に飛ばす回数、`keep_alive` は userConfig で変更できる。

## 導入

```
ollama pull tev1:4b
ollama pull nimble
/plugin install subagent-router@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `ollamaUrl` | string | `"http://localhost:11434"` | ollama サーバーのベース URL |
| `models` | string | `"tev1:4b,nimble"` | 先頭から試し、接続失敗・タイムアウト・メモリ不足・不正な応答のモデルは次へ回す。既定は tev1:4b、nimble の順 |
| `timeoutSeconds` | number | `30` | モデルの読み込みを含めてこの時間内に答えなければ失敗として次のモデルへ回す 範囲: 5〜120。 |
| `skipTurns` | number | `5` | 失敗したモデルは、この回数の SubAgent 起動のあいだ試さない 範囲: 0〜50。 |
| `keepAlive` | string | `"1m"` | ollama の keep_alive。短いほどメモリを早く解放する |


## 動作確認と制約

ollamaを起動し、モデルを取得した状態でSubAgentを起動すると、判断モデルと選択したmodel / effortが通知される。切り替わらない場合は、明示的なmodel指定やforkの有無、ollamaへの接続、モデルの取得状況を確認する。

判断のためにタスクのdescription・promptの先頭を設定したollamaサーバーへ送る。判断結果はタスク品質や費用削減を保証しない。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

