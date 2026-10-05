# advanced-rust-cli

Bashでのファイル閲覧・検索に、導入済みのRust製CLIを優先させる。

## 前提と導入

使いたい代替CLIをPATH上に配置する。macOSでの導入例:

```sh
brew install eza bat fd ripgrep zoxide
```

すべてのCLIを導入する必要はない。見つかったものだけを案内・制御する。

## 挙動

| 標準コマンド | 代替 |
|---|---|
| ls | eza |
| cat | bat |
| find | fd |
| grep | rg |

`prompt.compose` で使い分けを案内し、`tool.call` でBashの対象コマンドを拒否して代替の例を返す。自動でコマンドを書き換える機能ではない。zoxideは曖昧なディレクトリ名の解決を案内するだけで、cdを拒否しない。

## 使用例と制約

```sh
eza -la --git
bat -pp README.md
fd -e ts plugins
rg -n timeoutMs plugins
```

書き出し用のcat（ヒアドキュメント・リダイレクト）は拒否しない。コマンド検出は簡易的な文字列解析で、シェル構文全体を解釈するものではない。代替CLIがなければ元のコマンドを通す。検出はキャッシュされるため、CLI導入後はセッションを起動し直す。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install advanced-rust-cli@utakata-cc-mod
```

## 設定

userConfigによる設定項目はない。


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

