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

## stack-pr

Issue の実装を頼まれたとき、変更範囲を見積もらせ、大規模なら `gh stack` の Stack PR に分割して進めさせる。通常規模なら単一 PR のまま進める。

Issue の URL、`Issue #12`、`#12 のイシュー`、`gh stack` などを含むプロンプトに、`prompt.submit` フックが手順書を `context` として添付する。`/` で始まるプロンプトは対象外。

### 「変更範囲が大きい」の基準

A を1つでも満たす、または B を2つ以上満たすと大規模。

| 区分 | 条件（既定値） |
|---|---|
| A | 見込み変更行数 400 以上 |
| A | 見込み変更ファイル数 15 以上 |
| A | 3 つ以上の層・領域（スキーマ、バックエンド、フロントエンド、インフラ、ドキュメントなど）にまたがる |
| A | 破壊的変更を含み、他の変更と同居する |
| B | 見込み変更行数 200 以上 |
| B | 見込み変更ファイル数 8 以上 |
| B | リファクタリングと機能追加が同居する |
| B | 独立して検証できる受け入れ条件が 3 つ以上 |
| B | 新規依存の追加を含む |

B の行数・ファイル数は A の半分。実装中に実際の差分が基準を超えたら、その時点で Stack PR に切り替える。

### 進め方（stackPlanningMode）

大規模と判定したあとの進め方を2つから選べる。

| stackPlanningMode | 流れ | 向く場面 |
|---|---|---|
| `plan`（既定） | 実装前に層（ブランチ・内容・完了条件・対象ファイル）を表で計画し、`gh stack init` → 実装 → `gh stack add -Am` で下から積む | 設計が見えている。層ごとにレビューを回したい |
| `after` | 1本の作業ブランチで通して実装し、層の最後のコミットごとに `git branch` で切って、各層のテストを確認してから `gh stack init <下> ... <上>` で取り込む | 実装しながら構造が見えてくる。先に動くものを作りたい |

- 設定の `stackPlanningMode` が既定値。プロンプトに `stack:plan` / `stack:after`（または「実装前にスタックを計画して」「実装後にスタックに分割して」）と書くと、その回だけ上書きできる。
- どちらも、各層は単独でビルド・テストが通る単位にする。`gh stack submit --auto` で PR を作り、タイトルを `[n/N]` 形式に直す。Issue は最上層の PR だけ `Closes`、ほかは `Refs`。
- `after` は `git rebase -i` を使えないので、層が切れないときは `git reset --soft` で戻して層ごとに積み直す。
- マージ、ドラフト解除、スタックの削除はユーザーが求めるまで行わない。

閾値（行数・ファイル数・層の数）も userConfig で変更できる。

### 導入

```
/plugin install stack-pr@utakata-cc-mod
```
