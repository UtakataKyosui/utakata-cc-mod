# harness-profile

開発ハーネス向けの推奨プロファイルを示し、`/harness` で必要なCLI・Notion設定・ollama接続の不足を診断するMod。

## プロファイル

| プロファイル | 含まれるプラグイン |
|---|---|
| minimal | source-citation, verification-gate, task-checkpoint |
| standard | minimal に execution-budget, trust-boundary, goal-orchestrator, change-review, workspace-isolation, auto-compact, code-finder, ctxpack-fetch を加える |
| full | standard に subagent-router, notion-knowledge, advanced-rust-cli, stack-pr を加えた全15本 |

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install harness-profile@utakata-cc-mod
```

## 使い方

`/harness [minimal|standard|full]` で診断する。引数なしの場合は `profile` 設定のプロファイルを診断する。

結果は `[OK]` / `[不足]` / `[確認不可]` の一覧で出る。診断するのは次の項目。

- プラグインの有効状態
- 必要なCLI（git, fd, rg, ctxpack, ntn, eza, bat, gh）の有無
- ollamaへの接続と、必要なモデルの有無
- `ntn whoami` によるNotion認証と、notion-knowledge の databaseId が設定されているか

自動インストールや設定変更はしない。秘密値と databaseId の値は読み取っても表示せず、設定されているかどうかだけを示す。

## 設定

| 項目 | 既定値 | 内容 |
|---|---|---|
| `profile` | `standard` | 引数なしで診断するプロファイル |
| `ollamaUrl` | `http://localhost:11434` | 接続を確認するollamaのURL |
| `models` | `tev1:4b,nimble` | 存在を確認するモデル（カンマ区切り） |
| `timeoutSeconds` | `10` | ollamaとntnの確認ごとの待ち時間の上限（2〜60秒） |

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
