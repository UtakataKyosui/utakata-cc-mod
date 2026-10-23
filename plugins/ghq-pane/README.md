# ghq-pane

ghq で管理しているリポジトリと、その git worktree を Pane に一覧表示する。

| コマンド | 中身 |
|---|---|
| `/ghq` | Pane を開き、一覧を取得し直す |

- リポジトリは `ghq list -p` で取得し、リポジトリごとに `git worktree list --porcelain` で worktree を調べる。ghq の外にある worktree も、本体リポジトリ経由で表示される。
- 各 worktree にはブランチ名と未コミットの変更数 (`±3`) を出す。本体は `●`、追加の worktree は `○`。リンク切れの worktree は `(prunable)` と表示する。
- worktree を押すとそのパスをクリップボードにコピーする。`Refresh` ボタンで再取得する。自動更新はしない。
- 取得結果はセッションの状態として保持する。

## 導入

```
brew install ghq
/plugin install ghq-pane@utakata-cc-mod
```

## 制約

- `ghq` と `git` が PATH に必要。
- 全リポジトリで `git status` を並列に実行するため、リポジトリが多いと初回表示まで数秒かかる。

## 実装と検証

動作の入口は [hooks](hooks/)、状態の型は [types](types/index.d.ts) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)
