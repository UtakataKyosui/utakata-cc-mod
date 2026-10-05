import type { Register } from 'claude-code'
import {
  type Config, type FindFilesInput, type SearchCodeInput, NARROW_MAX_PICK, NARROW_SYSTEM, clip, fallbackNote, fdArgs, formatNarrowed, formatResult,
  guidance, narrowCandidates, narrowPrompt, purposeOf, readConfig, rgArgs, shouldNarrow, validPick,
} from './policy'
import { type LlmState, type LlmTransport, callLocalLlm, createLlmState, idsSchema } from './local-llm'

const FIND = 'mcp__code-finder__find_files'
const SEARCH = 'mcp__code-finder__search_code'
const PRE_FILTER_LIMIT = 1000

async function has($: any, name: string): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(['sh', '-c', `command -v ${name}`])
    return exitCode === 0
  } catch {
    return false
  }
}

let available: Promise<{ fd: boolean; rg: boolean }> | undefined

function detect($: any): Promise<{ fd: boolean; rg: boolean }> {
  available ??= Promise.all([has($, 'fd'), has($, 'rg')]).then(([fd, rg]) => ({ fd, rg }))
  return available
}

const transport = ($: any): LlmTransport => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, o) => $.clock.sleep(ms, o),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const run = ($: any, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  $.process.run(argv, { timeoutMs: 60_000 })

/** purpose があれば検索結果をローカルLLMで絞り込む。off・小規模な auto・失敗時は既存の結果を返す。 */
async function narrow($: any, cfg: Config, state: LlmState, input: SearchCodeInput, stdout: string): Promise<string> {
  const existing = formatResult(stdout, cfg.maxResults, '一致')
  const purpose = purposeOf(input)
  if (purpose === undefined || cfg.llm.mode === 'off') return existing
  try {
    const { text, total, clipped } = clip(stdout, cfg.maxResults)
    const cands = narrowCandidates(text)
    if (cands.length === 0) return existing
    const r = await callLocalLlm<{ ids: number[] }>(transport($), cfg.llm, {
      label: 'code-finder',
      system: NARROW_SYSTEM,
      prompt: narrowPrompt(purpose, input.pattern, cands),
      schema: idsSchema(NARROW_MAX_PICK),
      autoWhen: () => shouldNarrow(cands),
      semantic: v => validPick(v.ids, cands),
    }, state)
    if (!r.ok) return r.reason === 'disabled' ? existing : existing + fallbackNote(r.reason)
    return formatNarrowed(cands, r.value.ids, { total, clipped, maxResults: cfg.maxResults, maxInputChars: cfg.llm.maxInputChars })
  } catch {
    return existing
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const state = createLlmState()

  on('session.start', async ($, e, next) => {
    const { fd, rg } = await detect($)
    if (fd) {
      await $.tool.register({
        name: 'find_files',
        description:
          'fd でファイル・ディレクトリを名前で検索する。.gitignore を尊重する。pattern は既定で正規表現 (glob: true で glob)。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'ファイル名のパターン。省略すると全件' },
            path: { type: 'string', description: '検索を始めるディレクトリ。省略するとカレント' },
            extension: { type: 'string', description: '拡張子で絞る (例: ts)' },
            type: { type: 'string', enum: ['file', 'directory'] },
            glob: { type: 'boolean', description: 'pattern を glob として扱う' },
            hidden: { type: 'boolean', description: '隠しファイル・ignore 対象も含める' },
            max_depth: { type: 'number', description: '探索する深さの上限' },
          },
        },
      })
    }
    if (rg) {
      await $.tool.register({
        name: 'search_code',
        description:
          'ripgrep でファイルの中身を検索し、path:行番号:内容 を返す。file_pattern を渡すと、fd でファイル名を絞ってからその中だけを検索する。purpose を渡すと、結果が多いときにローカルLLMが関係する行だけに絞る (設定で有効なとき)。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '検索する正規表現 (fixed: true で固定文字列)' },
            path: { type: 'string', description: '検索するディレクトリまたはファイル' },
            glob: { type: 'string', description: "ファイルを絞る glob (例: '*.ts', '!*.test.ts')" },
            type: { type: 'string', description: 'rg のファイルタイプ (例: ts, py, rust)' },
            file_pattern: { type: 'string', description: 'fd でファイル名を絞る正規表現 (要 fd)' },
            ignore_case: { type: 'boolean' },
            fixed: { type: 'boolean', description: 'pattern を固定文字列として扱う' },
            word: { type: 'boolean', description: '単語境界で一致させる' },
            files_only: { type: 'boolean', description: '一致したファイル名だけ返す' },
            context: { type: 'number', description: '前後に付ける行数' },
            hidden: { type: 'boolean' },
            purpose: { type: 'string', description: '調査の目的。検索結果の絞り込みに使う。省略すると絞り込まない' },
            raw: { type: 'boolean', description: 'true なら purpose があっても絞り込まず、検索結果をそのまま返す' },
          },
          required: ['pattern'],
        },
      })
    }
    return next(e)
  })

  on('tool.call', { tool: FIND }, async ($, e, next) => {
    const input = e as unknown as FindFilesInput
    const r = await run($, fdArgs(input))
    if (r.exitCode !== 0) return { deny: `fd failed: ${r.stderr.trim() || `exit ${r.exitCode}`}` }
    return { result: formatResult(r.stdout, cfg.maxResults, 'ファイル') }
  })

  on('tool.call', { tool: SEARCH }, async ($, e, next) => {
    const input = e as unknown as SearchCodeInput
    if (typeof input.pattern !== 'string' || input.pattern === '') return { deny: 'pattern is required' }

    let files: string[] | undefined
    if (input.file_pattern !== undefined && input.file_pattern !== '') {
      if (!(await detect($)).fd) return { deny: 'file_pattern needs fd, which is not installed' }
      const found = await run($, fdArgs({
        pattern: input.file_pattern,
        ...(input.path === undefined ? {} : { path: input.path }),
        type: 'file',
        ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      }))
      if (found.exitCode !== 0) return { deny: `fd failed: ${found.stderr.trim() || `exit ${found.exitCode}`}` }
      files = found.stdout.split('\n').filter(l => l !== '').slice(0, PRE_FILTER_LIMIT)
      if (files.length === 0) return { result: 'file_pattern に合うファイルが見つからなかった。' }
    }

    const r = await run($, rgArgs(input, files))
    if (r.exitCode === 1) return { result: formatResult('', cfg.maxResults, '一致') }
    if (r.exitCode !== 0) return { deny: `rg failed: ${r.stderr.trim() || `exit ${r.exitCode}`}` }
    return { result: await narrow($, cfg, state, input, r.stdout) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { fd, rg } = await detect($)
    const text = guidance(fd, rg)
    return text === undefined
      ? composed
      : { sections: [...composed.sections, { id: 'code-finder:guidance', text, scope: 'session' }] }
  })
}
