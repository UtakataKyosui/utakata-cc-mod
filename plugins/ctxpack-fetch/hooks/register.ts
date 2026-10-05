import type { Register } from 'claude-code'
import { type FetchPageInput, clipText, ctxpackArgs, denyText, guidance, isHttpUrl, readConfig } from './policy'

const FETCH = 'mcp__ctxpack-fetch__fetch_page'

let available: Promise<boolean> | undefined

function hasCtxpack($: any): Promise<boolean> {
  available ??= $.process
    .run(['sh', '-c', 'command -v ctxpack'])
    .then((r: { exitCode: number }) => r.exitCode === 0)
    .catch(() => false)
  return available as Promise<boolean>
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

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
              description: '探したい話題のキーワード。関連するセクションが先頭に来る',
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
    return { result: clipText(r.stdout, cfg.maxChars) }
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
