# auto-compact

ターン境界で自動的に Compaction する。`triggerMode` に応じて、ターン終了時に `$.session.compact` を呼ぶ。

| `triggerMode` | ターン終了時に圧縮するとき |
|---|---|
| `threshold`（既定） | コンテキスト使用率が `threshold`（既定 65%）以上 |
| `turns` | 前回の Compaction から `everyNTurns`（既定 3）ターン経過 |
| `every` | 毎ターン |

`threshold` では、これに加えて次の条件でも圧縮する。

| 条件 | 既定値 |
|---|---|
| 最後のターン終了からキャッシュ TTL が経過し、使用率が下限以上 | TTL 5分、下限 30% |

キャッシュが切れたあとなら、圧縮してもキャッシュ破棄のコストが実質かからない。`turns` と `every` はキャッシュが生きていても圧縮するため、プロンプトキャッシュの破棄と要約の生成コストが毎回乗る。

- `threshold` では、セッション再開時にキャッシュが失効していて、使用率が下限以上なら Compaction する。
- TTL は設定値から始め、モデル切替フックの `cache_ttl` と、再開時の経過時間・失効の有無から 5分/1時間 のどちらかに絞れたときに更新する。
- サブエージェントのターンは対象外。`threshold` では、Compaction 後も閾値を超えたままなら3ターンは再実行しない。
- Compaction のたびに要約を Markdown で `.claude/compactions/` に保存する（`saveMode`: `off` / `summary` / `full`）。`full` は Compaction 前の会話の読み物版も残す。保存先には `.gitignore`（`*`）を自動で置く。
- 閾値・TTL・下限・保存先は userConfig で変更できる。キャッシュ TTL の目安は Max プランが1時間、Pro と API キーが5分（公式には明記されていない実装詳細）。
- プラグインが呼ぶ Compaction では自プラグインの `session.compact` フックが走らないため、保存は呼び出し側でも行う。

## Handoff 規則

`handoff`（既定 `on`）のとき、Compaction の前に外へ書き出させるため、Agent に次の規則をシステムプロンプトとして与える。会話に残すのは「何をやったか・何ができたか・次に何をやるか」だけで、それ以外はコードベース・ドキュメント・Issue・PR にある前提の運用になる。

| 書き出し先 | 対象 | 歯止め |
|---|---|---|
| Issue | 具体的で着手可能な、後続タスク・バグ・未決事項 | 先に既存 Issue を検索し、重複は作らずコメントで足す。憶測や解決済みのものは作らない |
| ドキュメント | 設計判断・制約・手順・調査結果 | 既存ページがあれば更新する |
| コード | 完了した作業 | 意味のある単位で commit する |

最終回答の末尾には `## Handoff`（Done / Result / Next / Refs）を付けさせる。要約は `<handoff>`（`<done>` / `<result>` / `<next>` / `<refs>`、各 `<item>`）の XML 形式で出力させ、このブロックを正本にして、Refs（パス・ブランチ・commit・Issue/PR 番号）を引き継ぎ、前回の Next のうち未完了のものを残す。リモートや `gh` が無い環境では、Issue の文面をドキュメント側に書かせる。`off` にすると規則は与えず、要約の指示も従来のものに戻る。

規則は Compaction のタイミングに関わらず毎ターン効く。Agent が Issue を作るため、不要な Issue が増える場合は規則の文面（[policy.ts](hooks/policy.ts)）を調整する。Handoff の出力は Agent の遵守に依存し、強制しない。

## 導入

```
/plugin install auto-compact@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `triggerMode` | string | `"threshold"` | ターン終了時の Compaction のタイミング。選択肢: threshold, turns, every |
| `everyNTurns` | number | `3` | turns のときの間隔（ターン数）。範囲: 1〜1000 |
| `handoff` | string | `"on"` | Handoff 規則を Agent に与え、要約を XML 形式の done / result / next / refs に絞る。選択肢: on, off |
| `threshold` | number | `65` | threshold のとき、ターン終了時にコンテキスト使用率がこの値以上なら Compaction する。範囲: 1〜95 |
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

