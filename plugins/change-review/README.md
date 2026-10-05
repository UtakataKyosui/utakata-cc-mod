# change-review

実装者とは別のSubAgentへ差分レビューを依頼する手順と、レビュー回数・報告形式・書き込み操作の制御を提供する。

## 使い方

モデルに `subagent_type: change-review:reviewer` でAgentを起動させ、要求と受け入れ条件、差分の取り方、検証結果、触ってはいけない範囲を渡す。フック自身が自動でレビュアーを起動するわけではない。

```text
/change-review
/change-review reset
```

最初のコマンドはレビュー状況と省略可否を表示する。resetはセッション内の回数・報告状態を初期化する。

## レビューの扱い

初回と既定2回の再レビューを許可し、上限以降のレビュアー起動は拒否する。既定では2ファイル以下かつ追加・削除30行以下の変更は省略できる。認証・権限・秘密情報・削除を伴う変更は小さくても省略しないようモデルへ指示する。

指摘の書式:

```text
- [major] src/example.ts:12 | 指摘内容 | 根拠: コードから判断できる理由
確認範囲: 読んだ差分とファイル、確認できなかったこと
判定: 要修正
```

重要度はblocker / major / minor / nit。修正は実装側で行い、完了報告にはレビューの実施・省略・未実施と未解決指摘を記載する。

## 制約と連携

レビュアーのWrite / Edit / NotebookEditと、検出できた状態変更Bashを拒否する。Bash検査は正規表現による近似で、完全な読み取り専用サンドボックスではない。指摘の形式検証は指摘の正しさや実在行を保証しない。

省略可否のコマンドは `git diff --shortstat HEAD` を使うため、未追跡ファイルは含まれない。状態はメモリ内で管理し、永続化しない。[verification-gate](../verification-gate/README.md) の結果はレビュアーへの依頼に明示的に含める。

## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install change-review@utakata-cc-mod
```

## 設定

プラグイン設定の `userConfig` で次の項目を変更できる。既定値は [plugin.json](.claude-plugin/plugin.json) に定義されている。

| 項目 | 型 | 既定値 | 内容 |
|---|---|---|---|
| `skipMaxFiles` | number | `2` | 変更ファイル数と変更行数の両方がこの上限以下なら、レビューを省略してよい。0 にすると省略しない 範囲: 0〜100。 |
| `skipMaxLines` | number | `30` | 追加行と削除行の合計がこの値以下なら、ファイル数の条件と合わせてレビューを省略してよい。0 にすると省略しない 範囲: 0〜5000。 |
| `maxReReviews` | number | `2` | 初回レビューを除く、修正後の再レビューの上限。超えたレビュアーの起動は拒否し、未解決の指摘を完了報告に書かせる 範囲: 0〜10。 |


## 実装と検証

動作の入口は [hooks](hooks/)、設定は [manifest](.claude-plugin/plugin.json) を参照。開発用の検証手順は [ルートREADME](../../README.md#開発) に記載している。

[プラグイン一覧へ戻る](../../README.md)

