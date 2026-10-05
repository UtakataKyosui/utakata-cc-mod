# execution-budget

SubAgentの起動総数・同時実行数・再試行回数・経過時間に上限を設け、使用量と診断情報を記録する。

## 使い方

```text
/budget status
/budget stop
/budget resume
/budget reset
/budget log
```

status（引数なしでも可）は上限、起動履歴、拒否された作業、取得できた使用量を表示する。stopは新しい起動を止め、既に動いているSubAgentは停止しない。resumeは時間・起動数・再試行数の基準点を現在へ移して再開し、履歴と使用量を保持する。resetは新しい予算区間を作り、直前の状態を参照用に保存する。

## 上限と保存

予算はセッション開始時に作成される。この実装は `/goal` の変更と連動して自動リセットしない。別セッションでは新しい予算を作る。同時実行上限は枠が空くまで起動を拒否し、その他の上限ではresumeまで起動を止める。上限は新しい起動時に判定し、実行中の処理を時間到達だけで強制終了しない。

再試行はagent type・description・promptの指紋が同じ起動を数える。内容を変えた再委譲は同一再試行と認識されない場合がある。

状態と診断ログはプラグインstoreへ保存する。prompt本文は保存せず、descriptionは既定で保存しない。ログは最大500件、表示は直近30件。使用量はturn.completeから取得できた分を集計し、費用は本体から得たセッション全体のUSD値で、ゴール区間の課金額ではない。

## 制約

メインエージェントのツール実行やトークン・金額を上限で止める機能はない。保存する残作業は拒否された起動の記録で、タスク全体の台帳ではない。ルーティングの待避や検証結果を統合する汎用トレース機能もない。[task-checkpoint](../task-checkpoint/README.md) と併用してタスク状態を記録できる。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install execution-budget@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `maxMinutes` | number | `120` | この時間を過ぎたら新しい SubAgent を起動しない。0 で無制限 範囲: 0〜1440。 |
| `maxConcurrent` | number | `4` | 実行中の SubAgent がこの数なら、空くまで新しい起動を断る。0 で無制限 範囲: 0〜50。 |
| `maxSpawns` | number | `30` | ゴール内の起動回数がこの数に達したら新しい起動を止める。0 で無制限 範囲: 0〜500。 |
| `maxRetries` | number | `5` | 同じ種類と内容の SubAgent を再び起動した回数の合計。超えたら止める。0 で無制限 範囲: 0〜100。 |
| `retentionDays` | number | `7` | これより古いログは自動で削除する。0 でログを記録しない 範囲: 0〜365。 |
| `recordDescriptions` | boolean | `false` | 既定は off。プロンプト本文は設定にかかわらず保存しない |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

