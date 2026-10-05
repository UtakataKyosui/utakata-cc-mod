import type { Register } from 'claude-code'
import {
  type Config, type Decision, type Entry,
  FAILURE_BACKOFF_MS, MIN_ANSWER_CHARS, MIN_PROMPT_CHARS, RECORD_SCHEMA, SELECT_SCHEMA,
  apiArgs, buildChatBody, buildContext, buildDuplicatePrompt, buildRecordPrompt, buildSelectPrompt, clipText, isTrivial, looksSensitive,
  pagesGetArgs, parseRecord, parseSelection, queryBody, readConfig, richText, sameTitle, titleContains, titlePropertyName, toEntry,
} from './policy'

const NTN_TIMEOUT_MS = 60_000
const CATALOG_TTL_MS = 5 * 60_000

type Catalog = { at: number; dataSourceId: string; titleProp: string; entries: Entry[] }

type State = {
  catalog: Catalog | undefined
  lastPrompt: string | undefined
  failedUntil: number
  recording: boolean
  ntn: Promise<boolean> | undefined
}

async function api($: any, path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<any> {
  const r = await $.process.run(apiArgs(path, method, body !== undefined), {
    stdin: body === undefined ? '' : JSON.stringify(body),
    timeoutMs: NTN_TIMEOUT_MS,
  })
  if (r.exitCode !== 0) throw new Error(`ntn api ${method} ${path}: ${clipText(r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`, 300)}`)
  const json = JSON.parse(r.stdout)
  if (json?.object === 'error') throw new Error(`Notion API (${json.code}): ${json.message}`)
  return json
}

const hasNtn = ($: any, state: State): Promise<boolean> =>
  (state.ntn ??= $.process
    .run(['ntn', 'whoami'], { stdin: '', timeoutMs: 15_000 })
    .then((r: { exitCode: number }) => r.exitCode === 0)
    .catch(() => false))

/** database から data source を 1 つに決める。複数あるときは決められないので失敗させる。 */
async function resolveDataSource($: any, databaseId: string): Promise<string> {
  const db = await api($, `v1/databases/${databaseId}`, 'GET')
  const sources: { id: string }[] = db.data_sources ?? []
  if (sources.length !== 1) throw new Error(`データベースの data source が ${sources.length} 個ある。1 つだけのデータベースを指定すること`)
  return sources[0]!.id
}

async function loadCatalog($: any, state: State, cfg: Config, force = false): Promise<Catalog> {
  const now = await $.clock.now()
  const cached = state.catalog
  if (!force && cached !== undefined && now - cached.at < CATALOG_TTL_MS) return cached

  const dataSourceId = cached?.dataSourceId ?? (await resolveDataSource($, cfg.databaseId!))
  const ds = await api($, `v1/data_sources/${dataSourceId}`, 'GET')
  const titleProp = titlePropertyName(ds.properties ?? {})
  if (titleProp === undefined) throw new Error('タイトル列がない')
  const res = await api($, `v1/data_sources/${dataSourceId}/query`, 'POST', queryBody(cfg.catalogSize))
  const entries = (res.results ?? []).filter((p: { object?: string }) => p.object === 'page').map(toEntry)
  return (state.catalog = { at: now, dataSourceId, titleProp, entries })
}

/** 判断モデルに構造化出力で答えさせる。失敗したモデルは次へ回し、全部失敗なら undefined。 */
async function ask($: any, state: State, cfg: Config, format: object, content: string): Promise<string | undefined> {
  if ((await $.clock.now()) < state.failedUntil) return undefined
  for (const model of cfg.models) {
    try {
      const call = $.http.fetch(`${cfg.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: buildChatBody(cfg, model, format, content),
      })
      const res = await Promise.race([call, $.clock.sleep(cfg.timeoutMs).then(() => undefined)])
      if (res === undefined || !res.ok) throw new Error(res === undefined ? 'timeout' : `HTTP ${res.status}`)
      const text = (JSON.parse(res.text) as { message?: { content?: string } }).message?.content
      if (typeof text === 'string') return text
    } catch (err) {
      $.ui.log(`notion-knowledge: ${model} failed (${String(err)})`, { to: 'debug' })
    }
  }
  state.failedUntil = (await $.clock.now()) + FAILURE_BACKOFF_MS
  return undefined
}

async function retrieve($: any, state: State, cfg: Config, prompt: string): Promise<string | undefined> {
  const { entries } = await loadCatalog($, state, cfg)
  if (entries.length === 0) return undefined
  const answer = await ask($, state, cfg, SELECT_SCHEMA, buildSelectPrompt(prompt, entries, cfg.maxPages))
  if (answer === undefined) return undefined
  const picked = parseSelection(answer, entries.length, cfg.maxPages).map(i => entries[i]!)
  if (picked.length === 0) return undefined

  const pages = (
    await Promise.all(
      picked.map(async e => {
        const r = await $.process.run(pagesGetArgs(e.id), { stdin: '', timeoutMs: NTN_TIMEOUT_MS }).catch(() => undefined)
        return r !== undefined && r.exitCode === 0 ? { title: e.title, url: e.url, body: r.stdout as string } : undefined
      }),
    )
  ).filter((p): p is { title: string; url: string; body: string } => p !== undefined)
  if (pages.length === 0) return undefined

  $.ui.toast(`notion-knowledge: ${pages.length} 件のナレッジを添付 (${pages.map(p => p.title).join(' / ')})`)
  return buildContext(pages, cfg.maxChars)
}

async function write($: any, state: State, cfg: Config, d: Decision, catalog: Catalog): Promise<string | undefined> {
  if (d.action === 'none') return undefined
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)

  if (d.action === 'append') {
    const target = catalog.entries[d.target]!
    await api($, `v1/pages/${target.id}/markdown`, 'PATCH', {
      type: 'insert_content',
      insert_content: { content: `\n\n## 追記 ${date}\n${d.content}`, position: { type: 'end' } },
    })
    return `「${target.title}」に追記した`
  }

  // 一覧に載らない古いページと重複しないよう、作る直前にサーバー側でも題名を探す
  const found = await api($, `v1/data_sources/${catalog.dataSourceId}/query`, 'POST', queryBody(100, titleContains(catalog.titleProp, d.title)))
  if ((found.results ?? []).map(toEntry).some((e: Entry) => sameTitle(e.title, d.title))) return undefined

  await api($, 'v1/pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: catalog.dataSourceId },
    properties: { [catalog.titleProp]: { title: richText(d.title) } },
    markdown: `${d.content}\n\n---\n自動記録: ${date}`,
  })
  return `「${d.title}」を新規に記録した`
}

async function record($: any, state: State, cfg: Config, prompt: string, answer: string) {
  if (state.recording) return
  state.recording = true
  try {
    const catalog = await loadCatalog($, state, cfg)
    const raw = await ask($, state, cfg, RECORD_SCHEMA, buildRecordPrompt(prompt, answer, catalog.entries))
    if (raw === undefined) return
    let decision = parseRecord(raw, catalog.entries.length)
    if (decision.action === 'none') return
    if (decision.action === 'create' && catalog.entries.length > 0) {
      // 4B の判断は create に偏って重複を作りやすいので、同じ話題の既存ページがないか絞った質問で確かめる
      const same = await ask($, state, cfg, SELECT_SCHEMA, buildDuplicatePrompt(decision.title, decision.content, catalog.entries))
      const target = same === undefined ? undefined : parseSelection(same, catalog.entries.length, 1)[0]
      if (target !== undefined) decision = { action: 'append', target, content: `### ${decision.title}\n${decision.content}` }
    }
    if (looksSensitive(decision.content) || (decision.action === 'create' && looksSensitive(decision.title))) {
      $.ui.log('notion-knowledge: 秘密情報らしい文字列を含むため記録しなかった', { to: 'debug' })
      return
    }
    const done = await write($, state, cfg, decision, catalog)
    if (done !== undefined) {
      state.catalog = undefined
      $.ui.toast(`notion-knowledge: ${done}`)
    }
  } finally {
    state.recording = false
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state: State = { catalog: undefined, lastPrompt: undefined, failedUntil: 0, recording: false, ntn: undefined }

  on('prompt.submit', async ($, e, next) => {
    if (cfg.databaseId === undefined || e.turnId !== undefined || isTrivial(e.text, MIN_PROMPT_CHARS)) return next(e)
    state.lastPrompt = e.text
    try {
      if (await hasNtn($, state)) {
        const context = await retrieve($, state, cfg, e.text)
        if (context !== undefined) return next({ ...e, context: [...(e.context ?? []), context] })
      }
    } catch (err) {
      $.ui.log(`notion-knowledge: retrieval failed (${String(err)})`, { to: 'debug' })
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    const prompt = state.lastPrompt
    if (cfg.autoRecord && cfg.databaseId !== undefined && prompt !== undefined && e.agentId === undefined && e.reason === 'answer' && !isTrivial(e.answer, MIN_ANSWER_CHARS)) {
      state.lastPrompt = undefined
      $.clock.after(0, () => void hasNtn($, state).then(ok => (ok ? record($, state, cfg, prompt, e.answer) : undefined)).catch((err: unknown) => $.ui.log(`notion-knowledge: record failed (${String(err)})`, { to: 'debug' })))
    }
    return next(e)
  })
}
