# act-now-guard

計画フェーズの要らない依頼で、Claude Code が `EnterPlanMode` や Plan エージェントに入ろうとしたら止める function hook。止めたときは、そのまま実装に着手するよう指示を返す。判定に Claude は使わない。

## 前提

- LocalJev（[githubnext/localjev](https://github.com/githubnext/localjev)）が `endpoint`（既定 `http://127.0.0.1:8080`）で起動していること。上流は Ollama の `qwen3.6:35b-a3b` を想定する
- Ollama を上流にする場合、LocalJev から `reasoning_effort: "none"` を送れるようにしておく。送らないと thinking が出力トークンを使い切り、判定が返らない

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install act-now-guard@utakata-cc-mod
```

単独リポジトリ版（`act-now-guard@act-now-guard`）を入れていた場合は、先に `/plugin uninstall act-now-guard@act-now-guard` で外す。残すとフックが二重に登録される。

## 判定

計画フェーズへの入口（`EnterPlanMode`、`subagent_type: "Plan"` の Agent）が呼ばれた時点で、直近の依頼文を次の順に判定する。依頼文として記録するのは、利用者が送ったもの（送り主が `composer` / `sdk` / `bridge`）だけである。タスクの完了通知や他のプラグインが送った文は記録しない。

| 順 | 条件 | 結果 |
|---|---|---|
| 1 | 「計画」「設計」「プラン」「アーキテクチャ」「plan」「design」などを含む | 通す |
| 2 | 「直して」「修正して」「対応して」「fix」を含む | 止める |
| 3 | どちらも含まない | LocalJev の `choice`（execute / plan）に従う。execute なら止める |

次の場合は止めずに通す。

- サブエージェントの中からの呼び出し
- まだ依頼文が一度も送られていない
- LocalJev に届かない、5 秒以内に応答がない、応答が壊れている

Ollama がモデルを解放したあとの最初の判定は、読み込み直しで 5 秒を超えやすい。その場合は止めずに通る。

## 設定

| キー | 既定 | 内容 |
|---|---|---|
| `mode` | `apply` | `observe` にすると止めずに、判定結果をステータスに出すだけにする |
| `endpoint` | `http://127.0.0.1:8080` | LocalJev のベース URL |

## 開発

```sh
claude plugin validate plugins/act-now-guard
claude plugin test plugins/act-now-guard
claude --plugin-dir plugins/act-now-guard   # 手元のフォルダを読み込んで試す
```

