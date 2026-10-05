# harness-profile

開発ハーネス向けの推奨プロファイルを示し、`/harness` で必要なCLI・Notion設定・ローカルLLM設定・ollama接続の不足を診断するMod。

## プロファイル

| プロファイル | 含まれるプラグイン |
|---|---|
| minimal | source-citation, verification-gate, task-checkpoint |
| standard | minimal に execution-budget, trust-boundary, goal-orchestrator, change-review, workspace-isolation, auto-compact, code-finder, ctxpack-fetch を加える |
| full | standard に subagent-router, notion-knowledge, advanced-rust-cli, stack-pr を加えた全15本 |
| local-llm | standard と同じプラグインで、ローカルLLMの併用 (`llmMode: auto`) を前提に診断する暫定構成。効果は未測定 ([詳細](#local-llm-プロファイル-暫定未測定)) |

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install harness-profile@utakata-cc-mod
```

## 使い方

`/harness [minimal|standard|full|local-llm]` で診断する。引数なしの場合は `profile` 設定のプロファイルを診断する。

結果は `[OK]` / `[不足]` / `[確認不可]` の一覧で出る。診断するのは次の項目。

- プラグインの有効状態
- 必要なCLI（git, fd, rg, ctxpack, ntn, eza, bat, gh）の有無
- ローカルLLM設定: `llmMode` を持つプラグイン (code-finder, ctxpack-fetch, verification-gate, change-review) ごとの設定値
- ollamaへの接続と、必要なモデルの有無。常にollamaを使うプラグイン (subagent-router, notion-knowledge) があるか、`llmMode` が `off` 以外のプラグインがあるときだけ診断する
- ollamaを使うときは、trust-boundary の `allowedHosts` に `ollamaUrl` のホストが含まれるか
- `ntn whoami` によるNotion認証と、notion-knowledge の databaseId が設定されているか

自動インストールや設定変更はしない。秘密値と databaseId の値は読み取っても表示せず、設定されているかどうかだけを示す。

## 設定

| 項目 | 既定値 | 内容 |
|---|---|---|
| `profile` | `standard` | 引数なしで診断するプロファイル |
| `ollamaUrl` | `http://localhost:11434` | 接続を確認するollamaのURL |
| `models` | `tev1:4b,nimble` | 存在を確認するモデル（カンマ区切り）。各プラグインの `models` は読まないので、使うモデルと揃えて指定する |
| `timeoutSeconds` | `10` | ollamaとntnの確認ごとの待ち時間の上限（2〜60秒） |

## local-llm プロファイル (暫定・未測定)

ローカルLLM (ollama) を併用して、Claudeが読む入力 (検索結果・Webページ・失敗ログ・差分) を減らす構成。**併用の効果は未測定で、削減率や品質への影響を保証しない。** 入力を減らしても、関連情報の取りこぼしによる再調査や待ち時間で効果が相殺される可能性がある。比較手順は [evals/local-llm](../../evals/local-llm/README.md) にあり、手動評価の結果を見てから推奨設定を確定する。それまではこの構成を暫定とする。

適用条件:

- ollama が動いていて、使うモデルを取得済みである
- trust-boundary を併用するなら、`allowedHosts` に ollama のホストがある (既定の `localhost` なら追加は不要。別ホストなら足す)
- 検索結果・Webページ・失敗ログ・差分が長くなる作業で試す。短い入力では自動的に使われない

推奨の設定 (まず `auto`)。各プラグインの `llmMode` は既定で `off`。

| プラグイン | 推奨 `llmMode` | `auto` で使われる条件 |
|---|---|---|
| code-finder | `auto` | `search_code` に `purpose` があり、結果が30行以上または3000文字以上 |
| ctxpack-fetch | `auto` | `fetch_page` に `query` があり、取得本文が4000文字を超える |
| verification-gate | `auto` | 失敗ログが `outputTailChars` (既定2000文字) を超える |
| change-review | `auto` | 省略できない規模の変更 (`skipMaxFiles` / `skipMaxLines` 超) の一次点検 (`precheck_diff`) |
| subagent-router | 変更なし | `llmMode` を持たず、従来どおり常にollamaを使う |
| notion-knowledge | 対象外 | 共通のローカルLLM基盤を使わない |

設定例 (各プラグインの `userConfig`。意味と既定値は [shared/local-llm](../../shared/local-llm/README.md#設定キー) を参照)。

```json
{ "llmMode": "auto", "ollamaUrl": "http://localhost:11434", "models": "tev1:4b,nimble" }
```

失敗時の動作: どのモードでも、接続不能・タイムアウト・不正な応答・入力上限超過・trust-boundaryによる拒否のときは、`llmMode: off` と同じ既存の動作に戻る (エラーにはならない)。`always` でも同じ。LLMの選択は参考で、必要な箇所を取りこぼす場合がある。原文の取得方法は各プラグインのREADMEを参照する。

`/harness local-llm` は、対象プラグインの `llmMode` が `off` のものを「不足」、`auto` / `always` を「OK」と示す。`standard` など他のプロファイルでは `off` も「OK」で、4つとも `off` ならollamaの診断は不要になる。

### 診断で読む設定

- `llmMode` と trust-boundary の `allowedHosts` は、settings の `pluginConfigs` (`name` または `name@marketplace` のキー) の `options` から読む。キー形式は型定義の記述に基づく実装で、実セッションでの動作は未確認。
- 設定が無いプラグインは、既定値 (`llmMode` は `off`、`allowedHosts` は `localhost,127.0.0.1,::1,api.notion.com`) として扱う。settings を読めないときは「確認不可」にし、ollamaが要るかどうかも判断しない。
- 照合に使う `ollamaUrl` と `models` は、このプラグイン自身の設定。各プラグインの `ollamaUrl` や `models` は読まないので、揃っているかは別途確認する。
- `allowedHosts` の照合は trust-boundary と同じ規則 (完全一致またはサブドメイン)。harness-profile は単体で配布されるため同じ規則を持ち、一致は [tests/integration/host-parity.itest.ts](../../tests/integration/host-parity.itest.ts) で検査している。

## 制約

- `--plugin-dir` で読み込んだプラグインは `enabledPlugins` に現れないため、有効状態は「不足（検出できない場合あり）」になる。
- Notion未認証の場合は `ntn login` を自分で実行するよう案内するだけで、認証は行わない。
- プラグイン設定のキー形式 `name@marketplace` は型定義の記述に基づく実装で、実セッションでの `/harness` 実行は未確認。

## 統合テスト

実プラグイン同士の組み合わせを、リポジトリルートの `tests/integration/` で検証する。bun が必要。

```sh
pnpm run test:integration
```

検証する組み合わせは次の3つ。

- ctxpack-fetch と source-citation
- goal-orchestrator と subagent-router
- auto-compact と notion-knowledge

あわせて、hookの順序、`prompt.compose` のセクション追加、拒否、タイムアウト、依存先（ollama・ntn・ctxpack）の停止が他のプラグインへ及ぼす影響を確認する。統合テストは実エンジンではなく模擬エンジン上で動く。実エンジンの連鎖規則は [engine.test.ts](hooks/engine.test.ts) で照合している。

## 確認した環境

- Claude Code 2.1.289（macOS）、bun 1.4.2
- `claude plugin test` は検証対象のプラグインしか読み込めない。そのため、実プラグインの同時検証は bun で行う。
- 模擬エンジンは `turn.step`（ストリーミング）を扱わず、hookの実時間予算も模擬しない。

[プラグイン一覧へ戻る](../../README.md)
