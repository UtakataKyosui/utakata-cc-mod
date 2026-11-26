---
title: utakata-cc-mod
description: Claude Code の動作をカスタマイズする Mod 集。タスクの委譲、調査、コンテキスト管理、検証などを組み合わせて開発ハーネスとして使う。
---

utakata-cc-mod は Claude Code の動作をカスタマイズする Mod (プラグイン) の集まりである。タスクの委譲、調査、コンテキスト管理、検証などの Mod を組み合わせて、開発ハーネスとして使う。

## 始め方

Claude Code で marketplace を登録し、使う Mod を選んでインストールする。手順は[導入](/install)にある。

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install <プラグイン名>@utakata-cc-mod
```

## Mod を探す

[Mod 一覧](/mods)に、すべての Mod を分類ごとに並べている。どの Mod を一緒に入れるか、どれを同時に入れてはいけないかは[組み合わせ](/combinations)を参照する。

各 Mod のページは、リポジトリの `plugins/<名前>/README.md` から生成している。内容を直すときは README を編集する。
