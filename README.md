# utakata-cc-mod

Claude Codeの動作をカスタマイズするModプラグイン集。タスクの委譲、調査、コンテキスト管理、検証などを組み合わせて開発ハーネスとして利用する。

各プラグインの使い方・設定・制約は個別のREADMEを参照。

## 導入

Claude Modのフックを実行できるClaude Code環境が必要。

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install <プラグイン名>@utakata-cc-mod
```

## marketplace登録済み

| プラグイン | 役割 |
|---|---|
| [goal-orchestrator](plugins/goal-orchestrator/README.md) | /goal の内容をタスク分解・TODO化・実行順序付けし、各タスクを SubAgent に委譲させる |
| [auto-compact](plugins/auto-compact/README.md) | ターン終了時の使用率やキャッシュ失効を見て自動で Compaction し、要約をテキストに保存する |
| [subagent-router](plugins/subagent-router/README.md) | SubAgent の起動時に、model と effort を ollama の決定モデル (nimble) に判断させて振り分ける |
| [advanced-rust-cli](plugins/advanced-rust-cli/README.md) | Rustで実装された基礎的なコマンドの改善版のみを常に使用するように挙動を変更するMod |
| [code-finder](plugins/code-finder/README.md) | fd と ripgrep でファイル名・コード内容を検索するツール (find_files / search_code) をモデルに提供する |
| [ctxpack-fetch](plugins/ctxpack-fetch/README.md) | WebFetch を禁じ、ctxpack でノイズを除いた Web ページを取得するツール (fetch_page) を提供する |
| [source-citation](plugins/source-citation/README.md) | 情報収集した内容を回答やファイルに書くとき、出典 (URL) の併記を必須にする |
| [notion-knowledge](plugins/notion-knowledge/README.md) | Notion データベースをナレッジベースにし、ollama の tev1:4b の判断で、プロンプトに関係する知識の取得と新しい知識の自動記録を行う |
| [execution-budget](plugins/execution-budget/README.md) | ゴール単位で SubAgent の起動数・同時実行数・再試行回数・経過時間に上限を設け、到達したら新しい起動を止めて進捗と残作業を保存する。使用量と診断ログも記録する |
| [trust-boundary](plugins/trust-boundary/README.md) | Web・Notion など外部由来の内容を参考データとして扱い、取得後の設定変更・外部送信・公開系の操作を要確認にし、送信先 allowlist と秘密検査で外部へ送る内容を制限するMod |
| [task-checkpoint](plugins/task-checkpoint/README.md) | ゴールとタスクの状態をローカルに保存し、Compaction や再開のあとに実際のファイルと照合して復元する |
| [workspace-isolation](plugins/workspace-isolation/README.md) | 書き込みを行う並列タスクに専用 git worktree を割り当て、ベース・担当範囲・成果差分を追跡し、競合と範囲外変更を検出してから安全に統合するMod |
| [change-review](plugins/change-review/README.md) | 実装後の差分を、実装者とは別の読み取り専用レビュアー SubAgent に点検させるMod。指摘の形式検証、再レビュー回数の上限、未実施・未解決の明示を行う |
| [verification-gate](plugins/verification-gate/README.md) | リポジトリごとの検証コマンドと受け入れ条件を登録し、実行結果と変更状態の記録に基づいて完了を判定させるMod |
| [harness-profile](plugins/harness-profile/README.md) | 開発ハーネス用の推奨プロファイル (minimal / standard / full / local-llm) を示し、/harness で必要な CLI・Notion 設定・ローカルLLM設定・ollama 接続の不足を診断する |
| [stack-pr](plugins/stack-pr/README.md) | Issue の実装を頼まれたとき、変更範囲を見積もらせ、大規模なら gh stack の Stack PR に分割して進めさせる |

## 組み合わせ

[harness-profile](plugins/harness-profile/README.md) の `/harness` で、推奨プロファイルに対する依存CLI・Notion設定・ollama接続の不足を確認できる。

- 委譲: goal-orchestratorで手順を渡し、subagent-routerでモデルを選び、execution-budgetで起動を制限する。
- 状態管理: auto-compactで会話を圧縮し、task-checkpointで明示的に記録したタスク台帳を復元する。
- 品質確認: verification-gateで検証コマンドを実行し、その結果をchange-reviewへの依頼に含める。
- 調査と知識: code-finder、ctxpack-fetch、source-citation、notion-knowledgeを使い、trust-boundaryで対象の送信と操作を検査する。
- 並列実装: workspace-isolationで作業領域と統合を管理する。

各プラグインを併用するだけで、タスクや検証結果がすべて自動同期するわけではない。連携方法と制御範囲は個別READMEを参照。

## 開発

リポジトリルートで実行する。

```sh
pnpm install
pnpm run validate:all
pnpm run test:all
pnpm run test:integration
```

`validate:all` と `test:all` は全プラグインを順に検証する。`test:integration` は実プラグインを組み合わせた統合テストで、bun が必要。workspace-isolation の実 git を使うテストは `bun test ./plugins/workspace-isolation/tests/git.itest.ts` で実行する。

ローカルLLM(ollama)を使う各プラグインの共通呼び出し基盤は [shared/local-llm](shared/local-llm/README.md) にある。正本を編集したら `pnpm run sync:local-llm` で各プラグインへ同梱コピーを更新する(ずれは `test:integration` で検出する)。基盤自体のテストは `pnpm run test:shared`。

ローカルLLM併用の評価(off / auto / always の比較手順、機密を含まないフィクスチャ、計測レコードとレポート)は [evals/local-llm](evals/local-llm/README.md) にある。通常のテストはモックで動き(`pnpm run test:evals`、`test:integration` にも含む)、実 Claude・実 ollama での測定は手動手順として分けている。効果は未測定で、削減率は保証しない。

Mod対応のClaude Codeで実行する。確認した環境(Claude Code 2.1.289)と制約は [harness-profile](plugins/harness-profile/README.md) を参照。依存CLIや外部サービスの前提条件は各READMEに記載している。
