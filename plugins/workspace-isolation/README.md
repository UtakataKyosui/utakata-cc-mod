# workspace-isolation

書き込みタスクに専用Git worktreeを割り当て、担当範囲と競合を確認してから元の作業ツリーへ差分を統合する。

## 前提と使い方

コミット済みHEADのあるGitリポジトリが必要。モデルが呼び出すツールの接頭辞は `mcp__workspace-isolation__`。

| ツール | 主な入力 | 動作 |
|---|---|---|
| workspace_assign | id, mode, scope, description | worktreeまたは読み取りタスクを登録 |
| workspace_status | なし | タスク状態を一覧 |
| workspace_check | id | 範囲外変更・重なり・適用競合を確認 |
| workspace_integrate | id | 元の作業ツリーへ差分を適用 |
| workspace_verify | id | 統合後の検証コマンドを実行 |
| workspace_collect | id（省略で全件） | 未完了の成果をパッチへ保存 |

割り当て例:

```json
{"id":"auth","mode":"write","scope":["src/auth/**","tests/auth/**"],"description":"認証処理を整理する"}
```

返されたworktreeのパスをSubAgentへ渡し、その場所で作業させる。assignだけでSubAgentの作業ディレクトリが自動変更されるわけではない。

## 統合と回収

書き込みタスクには `ws/<id>` ブランチを作る。開始前のユーザー変更は元の作業ツリーに残り、専用worktreeへは含まれない。統合はパッチの適用可否を確認して行い、上書き・3-wayマージ・commit・pushはしない。統合済みと検証済みを区別し、verifyCommandが空なら検証済みへ進めない。

セッション終了時は既定で差分を回収し、worktreeとブランチを残す。回収や状態確認が失敗した場合は元のworktreeを確認する。

台帳はGitの共通ディレクトリ配下の `workspace-isolation/tasks.json`、回収パッチは同じ場所の `patches/` に保存する。作業ファイルのREADMEやソースと一緒には保存しない。

## 制約

担当範囲は統合前の検査であり、タスク中のファイルアクセスを隔離するサンドボックスではない。破壊的Gitコマンドの拒否もBash文字列の検出に限る。verifyCommandは元の作業ツリーでシェル経由で実行するため、自分で管理する検証コマンドを設定する。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install workspace-isolation@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `verifyCommand` | string | `""` | 統合した差分に対して作業ツリーで実行するコマンド (例: npm test)。成功したタスクだけを検証済みにする。空のあいだは検証済みにならない |
| `worktreeRoot` | string | `""` | タスクごとの worktree を作るディレクトリ。空ならリポジトリと同じ階層の <リポジトリ名>-workspaces |
| `guardDestructive` | boolean | `true` | Bash の reset --hard、clean -f、強制 push、worktree の強制削除を実行前に拒否する |
| `autoCollect` | boolean | `true` | セッション終了時、未統合の書き込みタスクの差分をパッチファイルとして保存する。worktree やブランチは削除しない |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)
