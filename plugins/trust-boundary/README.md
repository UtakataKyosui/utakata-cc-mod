# trust-boundary

外部由来の内容を参考データとして区別し、外部取得後の危険な操作、プラグインのHTTP送信、Notion書き込みを検査する。

## 使い方

```text
/trust-boundary
/trust-boundary clear
```

現在の外部取得状態と設定を表示する。clearは外部内容を取り込んだというセッション内フラグだけを解除し、取得した内容を削除しない。

## 検査する場面

- 設定した外部ツールを呼ぶとフラグを立て、成功した結果に出所の注記を加える。
- 外部取得後のtool.checkでは、設定変更・外部送信・公開系など検出した操作をaskまたはdenyにする。本体のdenyを許可へ変更しない。
- プラグインのhttp.fetchでは宛先ホストと送信本文を検査する。ollamaを別ホストへ移す場合はallowedHostsにも追加する。
- ntnによるNotion書き込みはnotionWriteと本文検査を適用する。取得はnotionWriteの対象外。
- 対象Web取得のURLや外部MCP書き込みの入力も秘密検査する。

## 設定例

追加の除外ルールに `社外秘|CONFIDENTIAL` を指定すると、該当する本文の送信を拒否する。excludePatternsとextraSecretPatternsは1行1つの正規表現。誤った正規表現はfailModeに従う。

[notion-knowledge](../notion-knowledge/README.md) の自動記録を止める場合はnotionWriteをfalseにする。[subagent-router](../subagent-router/README.md) のollama送信もHTTP検査の対象になる。

## 制約

プロンプト注記とパターン検査による防御であり、プロンプトインジェクションや任意の通信を完全に防ぐものではない。Bashや別CLIを使う通信全体のネットワーク隔離は提供しない。notion-knowledgeのようなフック内取得は通常のtool.call経路を通らないため、外部取得フラグの対象と同一ではない。

askは本体の確認へ回すが、bypassPermissionsでは自動承認され得る。guardModeの説明に従い、拒否が必要ならdenyを使う。検査失敗時の既定はclosed。状態はセッション内のメモリで管理する。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install trust-boundary@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `guardMode` | string | `"ask"` | ask: 本体の確認に回す / deny: 拒否する / off: 何もしない。本体の判断が拒否のものは変えず、許可を広げることはしない。bypassPermissions では ask が自動承認され得るので deny を推奨 選択肢: ask, deny, off。 |
| `externalTools` | string | `"WebFetch,WebSearch,fetch_page,mcp__*notion*,mcp__*chrome*,mcp__*gmail*,mcp__*drive*,mcp__*slack*"` | これらのツールを呼んだセッションは「外部内容を取り込んだ」とみなし、以降の設定変更・外部送信・公開系の操作を検査する |
| `allowedHosts` | string | `"localhost,127.0.0.1,::1,api.notion.com"` | プラグインの http.fetch はここにあるホストだけ許可する (ollama の URL のホストもここに入れる)。空なら localhost と api.notion.com |
| `notionWrite` | boolean | `true` | オフにすると notion-knowledge の自動記録など、ntn で行う作成・更新を拒否する。取得は影響を受けない |
| `scanOutbound` | boolean | `true` | ollama への送信、ntn での Notion 書き込み、Notion MCP の書き込みの本文を検査し、該当すれば拒否する。拒否理由には種別だけを出し、値は出さない |
| `excludePatterns` | string | `""` | 一致する内容は外部へ送らない。例: 社外秘\|CONFIDENTIAL。空行は無視。不正な正規表現は検査失敗として扱う |
| `extraSecretPatterns` | string | `""` | 組み込みの秘密検査に加えて使う。不正な正規表現は検査失敗として扱う |
| `failMode` | string | `"closed"` | closed: 送信・操作を止める (拒否または要確認) / open: 検査なしで通す。検査失敗は、不正な正規表現や検査中の例外 選択肢: closed, open。 |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

