# utakata-cc-mod all-in-one

[utakata-cc-mod](https://github.com/UtakataKyosui/utakata-cc-mod) の Mod プラグイン {{COUNT}} 本を、1回のインストールでまとめて入れるオールインワン版。設定しなくても、手元の環境で動くものだけが有効になる。

> このリポジトリは utakata-cc-mod の `scripts/build-all-in-one.ts` で生成している (元コミット `{{COMMIT}}`)。プラグインの修正は utakata-cc-mod 側で行い、ここは直接編集しない。

## 導入

Claude Mod のフックを実行できる Claude Code 環境が必要。

```text
/plugin marketplace add {{REPO}}
/plugin install {{SELF}}@{{MARKETPLACE}}
```

`{{SELF}}` は全プラグインを `dependencies` に持つので、上の2行で {{COUNT}} 本がすべて入る。個別のインストールや設定は要らない。

## 自動で無効になるもの

`{{SELF}}` は各プラグインの読み込み時 (`plugin.register`) に依存を確かめ、足りないものだけ読み込みを止める。

- 必要な CLI が `PATH` に無い (`command -v` で確認)
- ollama / LocalJev が応答しない (既定で2秒待つ。URL は各プラグインの設定、無ければ既定値を見る)
- 必須の設定が空 (notion-knowledge の `databaseId`)
- 競合する組の片方

あとから CLI を入れたり ollama を起動したりしたら、新しいセッションを始めると有効になる。どれが有効でなぜ止めたかは `/all-in-one` で一覧できる。判定はこの marketplace (`@{{MARKETPLACE}}`) から入ったプラグインだけが対象で、別の marketplace から入れたものには触れない。

## 収録プラグイン

{{PLUGIN_TABLE}}

各プラグインの使い方・設定・制約は、表のリンク先の README を参照。

## 競合する組

次の組は助言や書き換えがぶつかるので、片方だけを有効にする。

{{CONFLICTS}}

もう片方を使うときは、`{{SELF}}` の設定 `disabled` で、止める側と残す側を入れ替える (例: `disabled` を `bash-hints,subagent-router` にすると advanced-rust-cli が有効になる)。

## 設定 ({{SELF}})

設定しなくても動く。変えたいときだけ `/plugin` の設定画面か、settings の `pluginConfigs` で指定する。

| 項目 | 既定値 | 内容 |
|---|---|---|
| `disabled` | `advanced-rust-cli,subagent-router` | 読み込まないプラグイン (カンマ区切り) |
| `autoDisable` | `on` | `off` にすると依存の確認をせず、`disabled` と競合の判定だけ行う |
| `probeTimeoutSeconds` | `2` | ollama・LocalJev・CLI の確認ごとの待ち時間の上限 (1〜30秒) |

各プラグイン自身の設定 (しきい値や `llmMode` など) は、そのプラグインの設定としてそのまま使える。

## 注意

- 同じ名前のプラグインを utakata-cc-mod の marketplace からも入れていると、同じフックが2回動く。どちらか一方の marketplace だけを使う。
- 依存の確認は読み込みのたびに行う。ollama などが遅い環境では、起動が最大で `probeTimeoutSeconds` 秒延びる。
