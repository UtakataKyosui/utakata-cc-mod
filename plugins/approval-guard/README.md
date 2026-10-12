# approval-guard

AskUserQuestion で得た承認と、`gh` の不可逆コマンド（レビュー投稿・close・merge）の宛先が一致することを確かめる Claude Mod（function hook）。


## 導入

```text
/plugin marketplace add UtakataKyosui/utakata-cc-mod
/plugin install approval-guard@utakata-cc-mod
```

単独リポジトリ版（`approval-guard@approval-guard`）を入れていた場合は、先に `/plugin uninstall approval-guard@approval-guard` で外す。残すとフックが二重に登録される。

## 置き換える command hook

| command hook | 役割 |
| --- | --- |
| `hooks/record-review-approval.sh` | AskUserQuestion の承認を `~/.cache/claude-code/review-submit-approval` へ書く |
| `hooks/confirm-review-target.sh` | sentinel を読み、TTL 180 秒と PR 番号を照合する |
| `hooks/record-close-approval.sh` | close / merge の承認を `~/.cache/claude-code/close-merge-approval` へ書く |
| `hooks/confirm-close-issue-pr.sh` | sentinel の TTL を照合する（番号は見ない） |
| `hooks/confirm-force-push.sh` | `git push` の force 系フラグで確認プロンプト（`ask`）を出す |
| `hooks/check-pr-closes-issue.sh` | `gh pr create` の本文（`--body-file` を含む）に `Closes #nnn` か Issue 対応でない旨が無ければ拒否する |

承認まわりの 4 本のシェルスクリプトと sentinel ファイル 2 つが、1 モジュールの変数 1 つになる。

force push の確認は `ask` を返す必要があるため `classic.PreToolUse` で受ける。後続の判定を先に走らせ、`deny` が返ればそれを優先する（シェルフックでも `deny` が `ask` に勝つ）。`gh pr create` の判定は元のシェルと同じく行単位で行い、`Closes` と `#84` が改行で分かれた本文は通さない。

## command hook との挙動差

| 項目 | command hook | この Mod |
| --- | --- | --- |
| 宛先を書かない承認質問 | 通る | 質問そのものを拒否する（`rules/irreversible-target-echo.md` を構造で強制） |
| レビュー投稿の承認 | TTL 180 秒 | 1 回で使い切る |
| close / merge の承認 | TTL 180 秒、番号は照合しない | 180 秒間は再利用できる（スタック merge・失敗後の再試行）。番号を照合する |
| 番号のない close / merge | 承認があれば通る | 拒否する |
| レビュー承認で merge | 通る（別 sentinel なので実際は拒否） | 拒否する（承認の種別を区別） |

## 並走期間

上表の command hook 6 本が `settings.json` に残っていると並走する。Mod は user tier（外側）で先に判定するため、Mod が拒否すれば shell hook には届かない。command hook の登録を外したあとは `~/.cache/claude-code/` の sentinel も不要になる。

## 検証

```bash
claude plugin validate plugins/approval-guard
claude plugin test plugins/approval-guard
```


## 罠

- `tool.call` の `e` はフラット。`e.command` であり `e.input.command` ではない
- `.catch` を付けないフックは失敗時に黙って無効化される。Bash 側は fail closed、AskUserQuestion 側は pass through にしてある
- テストで `$.clock.now()` を呼ぶ経路は `mock.clock(on, ...)` を敷かないと「no implementation for clock.now」で `.catch` に落ちる
- `gh pr review --approve 1234` のように番号がフラグの後ろに来るので、番号はサブコマンド以降の位置引数から拾う
