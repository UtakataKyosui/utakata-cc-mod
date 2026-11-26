# lean-spec

機能が何をできるべきかを Lean 4 の定理として書かせ、証明・壊した実装の検出・対象コードとの同期を記録するMod。

テストは書いた入力についてだけ振る舞いを確かめる。このModでは前提と範囲を定理の仮定として書き、その範囲のすべての入力で性質が成り立つことを Lean のカーネルに検査させる。手順は [pstack の create-formal-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md) に沿っており、背景は [なぜ今形式検証なのか (Zenn)](https://zenn.dev/ncdc/articles/dcec80b0c067b0) にまとまっている。

## 前提

[elan](https://github.com/leanprover/elan) で入れた Lean 4 と lake が必要。`lake` が PATH になければ `~/.elan/bin/lake` を使う。

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y --default-toolchain stable
```

変更状態と同期の判定に git を使う。git 管理外では検査結果が「検査後に変更あり」のままになり、同期もできない。

## 流れ

プロンプトに「形式検証」「Lean」「証明して」などがあると、次の手順書を context でモデルに渡す (`autoPlaybook`)。

1. 壊れると利用者が害を受けるのにテストが届きにくい約束を対象に選ぶ。操作の順序や並行性が問題なら、Lean より TLA+ のようなモデル検査が向いていると伝える。
2. 機能ごとに「できるべきこと」を平易な 1 文で書く。安全性 (起きてはいけないこと) だけでは、常に拒否する実装でも成り立ってしまう。そのため能力 (できるべきこと) の性質を 1 つ以上入れさせる。
3. 対象コードの関数と 1 対 1 に対応する Lean のモデル (`def`) と、性質ごとの `theorem` を書く。
4. `lean_spec_check` で検査する。定理が成り立たなければ、主張を弱めずに反例をコードの言葉で報告させる。
5. `lean_spec_mutation` でモデルを壊し、定理がその壊れ方を検出できることを確かめる。
6. マニフェストに記録し、`lean_spec_sync` で syncCommit を進める。

## ツール

| ツール | 動作 |
|---|---|
| `lean_spec_init` | lake プロジェクト (`lakefile.toml`・`lean-toolchain`・ルートモジュール・`.gitignore`) と空のマニフェストを作る。toolchain は手元の `lean --version` に固定する。既存のファイルは上書きしない |
| `lean_spec_check` | `lake build <module>` のあと、`lake env lean --stdin` で各定理に `#print axioms` を実行して記録する |
| `lean_spec_mutation` | Lean ファイルの一意な文字列を置き換えて検査し、ファイルを元に戻す。検出できたか、できなかったかを記録する |
| `lean_spec_status` | 仕様ごとの証明・壊した実装の検出・同期の状態を表で返す。`/lean-spec` でも表示する |
| `lean_spec_sync` | syncCommit を HEAD に進めてマニフェストを書き換える |

`lean_spec_check` の判定は次のとおり。「証明済み」になるのは最後の行の場合だけ。

| 状況 | 判定 |
|---|---|
| ビルドが失敗した | ビルド失敗 |
| マニフェストの定理名が Lean にない | 定理が見つからない |
| `declaration uses 'sorry'` の警告、または `sorryAx` への依存がある | 未完 |
| `allowedAxioms` 以外の公理 (`axiom` 宣言、`native_decide` が作る `<定理名>._native.native_decide.ax_…` など) に依存する | 未確定 |
| 上のどれでもない | 証明済み |

`lean_spec_mutation` は、壊す前の状態で証明済みでなければ実行しない。そうしないと、失敗が壊したせいか元からかを区別できない。置き換え後の文字列に `sorry`・`admit`・`theorem` があれば拒否する。壊す対象は証明ではなくモデルである。置き換えた行の中だけで構文や名前のエラーになったときは、性質を試せていないので記録しない。

`lean_spec_sync` が syncCommit を進めるのは、次をすべて満たすときだけ。

- 今の変更状態で証明済み
- 壊した実装の検出が 1 回以上あり (`requireMutation`)、検出できなかった記録がない
- 対象コードに未コミットの変更がない

## マニフェスト

既定の場所は `.claude/lean-spec.json` (`manifestPath`)。

```json
{
  "project": "verification/lean",
  "specs": [
    {
      "id": "withdraw",
      "feature": "口座からの引き出し",
      "property": "残高不足の引き出しは拒否され、足りていれば残高はちょうど引き出し額だけ減る",
      "harm": "残高が負になり、存在しないお金が引き出される",
      "scope": "残高と金額は 0 以上の整数。並行する引き出しは扱わない",
      "module": "Spec.Account",
      "theorems": ["Spec.Account.withdraw_exact", "Spec.Account.withdraw_succeeds"],
      "covers": ["src/account.ts"],
      "syncCommit": "3f2a9c1d..."
    }
  ]
}
```

`covers` にはファイルのパスか、末尾が `/` のディレクトリを書く。対応する Lean の例を示す。

```lean
namespace Spec.Account

-- src/account.ts の withdraw
def withdraw (balance amount : Nat) : Option Nat :=
  if amount ≤ balance then some (balance - amount) else none

-- 安全性: 引き出しが成功したら、残高はちょうど引き出し額だけ減る
theorem withdraw_exact (b a r : Nat) (h : withdraw b a = some r) : r + a = b := by
  unfold withdraw at h
  split at h
  · injection h with h
    omega
  · contradiction

-- 能力: 残高が足りていれば必ず成功する
theorem withdraw_succeeds (b a : Nat) (h : a ≤ b) : withdraw b a = some (b - a) := by
  simp [withdraw, h]

end Spec.Account
```

## 編集の見張り

Edit・Write・MultiEdit の結果に、モデルだけが読む注意を付ける。

- `covers` のファイルを変えたとき、関係する仕様と定理を示し、モデルとの読み比べと `lean_spec_check` を求める。
- Lean ファイルに `sorry`・`admit`・`axiom` 宣言・`native_decide`・`implemented_by`・`debug.skipKernelTC` が入ったとき、完了と報告しないよう求める。コメント内は数えない。
- マニフェストにある定理の主張 (名前から `:=` まで) が変わったとき、主張を弱めて通していないか確認させる。証明の部分だけの変更には反応しない。

対象を編集したあと `lean_spec_check` を実行しないままターンが終わると、トーストで知らせる。マニフェストがあるリポジトリでは、システムプロンプトに短い案内を足す。

## 保存するもの

検査結果 (判定・依存公理・エラー・変更状態のハッシュ) と、壊した実装の記録 (説明・ファイル・検出の有無) を、プラグイン store にリポジトリルート単位で保存する。Lean の出力全体は保存しない。

## 制約

- 保証するのは Lean のモデルについての性質だけ。モデルが実際のコードを表しているかどうかはモデルが読み比べた範囲でしか言えず、このModは syncCommit 以降の変更を知らせることでそれを補う。
- 定理の主張の変更は正規表現で検出しているので、`theorem` の名前を変えたり、`:=` を含む型を書いたりすると見逃すことがある。
- 完了報告そのものは止められない。手順書・注意・トースト・同期の拒否で判定を守らせる。
