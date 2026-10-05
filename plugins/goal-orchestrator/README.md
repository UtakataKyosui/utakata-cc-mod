# goal-orchestrator

`/goal` で設定したゴールを、次の手順で達成するようモデルに指示する。

1. ゴールを、完了条件つきのタスクに分解する
2. TODO に登録し、依存関係から実行順序（並列可能なグループ）を付ける
3. 各タスクを SubAgent に委譲する。SubAgent は会話履歴を持たないため、ゴール全体・完了条件・対象ファイル・前タスクの成果・触ってはいけない範囲・報告形式をプロンプトに含める
4. グループごとに報告を検証し、最後にゴール全体の達成を確認する

1〜2ファイルの小さな変更や単発の調査のように、独立したタスクが1つにしかならないゴールでは、分解・委譲を省いて直接取り組む。

`/goal clear` などゴール文でない呼び出しでは何も添付しない。

## 導入

```
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install goal-orchestrator@utakata-cc-mod
```

## 仕組み

`/goal <文面>` の実行時に `command.run` フックが文面を記録し、直後の `prompt.submit` フックで手順書をそのターンの `context` として一度だけ添付する。

## 設定

userConfigによる設定項目はない。


## 使い方と制約

```text
/goal 認証処理を整理し、既存テストが通ることを確認する
```

委譲と検証は添付した手順書に従ってモデルが実行する。フック自身がタスクを作成・起動・監視するわけではない。`clear` / `status` / `off` / `stop` は手順書の添付対象外であり、実行中のSubAgentを停止する機能ではない。

[subagent-router](../subagent-router/README.md) は委譲先のモデル選択、[task-checkpoint](../task-checkpoint/README.md) は状態保存を担当する。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

