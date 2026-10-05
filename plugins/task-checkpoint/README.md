# task-checkpoint

ゴール、タスク、依存関係、成果物、検証結果、未解決事項をローカルに保存し、再開やCompaction後のプロンプトへ載せる。

## 使い方

```text
/checkpoint goal 認証処理を整理する
/checkpoint show
/checkpoint reconcile
/checkpoint diagnose
```

`/checkpoint reset` は台帳を初期化する。通常のタスク更新は `mcp__task-checkpoint__checkpoint` ツールで行う。

| op | 入力 | 用途 |
|---|---|---|
| goal | goal | ゴールの記録 |
| task | id, title, deps, status, note | タスク登録・更新 |
| artifact | id, paths | ルートからの相対パスで成果物を登録 |
| verify | id, command, result | 実行済み検証のpass / failを記録 |
| issue | text | 未解決事項を追加 |
| resolve_issue | index | 未解決事項を解消 |
| show / reconcile | なし | 表示 / 保存状態と実ファイルの照合 |

タスクの状態はpending / running / blocked / failed / needs_recheck / done。runningへ移れるのは依存先がdoneのとき。doneにはpassの記録と、検証後に成果物が変わっていないことが必要。

入力例:

```json
{"op":"task","id":"auth","title":"認証処理の整理","deps":[],"status":"pending"}
```

## 復元と保存

起動時と対象のCompaction後に照合する。保存されたrunningはneeds_recheckへ戻し、成果物の変更・欠落等を診断する。プロンプトには未完了タスクを優先して設定件数まで載せる。

保存先は既定で `.claude/checkpoints/`。`slot-a.json` と `slot-b.json` を交互に使い、チェックサム・世代・スキーマ版を確認する。破損した面は退避し、新しい未知のスキーマがあれば書き込まない。保存先へ.gitignoreを作成する。

## 制約と連携

verifyはコマンドを実行せず、渡された結果を記録する。成果物の比較はサイズとmtimeによる近似で、内容ハッシュではない。保存する文字列は長さ制限と秘密らしい値のマスクを行うが、任意の秘密情報を完全に検出できるわけではない。

TODOを自動で取り込まず、モデルがツールで更新する必要がある。`/goal` の文は記録するが、goal-orchestratorのタスク一覧と自動同期しない。reconcileはrunningを再確認へ戻す処理も行うため、実行中に呼ぶ場合は状態を確認する。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install task-checkpoint@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `saveDir` | string | `".claude/checkpoints"` | 相対パスはプロジェクトルートからの位置。中に .gitignore を自動で置き、git 管理から外す |
| `maxPromptTasks` | number | `20` | Compaction や再開のあと、システムプロンプトに載せるタスクの最大件数。未完了のものを優先する 範囲: 5〜100。 |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

