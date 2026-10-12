# session-guard

同じ作業ディレクトリで動く別の Claude Code セッションを検出し、Git Worktree や jj workspace への移行を促す Claude Mod（function hook）。


## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install session-guard@utakata-cc-mod
```

単独リポジトリ版（`session-guard@session-guard`）を入れていた場合は、先に `/plugin uninstall session-guard@session-guard` で外す。残すとフックが二重に登録される。

## 置き換える command hook

| command hook | 実装 | 挙動 |
| --- | --- | --- |
| `worktree-guard.sh`（SessionStart） | `hooks/register.ts`、`hooks/worktree-guard.ts` | `ps` と `lsof` で同じ cwd のメインの claude プロセスを数え、1 件以上なら `WORKTREE-GUARD:` で始まる文脈を足す |

`session.start` では文脈を足せないため、`classic.SessionStart` の `additionalContext` で返す。

## 元のシェルと合わせた挙動

- 自セッションは、`sh -c 'echo $$; exec ps -eo pid,ppid,args'` で走らせた `ps` の親から祖先をたどって除外する。元のシェルがフックの祖先をすべて除外していたのと同じ。`exec` しても PID は変わらないため、先頭行の PID で自分の `ps` を特定する（コマンド文字列で探すと、同時に起動した別セッションの `ps` と取り違えうる）
- 今の `jj workspace list` は `(current)` を出さない。元のシェルは `pipefail` で `default:` に落ちていたため、`.jj` があれば判定に進む。この Mod も同じにしている
- `.jj` と `.git` は、元の `-d` と同じくディレクトリのときだけ数える。`.git` がファイルの worktree では汎用のメッセージになる
- worktree 内の判定は、元の `grep '/.claude/worktrees/'` と同じく `.` を任意の 1 文字として扱う
- 対象にするのは、`claude` で始まるか `/claude` の直後が空白か行末のプロセスだけ。`node /x/claude/server.js` のようなサブプロセスは数えない

## 検証

```bash
claude plugin validate plugins/session-guard
claude plugin test plugins/session-guard
```

別の claude が動いているディレクトリで `claude -p --setting-sources project --plugin-dir plugins/session-guard` を起動すると、実際に文脈が足されることを確かめられる。

