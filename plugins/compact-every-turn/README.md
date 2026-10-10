# compact-every-turn

ターン終了時に Compaction し、会話には「何をやったか・何ができたか・次に何をやるか」だけを残す。それ以外の情報はコードベース・ドキュメント・Issue・PR に保存されている前提で運用する。

Compaction の前に外へ書き出させるため、Agent に次の規則をシステムプロンプトとして与える（Compaction のタイミングに関わらず毎ターン有効）。

| 書き出し先 | 対象 | 歯止め |
|---|---|---|
| Issue | 具体的で着手可能な、後続タスク・バグ・未決事項 | 先に既存 Issue を検索し、重複は作らずコメントで足す。憶測や解決済みのものは作らない |
| ドキュメント | 設計判断・制約・手順・調査結果 | 既存ページがあれば更新する |
| コード | 完了した作業 | 意味のある単位で commit する |

最終回答の末尾には `## Handoff`（Done / Result / Next / Refs）を付けさせる。Compaction の要約はこのブロックを正本にし、Refs（パス・ブランチ・commit・Issue/PR 番号）を引き継ぐ。リモートや `gh` が無い環境では、Issue の文面をドキュメント側に書かせる。

## Compaction のタイミング

| `mode` | 圧縮するとき |
|---|---|
| `threshold`（既定） | ターン終了時にコンテキストの使用率が `thresholdPercent` 以上 |
| `turns` | 前回の Compaction から `everyNTurns` ターン経過 |
| `every` | 毎ターン |

- 対象はメインループの `answer` で終わったターンだけ。サブエージェント、中断、エラー、拒否のターンは対象外。
- `$.session.compact` はターン実行中だと reject されるため、300ms 後に呼び、失敗したら最大5回まで再試行する。
- Compaction 直後は次の応答が返るまで使用率が取れないため、`threshold` では圧縮しない。
- `turns` のカウンタはプラグインの再読み込みで 0 に戻る。

毎ターン圧縮するとプロンプトキャッシュが毎回切れ、要約の生成コストも毎ターン乗る。充填率かターン数で間引くのはそのため。

## 導入

```
/plugin install compact-every-turn@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `mode` | string | `"threshold"` | 選択肢: threshold, turns, every |
| `thresholdPercent` | number | `30` | threshold のときの使用率の閾値。範囲: 1〜99 |
| `everyNTurns` | number | `3` | turns のときの間隔。範囲: 1〜1000 |

## 他のプラグインとの関係

[auto-compact](../auto-compact/README.md) も `$.session.compact` を呼ぶ。併用すると両方が Compaction するため、どちらか一方を有効にする。auto-compact は使用率とキャッシュ失効で圧縮し要約をファイルに保存する。このプラグインは要約の中身を Done / Result / Next / Refs に絞り、外部への書き出しを Agent に義務づける。

## 制約

- 使うと Agent が Issue を作る。リポジトリに作るため、不要な Issue が増える場合は規則の文面（[policy.ts](hooks/policy.ts)）を調整する。
- `## Handoff` の出力は Agent の遵守に依存し、強制しない。守られない場合、要約は会話から3点を拾う。
- Compaction 自体の実機での動作は未検証。ステータス行に `compact-every-turn: gave up` が出たら再試行を使い切っている。

[プラグイン一覧へ戻る](../../README.md)
