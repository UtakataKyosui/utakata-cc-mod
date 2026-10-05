import type { World } from './harness'

export const SC = { name: 'source-citation', dir: 'source-citation/hooks/register.ts' }
export const CTX = { name: 'ctxpack-fetch', dir: 'ctxpack-fetch/hooks/register.ts' }
export const GOAL = { name: 'goal-orchestrator', dir: 'goal-orchestrator/hooks/register.tsx' }
export const ROUTER = { name: 'subagent-router', dir: 'subagent-router/hooks/register.ts' }
export const COMPACT = { name: 'auto-compact', dir: 'auto-compact/hooks/register.ts' }
export const NOTION = (databaseId = DB) => ({ name: 'notion-knowledge', dir: 'notion-knowledge/hooks/register.ts', options: { databaseId } })
export const RUST = { name: 'advanced-rust-cli', dir: 'advanced-rust-cli/hooks/register.ts' }
export const FINDER = { name: 'code-finder', dir: 'code-finder/hooks/register.ts' }

/** 何もしないが例外だけは投げる hook を持つ、壊れたプラグインの代役。 */
export const BROKEN = { name: 'broken', dir: '../tests/integration/broken.ts' }

const DS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
export const DB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const page = (id: string, title: string) => ({
  object: 'page',
  id,
  url: `https://notion.so/${id}`,
  properties: { 名前: { type: 'title', title: [{ plain_text: title }] } },
})

const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr = 'failed') => ({ exitCode: 1, stdout: '', stderr })

/** `command -v X` に答える CLI の集合。 */
export const installed = (names: string[], extra?: World['proc']): World['proc'] => (argv, init) => {
  if (argv[0] === 'sh' && argv[1] === '-c') return names.includes(String(argv[2]).replace('command -v ', '')) ? out(`/bin/x`) : fail('')
  return extra?.(argv, init) ?? fail('unexpected')
}

/** ntn の応答。`ntnUp: false` なら whoami が失敗する。 */
export const notionWorld = (opts: { ntnUp?: boolean } = {}): World['proc'] => argv => {
  if (argv[0] !== 'ntn') return fail('unexpected')
  if (argv[1] === 'whoami') return opts.ntnUp === false ? fail('not logged in') : out('me')
  if (argv[1] === 'pages') return out(`本文 of ${argv[3]}`)
  const p = argv[2]
  if (p === `v1/databases/${DB}`) return out(JSON.stringify({ data_sources: [{ id: DS }] }))
  if (p === `v1/data_sources/${DS}`) return out(JSON.stringify({ properties: { 名前: { type: 'title' } } }))
  if (p === `v1/data_sources/${DS}/query`) return out(JSON.stringify({ results: [page('p1', 'Notion API の data source 移行メモ')] }))
  if (p === 'v1/pages' || p?.endsWith('/markdown')) return out('{}')
  return fail(`unexpected ${p}`)
}

export const writesOf = (procs: readonly (readonly string[])[]) => procs.filter(a => a[0] === 'ntn' && (a[2] === 'v1/pages' || a[2]?.endsWith('/markdown')))

export const ANSWER = 'あ'.repeat(300)
export const KNOWLEDGE = '- data_sources[] の id を取り、POST /v1/data_sources/{id}/query を呼ぶ。[0] を決め打ちしない。databases の query は 2025 年に data source へ移った'

/** ollama の判断モデルの代役。プロンプトの書き出しで役割を見分ける。 */
export const ollamaOk = (route = { model: 'haiku', effort: 'low' }): World['http'] => (_url, init) => {
  const content = JSON.parse(init!.body!).messages[0].content as string
  const reply = content.startsWith('SubAgent に任せる')
    ? route
    : content.startsWith('あなたはナレッジ記録係')
      ? { action: 'create', target: 0, title: 'Notion の query 手順', content: KNOWLEDGE }
      : { relevant: [1] }
  return { ok: true, status: 200, text: JSON.stringify({ message: { content: JSON.stringify(reply) } }) }
}
