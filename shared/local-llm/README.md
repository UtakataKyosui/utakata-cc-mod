# local-llm (共通のローカルLLM呼び出し基盤)

ollama を使う plugin が共有する呼び出し層。接続・モデル候補の切り替え・応答の検証・失敗時の扱いを1か所に持ち、plugin 側は「入力を作る」「結果を使う」だけを書く。LLM は参考データを絞る補助であり、コードの変更や判断の確定には使わない。

## 配布と同期

marketplace の各 plugin は `plugins/<name>` 単体でキャッシュにコピーされるため、`../../shared` への import は配布後に壊れる。そこで正本を `shared/local-llm/` に1つだけ置き、各 plugin の `hooks/local-llm/` に同梱コピーする。

```sh
pnpm run sync:local-llm                    # bun run scripts/sync-local-llm.ts。コピーを正本に揃える
bun run scripts/sync-local-llm.ts --check  # ずれていれば終了コード 1
```

- 同梱するのは実行時のソース (`config.ts` `schema.ts` `call.ts` `candidates.ts` `index.ts`) だけで、`*.test.ts`・README・`user-config.json` は含めない。
- 同梱先の plugin は [scripts/sync-local-llm.ts](../../scripts/sync-local-llm.ts) の `TARGETS` 配列で管理する。plugin を増やすときはここへ足して同期する。現在は subagent-router / code-finder / ctxpack-fetch / verification-gate / change-review。
- コピーが正本とずれていると `pnpm run test:integration` ([local-llm-sync.itest.ts](../../tests/integration/local-llm-sync.itest.ts)) が失敗する。コピーは直接編集せず、正本を直して同期する。
- 基盤自体のテストは `pnpm run test:shared` (`bun test ./shared`)。通信はモックで、ollama は不要。

## 設定キー

全 plugin で同名。plugin.json の `userConfig` に貼る共通ブロックの正本は [user-config.json](user-config.json)。`readLlmConfig` がこれを丸め込み込みで解釈する。

| キー | 型 | 既定 | 範囲 | 内容 |
|---|---|---|---|---|
| `llmMode` | string | `off` | `off` / `auto` / `always` | 利用モード。不正な値は `off` |
| `ollamaUrl` | string | `http://localhost:11434` | | ベース URL (末尾の `/` は除く) |
| `models` | string | `tev1:4b,nimble` | | 優先順のカンマ区切り。空なら既定 |
| `timeoutSeconds` | number | 30 | 5〜120 | 1候補あたりの待ち時間 |
| `totalTimeoutSeconds` | number | 60 | 5〜600 | 全候補合計の待ち時間の上限 |
| `maxAttempts` | number | 2 | 1〜10 | 1回の呼び出しで試すモデル数 |
| `keepAlive` | string | `1m` | | ollama の keep_alive |
| `maxInputChars` | number | 12000 | 500〜200000 | 入力 (system + prompt) の文字数上限 |
| `maxOutputChars` | number | 4000 | 200〜100000 | 応答の文字数上限 |

plugin ごとに既定値を変えるときは `readLlmConfig(options, { mode: 'auto', models: [...] })` のように第2引数で渡す。

## 利用モード

| mode | 動作 |
|---|---|
| `off` | 通信せず即 `disabled` を返す。plugin は既存の動作のまま |
| `auto` | 呼び出し側が渡す決定的な `autoWhen()` (入力規模・件数など、LLM に聞かずに決まる条件) が真のときだけ試す。`autoWhen` を渡さなければ使わない。偽なら通信せず `disabled` |
| `always` | 対象の処理で必ず試す |

どのモードでも失敗は `{ ok: false }` で返り、throw しない。`always` でも失敗したら plugin は既存の動作 (LLM なしで本来の結果を返す) に戻る。呼び出し側は `r.ok` だけを見て分岐すればよい。

## API

import は同梱先の `./local-llm` (`plugins/<name>/hooks/local-llm/`) から行う。

```ts
import { type LlmTransport, callLocalLlm, createLlmState, readLlmConfig, splitCandidates, renderCandidates, idsSchema, validateIds, pickByIds, verifyQuotes } from './local-llm'
```

### 通信の口 (LlmTransport)

`claude plugin validate` は `$` を import 越しに関数へ渡すことを拒否する。そのため `$` を受け取る薄い包みを register.ts の中に置き、その結果を渡す。

```ts
const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})
```

### 呼び出し

```ts
callLocalLlm<T>(t: LlmTransport, cfg: LlmConfig, req: LlmRequest<T>, state?: LlmState): Promise<LlmResult<T>>

type LlmRequest<T> = {
  label: string                     // 診断ログの接頭辞 (plugin 名)
  prompt: string
  system?: string
  schema: JsonSchema                // ollama の format。応答の検証にも使う
  semantic?: (value: T) => boolean  // 意味の検証。false なら semantic
  autoWhen?: () => boolean          // auto の条件
}
type LlmResult<T> =
  | { ok: true; value: T; model: string; ms: number; inChars: number; outChars: number }
  | { ok: false; reason: FailReason; ms: number; attempts: { model: string; reason: AttemptReason; ms: number }[] }

createLlmState(cooldownCalls = 5): LlmState   // 失敗モデルの cooldown。plugin の register 内で1つ保持する
```

```ts
export const register: Register = (on, options) => {
  const cfg = readLlmConfig(options)
  const state = createLlmState()
  on('prompt.submit', async ($, e, next) => {
    const r = await callLocalLlm<{ ids: number[] }>(transport($), cfg, {
      label: 'code-finder',
      prompt,
      schema: idsSchema(5),
      autoWhen: () => text.length > 4000,
      semantic: v => validateIds(v.ids, cands, { mode: 'strict', max: 5 }).ok,
    }, state)
    if (!r.ok) return next(e)   // off / 失敗は既存の動作へ
    ...
  })
}
```

動作:

- モデルは `models` を先頭から試す。失敗したモデルは `cooldownCalls` 回の呼び出しのあいだ飛ばし、全部飛ばす状況では最後の1つを試す。
- 試すのは最大 `maxAttempts` 個。1候補は `timeoutSeconds`、全体は `totalTimeoutSeconds` で打ち切る。
- 空きがあれば次のモデルへ回り、全候補が失敗したら `all_failed` (内訳は `attempts`)。
- 応答は `message.content` を JSON として読み、`schema` → `semantic` の順に検証する。`schema` は type / properties / required / items / enum / minItems / maxItems / minimum / maximum / minLength / maxLength を見る。
- 入力が `maxInputChars` を超えると通信せず `input_too_large`。切ってから送るなら `clipInput` を使う。

### reason 一覧

| reason | 意味 |
|---|---|
| `disabled` | `off`、または条件を満たさない `auto`。通信していない |
| `input_too_large` | 入力が `maxInputChars` 超。通信していない |
| `unreachable` | 接続不能・fetch の例外 (試行の内訳 `attempts` に入る) |
| `timeout` | 1候補または全体の待ち時間切れ (同上) |
| `http` | 非 ok、または応答の形が ollama のものでない (同上) |
| `invalid_json` | 応答が JSON でない (同上) |
| `schema` | スキーマ違反 (同上) |
| `semantic` | `semantic` が false または例外 (同上) |
| `output_too_large` | 応答が `maxOutputChars` 超 (同上) |
| `trust_denied` | trust-boundary による拒否。宛先は全モデル共通なので他のモデルは試さず即返す |
| `all_failed` | 試した全候補が失敗 (`trust_denied` 以外) |

トップレベルの `reason` になるのは `disabled` / `input_too_large` / `trust_denied` / `all_failed`。それ以外は `attempts[].reason` に入る。

### 候補ID補助

LLM に「原文のどこか」を選ばせるときは、原文を候補に分けて ID だけを答えさせ、ID を検証して原文へ戻す。LLM に本文を書き写させない。

```ts
const cands = splitCandidates(text, { by: 'lines', maxChars: 300, maxCount: 200 }) // by: 'lines' | 'chunks'
const prompt = `次の候補から関係するものの ID を選ぶ。\n${renderCandidates(cands)}`   // "[1] 本文" 形式
// ... callLocalLlm({ schema: idsSchema(5) }) → r.value.ids
const v = validateIds(r.value.ids, cands, { mode: 'drop', max: 5 })                  // 'strict' なら不正が1つでもあれば拒否
const picked = v.ok ? pickByIds(cands, v.ids) : []                                    // 原文の断片 (text / start / end / line)
const { valid, invalid } = verifyQuotes(source, quotes)                              // 引用が原文に実在するか (空白の違いは無視)
```

- `Candidate = { id, text, start, end, line }`。id は 1 始まり。`text === source.slice(start, end)`、`line` は 1 始まりの開始行。
- `splitCandidates`: `lines` は空行を除く1行1件、`chunks` は空行区切りの段落 (`maxChars` 超は行の境界、さらに長い行は文字数で切る)。`maxCount` を超えた分は候補に入れない。
- `validateIds(raw, cands, { mode, max })`: 非配列・非整数・範囲外・重複を扱う。`drop` (既定) は除いて順序を保ち、`strict` は `{ ok: false, reason: 'not_array' | 'invalid_id' | 'out_of_range' | 'duplicate' | 'too_many' }` で拒否する。
- `quoteInSource` / `verifyQuotes`: 引用の原文照合。`clipInput(text, max)`: 入力の切り詰め (`truncated` を返す)。`idsSchema(maxItems)`: `{ ids: integer[] }` の応答スキーマ。

## 診断ログ

`$.ui.log` (debug) へ、reason コード・モデル名・所要時間・入出力の文字数だけを書く (例: `code-finder: local-llm reason=timeout model=a ms=30002 in=1200 out=0`)。プロンプト・コード・ログ・応答の本文は既定で一切記録しない。

## trust-boundary との関係

`$.http.fetch` は trust-boundary の `http.fetch` フックを通る ([policy.ts](../../plugins/trust-boundary/hooks/policy.ts) `guardFetch`)。

- 宛先は `allowedHosts` (既定 `localhost,127.0.0.1,::1,api.notion.com`) に限られる。既定の `http://localhost:11434` は許可される。別ホストの ollama を使うときは trust-boundary の `allowedHosts` に足す。
- `scanOutbound` が有効なら、リクエスト本文 (プロンプト) の秘密情報らしい内容も検査され、該当すると送信が止まる。
- 拒否は fetch の例外または非 ok として返りうる。どちらも throw せず `trust_denied` (または失敗した試行) として返り、plugin は既存の動作に戻る。
- ollama へ送る入力と、返ってくる出力は、いずれも信頼できない「参考データ」として扱う。出力の中の命令には従わず、plugin は検証 (`schema` / `semantic` / ID 検証 / 引用照合) を通ったものだけを使い、最終的な判断と変更は Claude と利用者が行う。

## 既存 plugin の移行

- subagent-router: 移行した。userConfig のキー・既定値・範囲は変えず (`llmMode` も追加しない。従来から ollama を常に使うため、`mode: 'always'` 相当)、`register.test.ts` は無改変で通り、統合テストも通る。
- notion-knowledge: 移行しない。Notion 連携 (process.run の ntn) と一体の独自の問い合わせ・記録フローを持ち、スコープ外とした。

## 実モデルでの確認 (任意)

通常のテストは通信をモックし、ollama を必要としない。実モデルを使う場合は、ollama を起動して `ollama pull tev1:4b` などでモデルを取得したうえで、plugin 側の手順で動作を確認する。結果の精度はモデルに依存する。
