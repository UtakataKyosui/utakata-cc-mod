import type { Register } from 'claude-code'
import {
  type Config, type FetchPageInput, MAX_CANDIDATES, MAX_PICK, autoWhen, buildExtractPrompt, clipText, ctxpackArgs, denyText, extractSystem,
  guidance, isHttpUrl, parseParts, readConfig, renderPicked, shouldExtract, splitPage, validPick,
} from './policy'
import { type LlmState, type LlmTransport, callLocalLlm, createLlmState, idsSchema, pickByIds, validateIds } from './local-llm'

const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const FETCH = 'mcp__ctxpack-fetch__fetch_page'

let available: Promise<boolean> | undefined

function hasCtxpack($: any): Promise<boolean> {
  available ??= $.process
    .run(['sh', '-c', 'command -v ctxpack'])
    .then((r: { exitCode: number }) => r.exitCode === 0)
    .catch(() => false)
  return available as Promise<boolean>
}

/** query に関係する候補をローカル LLM に選ばせ、原文から組み立てて返す。使わない・失敗したときは undefined (既存の取得結果に戻る)。 */
async function extract($: any, cfg: Config, state: LlmState, input: FetchPageInput, stdout: string): Promise<string | undefined> {
  if (!shouldExtract(cfg.llm, input, stdout)) return undefined
  const cands = splitPage(stdout)
  if (cands.length <= MAX_PICK || cands.length > MAX_CANDIDATES) return undefined
  const r = await callLocalLlm<{ ids: number[] }>(
    transport($),
    cfg.llm,
    {
      label: 'ctxpack-fetch',
      system: extractSystem,
      prompt: buildExtractPrompt(input.query!, cands, cfg.llm.maxInputChars),
      schema: idsSchema(MAX_PICK),
      autoWhen: () => autoWhen(stdout),
      semantic: v => validPick(v, cands),
    },
    state,
  )
  if (!r.ok) return undefined
  const v = validateIds(r.value.ids, cands, { mode: 'strict', max: MAX_PICK })
  if (!v.ok || v.ids.length === 0) return undefined
  const ids = [...v.ids].sort((a, b) => a - b)
  return renderPicked(input, stdout, pickByIds(cands, ids), cands.length, cfg.maxChars, 'extract')
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state = createLlmState()

  on('session.start', async ($, e, next) => {
    if (await hasCtxpack($)) {
      await $.tool.register({
        name: 'fetch_page',
        description:
          'ctxpack で URL のページを取得し、ナビゲーションや広告などのノイズを除いたコンパクトな Markdown を返す。WebFetch の代わりに使う。',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '取得するページの URL (http / https)' },
            query: {
              type: 'string',
              description: '探したい話題のキーワード。関連するセクションが先頭に来る。ローカル LLM の抽出が有効なときは、関係する段落の抽出にも使う',
            },
            full: {
              type: 'boolean',
              description: '抽出された結果ではなく、取得した本文の全文 (maxChars まで) を返す',
            },
            parts: {
              type: 'string',
              description: '抽出結果の候補ID・範囲 (例 3-6,9)。同じ url と query を渡し、指定した箇所の原文だけを返す',
            },
          },
          required: ['url'],
        },
      })
    }
    return next(e)
  })

  on('tool.call', { tool: FETCH }, async ($, e, next) => {
    const input = e as unknown as FetchPageInput
    if (!isHttpUrl(input.url)) return { deny: 'url must be an http(s) URL' }
    const r = await $.process.run(ctxpackArgs(input), { timeoutMs: 60_000 })
    if (r.exitCode !== 0) return { deny: `ctxpack failed: ${r.stderr.trim() || `exit ${r.exitCode}`}` }
    if (input.parts !== undefined) {
      const cands = splitPage(r.stdout)
      const ids = typeof input.parts === 'string' ? parseParts(input.parts, cands.length) : undefined
      if (ids === undefined) return { deny: `parts は候補ID または範囲 (例 3-6,9) で、1〜${cands.length} の範囲で指定する` }
      return { result: renderPicked(input, r.stdout, pickByIds(cands, ids), cands.length, cfg.maxChars, 'parts') }
    }
    return { result: (await extract($, cfg, state, input, r.stdout)) ?? clipText(r.stdout, cfg.maxChars) }
  })

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) =>
    (await hasCtxpack($)) ? { deny: denyText } : next(e),
  )

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return (await hasCtxpack($))
      ? { sections: [...composed.sections, { id: 'ctxpack-fetch:guidance', text: guidance, scope: 'session' }] }
      : composed
  })
}
