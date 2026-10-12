# bash-hints

Bash の呼び出しに、専用ツールへの誘導・rust-parallel・mise exec・pueue デーモンのヒントを足し、長い `sleep` を止める Claude Mod（function hook）。


## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install bash-hints@utakata-cc-mod
```

単独リポジトリ版（`bash-hints@bash-hints`）を入れていた場合は、先に `/plugin uninstall bash-hints@bash-hints` で外す。残すとフックが二重に登録される。

## 置き換える command hook

すべて `classic.PreToolUse`（Bash）で受ける。

| command hook | 実装 | 挙動 |
| --- | --- | --- |
| `prefer-dedicated-tools.sh` | `hooks/dedicated-tools.ts` | `cat` / `grep -r` / `find` / `sed -i` などに Read・Grep・Glob・Edit を勧める文脈を足す |
| `prefer-background-over-sleep.sh` | `hooks/background-over-sleep.ts` | 2 秒を超える `sleep` を拒否する |
| `suggest-rust-parallel.sh` | `hooks/rust-parallel.ts` | 同じコマンドの `&&` 連結（3 回以上）と `for` ループに rust-parallel を勧める |
| `prefer-mise-exec.sh` | `hooks/mise-exec.ts` | リポジトリのルートに `mise.toml` があるとき、裸の `pnpm` / `node` / `npx` に `mise exec --` を勧める |
| `pueue-daemon-guard.sh` | `hooks/pueue-guard.ts` | `pueue` を呼ぶのにデーモンが止まっていれば知らせる |

## 併用

[advanced-rust-cli](../advanced-rust-cli/README.md) とは助言が逆になる。`cat` / `grep` / `find` に対し、bash-hints は Read・Grep・Glob を勧め、advanced-rust-cli は `bat` / `rg` / `fd` を使うよう拒否する。どちらか一方を入れる。

## 元のシェルと合わせた挙動

元のシェルを macOS で実行した結果を正としている。スクリプトのコメントの意図とは食い違うが、次の 2 点はそのまま移した。

- `prefer-dedicated-tools.sh` は `read -ra` が 1 行しか読まないため、最初の `|` `;` `&` 改行までの 1 セグメントしか検査していなかった
- `prefer-mise-exec.sh` の `mise exec --` の除去は、BSD `sed` が `\+` を解釈しないため効いていなかった。結果として `mise exec -- pnpm` は検出されない

`grep` は行単位で判定するため、行頭の `^` には `m` フラグを付けている。

## 検証

```bash
claude plugin validate plugins/bash-hints
claude plugin test plugins/bash-hints
```

`classic.PreToolUse` はテストキットでは発火しない（テスト側が `tool.call` を答える下で起こるため）。フックの登録まで確かめるときは、`claude -p --setting-sources project --plugin-dir plugins/bash-hints` で実際に走らせる。

