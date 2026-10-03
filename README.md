# utakata-cc-mod

Claude Code 用の mod 集。

## goal-orchestrator

`/goal` で設定したゴールを、次の手順で達成するようモデルに指示する。

1. ゴールを、完了条件つきのタスクに分解する
2. TODO に登録し、依存関係から実行順序（並列可能なグループ）を付ける
3. 各タスクを SubAgent に委譲する。SubAgent は会話履歴を持たないため、ゴール全体・完了条件・対象ファイル・前タスクの成果・触ってはいけない範囲・報告形式をプロンプトに含める
4. グループごとに報告を検証し、最後にゴール全体の達成を確認する

1〜2ファイルの小さな変更や単発の調査のように、独立したタスクが1つにしかならないゴールでは、分解・委譲を省いて直接取り組む。

`/goal clear` などゴール文でない呼び出しでは何も添付しない。

### 導入

```
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install goal-orchestrator@utakata-cc-mod
```

### 仕組み

`/goal <文面>` の実行時に `command.run` フックが文面を記録し、直後の `prompt.submit` フックで手順書をそのターンの `context` として一度だけ添付する。

### 開発

```
pnpm install
claude plugin validate .
claude plugin test .
```

## auto-compact

ターン境界で自動的に Compaction する。次のどちらかを満たしたら `$.session.compact` を呼ぶ。

| 条件 | 既定値 |
|---|---|
| ターン終了時にコンテキスト使用率が閾値以上 | 65% |
| 最後のターン終了からキャッシュ TTL が経過し、使用率が下限以上 | TTL 5分、下限 30% |

- セッション再開時にキャッシュが失効していて、使用率が下限以上なら Compaction する。
- TTL は設定値から始め、モデル切替フックの `cache_ttl` と、再開時の経過時間・失効の有無から 5分/1時間 のどちらかに絞れたときに更新する。
- サブエージェントのターンは対象外。Compaction 後も閾値を超えたままなら、3ターンは再実行しない。
- Compaction のたびに要約を Markdown で `.claude/compactions/` に保存する（`saveMode`: `off` / `summary` / `full`）。`full` は Compaction 前の会話の読み物版も残す。保存先には `.gitignore`（`*`）を自動で置く。
- 閾値・TTL・下限・保存先は userConfig で変更できる。キャッシュ TTL の目安は Max プランが1時間、Pro と API キーが5分（公式には明記されていない実装詳細）。
- プラグインが呼ぶ Compaction では自プラグインの `session.compact` フックが走らないため、保存は呼び出し側でも行う。

### 導入

```
/plugin install auto-compact@utakata-cc-mod
```

## subagent-router

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
- ollama の URL、モデルの優先順、タイムアウト、失敗時に飛ばす回数、`keep_alive` は userConfig で変更できる。

### 導入

```
ollama pull tev1:4b
ollama pull nimble
/plugin install subagent-router@utakata-cc-mod
```
