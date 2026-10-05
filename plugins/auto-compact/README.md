# auto-compact

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

## 導入

```
/plugin install auto-compact@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `threshold` | number | `65` | ターン終了時にコンテキスト使用率がこの値以上なら Compaction する 範囲: 30〜95。 |
| `cacheTtlMinutes` | string | `"5"` | 最後のターン終了からこの時間が経つとキャッシュが失効したとみなす。目安は Max プランが 60、Pro と API キーが 5 選択肢: 5, 60。 |
| `idleMinPercent` | number | `30` | キャッシュ失効時は、使用率がこの値以上のときだけ Compaction する 範囲: 5〜95。 |
| `saveMode` | string | `"summary"` | off は保存しない。summary は要約のみ、full は要約と Compaction 前の会話の読み物版を保存する 選択肢: off, summary, full。 |
| `saveDir` | string | `".claude/compactions"` | 相対パスはプロジェクトルートからの位置。中に .gitignore を自動で置き、git 管理から外す |


## 保存と失敗時の挙動

要約の保存に失敗してもCompactionは巻き戻さず、debugログに記録する。Compactionの例外は最大5回まで再試行する。保存したMarkdownは自動的に会話へ再投入されるものではない。

保存内容は会話由来の情報を含む。`full` は会話本文と使用ツール名も残す。[task-checkpoint](../task-checkpoint/README.md) は構造化したタスク台帳を別に管理する。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

