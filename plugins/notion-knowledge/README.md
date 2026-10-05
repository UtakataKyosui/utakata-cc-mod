# notion-knowledge

Notion のデータベースをナレッジベースにする。ollama の `tev1:4b` に判断させ、プロンプトに関係する知識の取得と、新しい知識の記録を自動で行う。ツールをモデルに登録するのではなく、フックで割り込む。Notion との通信は [ntn](https://ntn.dev)（Notion CLI）と Notion API で、ベースは [ntn-lib](https://github.com/UtakataKyosui/ntn-lib)。

| 場面 | 仕組み |
|---|---|
| プロンプト送信時（取得） | 更新の新しい順に `catalogSize` 件の題名とタグを `tev1:4b` に番号付きで見せ、依頼に関係するものを選ばせる。選ばれたページ（最大 `maxPages` 件）を `ntn pages get` で読み、そのターンの `context` として添付する |
| 回答の終了後（記録） | 依頼と回答を `tev1:4b` に読ませ、`none` / `create` / `append` を判断させる。`create` は新規ページ、`append` は既存ページの末尾への追記 |

- 取得は、該当なしなら何も添付しない。挨拶・短い入力・`/` で始まる入力・割り込み中の送信、ollama や Notion の失敗では、プロンプトをそのまま通す。
- 記録の対象は、決定とその理由、原因を突き止めた不具合、自明でない罠、調査の結論、再利用できる手順。本文は回答の事実（値・コマンド・理由）を写す形で書かせる。
- `tev1:4b` は `create` に偏って重複を作りやすいため、`create` と判断したときは、同じ話題の既存ページがないかを絞った質問でもう一度確かめ、あれば `append` に切り替える。作る直前には、一覧に載らない古いページと題名が重ならないか Notion 側でも探す。
- 記録するのは、題名と本文だけ。ページのプロパティ（タグなど）は設定しない。`append` は `## 追記 <日付>` の見出しで足し、既存の本文は書き換えない。削除もしない。
- `tev1:4b` が出した内容に、API キー・トークン・秘密鍵・`password=` などの形が含まれていたら記録しない。
- 判断の応答は構造化出力（JSON スキーマ）で縛り、範囲外の番号や短すぎる本文は「記録しない」として扱う。失敗したモデルは次のモデルへ回し、全部失敗したら 60 秒は問い合わせない。
- 一覧の取得は 5 分間キャッシュし、記録したら破棄する。ナレッジが `catalogSize` 件を超える場合、選べるのは更新の新しい側だけになる。
- サブエージェントのターンは記録の対象外。`autoRecord` をオフにすると取得だけ行う。
- `databaseId`（ID または URL）が空のあいだは何もしない。ollama の URL、モデルの優先順、`keepAlive`、添付する文字数の上限は userConfig で変更できる。
- 起動後に `ntn whoami` が通らないときは動かない。

## 導入

```
ollama pull tev1:4b
curl -fsSL https://ntn.dev | bash
ntn login   # または NOTION_API_TOKEN を設定する
/plugin install notion-knowledge@utakata-cc-mod
```

プラグイン設定で `databaseId` にナレッジのデータベースを指定する。Notion 側では、そのデータベースを `ntn` のユーザー（または Integration）に共有しておく。

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `databaseId` | string | `""` | ナレッジを記録するデータベースの ID または URL。空のあいだは何もしない |
| `autoRecord` | boolean | `true` | 回答の終了後に、記録に値する知識があれば tev1:4b の判断で Notion に新規作成または追記する。オフなら取得だけ行う |
| `ollamaUrl` | string | `"http://localhost:11434"` | ollama サーバーのベース URL |
| `models` | string | `"tev1:4b"` | 先頭から試し、接続失敗・タイムアウト・不正な応答のモデルは次へ回す |
| `timeoutSeconds` | number | `40` | モデルの読み込みを含めてこの時間内に答えなければ失敗として扱う。プロンプト送信前の取得もこの時間だけ待つ 範囲: 5〜180。 |
| `keepAlive` | string | `"5m"` | ollama の keep_alive。短いほどメモリを早く解放する |
| `catalogSize` | number | `100` | 更新の新しい順にこの件数の題名をモデルへ渡し、関係するものを選ばせる 範囲: 10〜300。 |
| `maxPages` | number | `3` | tev1:4b が選んだナレッジのうち、プロンプトに添付するページの最大数 範囲: 1〜10。 |
| `maxChars` | number | `12000` | 取得したページ本文を合わせてこの文字数に切り詰めてからプロンプトに添付する 範囲: 1000〜60000。 |


## 初期設定と制約

指定するデータベースはdata sourceが1つで、タイトル列があるものを使用する。複数のdata sourceがある場合は取得に失敗し、通常のプロンプト送信へ戻る。

依頼・回答・ナレッジの選定情報をollamaへ送り、記録内容はNotionへ送信する。`autoRecord: false` でも知識選定のためのollama通信は行う。秘密らしい文字列の検査は生成された記録内容に対するもので、送信全体の漏えい防止を保証しない。

`timeoutSeconds` はモデルごとの待ち時間であり、Notion通信を含めた取得処理全体の上限ではない。Notion CLIの通信は個別に最大60秒待つ。動かない場合はdatabaseId、共有権限、`ntn whoami`、ollamaの接続状況を確認する。

[trust-boundary](../trust-boundary/README.md) と併用する場合はallowedHostsとNotion書き込み設定も確認する。

## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

