# agent-router

サブエージェントと Workflow の `agent()` の起動時に、依頼内容を LocalJev（Jev 互換の `POST /v1/systemone`）でロールに分類する function hook。分類したロールに、`~/.claude/skills/agent-routing/data/roles.json` の model と effort を当てる。判定に Claude は使わない。

## 前提

- `~/.claude/skills/agent-routing/data/roles.json` があること
- LocalJev（[githubnext/localjev](https://github.com/githubnext/localjev)）が `endpoint`（既定 `http://127.0.0.1:8080`）で起動していること。上流は Ollama の `qwen3.6:35b-a3b` を想定する
- Ollama を上流にする場合、LocalJev から `reasoning_effort: "none"` を送れるようにしておく。送らないと qwen3.6 や gemma4 の thinking が出力トークンを使い切り、判定が返らない

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install agent-router@utakata-cc-mod
```

単独リポジトリ版（`agent-router@agent-router`）を入れていた場合は、先に `/plugin uninstall agent-router@agent-router` で外す。残すとフックが二重に登録される。

## 併用

[subagent-router](../subagent-router/README.md) とは判定が競合する。どちらも `agent.spawn` の model と `turn.step` の effort を書き換える。subagent-router は ollama、agent-router は LocalJev と roles.json で判定する。どちらか一方を入れる。

## 書き換える範囲

| 起動されるエージェント | model | effort |
|---|---|---|
| `general-purpose` / `claude` | 呼び出しで未指定なら書き換える | 書き換える |
| `.claude/agents/<name>.md` または `~/.claude/agents/<name>.md` があるもの | 定義に `model:` が無く、呼び出しでも未指定なら書き換える | 定義に `effort:` が無ければ書き換える |
| fork、プラグインのエージェント（`plugin:name`）、`Explore` などの組み込み、定義の見つからないもの | 触らない | 触らない |

次の場合は何も書き換えずに起動する。

- LocalJev に届かない、5 秒以内に応答がない、応答が壊れている
- confidence が `confidenceThreshold` 未満
- 判定されたロールが roles.json に無い

model は `agent.spawn` で、effort はそのサブエージェントの `turn.step` で書き換える。effort を持たないモデル（haiku など）では effort を書き換えない。

## Workflow の振り分け

Workflow の `agent()` は `agent.spawn` を通らないため、Workflow ツールの呼び出し（`tool.call`）でスクリプトを書き換える。`meta` の直後に `agent()` と `phase()` を包む shim を差し込み、`agent()` の opts に model と effort を足す。

- `meta.phases` のうち `detail` のあるフェーズを、`meta.description` とフェーズの `title`・`detail` で判定する。`detail` の無いフェーズは判定せず、`meta.description` の判定を使う。title だけでは誤りやすく、`{ title: 'Verify' }` は refute ではなく review と判定された
- `agent()` のフェーズは `opts.phase`、無ければ直前の `phase()` の title で決める。どちらも無い、または判定できなかったフェーズは `meta.description` の判定を使う
- opts に `model` や `effort` が書いてあれば、その項目は上書きしない
- opts の `agentType` が `general-purpose` / `claude` 以外なら、その `agent()` は書き換えない

次の場合はスクリプトを書き換えない。

- `script` を渡さない呼び出し（`name` や `scriptPath` での起動）。永続化されたスクリプトには前回差し込んだ shim が残るため、`scriptPath` での再実行は前回の振り分けのまま動く
- `meta` を読み取れない、または判定が 1 つも得られない
- スクリプト内の `workflow()` で呼んだ子の Workflow。子のスクリプトは `tool.call` を通らない

## 設定

| キー | 既定 | 内容 |
|---|---|---|
| `mode` | `apply` | `observe` にすると判定結果をステータスに出すだけで書き換えない（Workflow も同じ） |
| `endpoint` | `http://127.0.0.1:8080` | LocalJev のベース URL |
| `confidenceThreshold` | `0.5` | 採用する confidence の下限 |

## 開発

```sh
claude plugin validate plugins/agent-router
claude plugin test plugins/agent-router
claude --plugin-dir plugins/agent-router   # 手元のフォルダを読み込んで試す
```


テストキットでは `/home` 配下のパスへの `fs.read` がテストのフックに届かないため、テストの HOME は `/h` にしている。
