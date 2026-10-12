import type { Register } from 'claude-code'
import { analyze, expandHome, HELP, parseDays, parsePromptLine, readConfig, renderReport, reportFileName, resolveDir, summaryText } from './policy'
import type { Config, Prompt } from './policy'
import { improve, improvementFileName, improveSummary, renderImprovements } from './improve'
import type { Llm } from './improve'

const DAY_MS = 86_400_000

async function collect($: any, dir: string, days: number): Promise<Prompt[]> {
  const found = await $.process.run(['find', dir, '-name', '*.jsonl', '-not', '-path', '*/subagents/*', '-mtime', `-${days + 1}`], { timeoutMs: 60_000 })
  const files = String(found.stdout)
    .split('\n')
    .filter(f => f !== '')
  const prompts: Prompt[] = []
  for (const file of files) {
    // ユーザー行だけを抜き出して、1ファイルごとに出力量を抑える
    const r = await $.process
      .run(['sh', '-c', `grep -h '"type":"user"' "$1" | grep -v '"type":"tool_result"'`, 'sh', file], { timeoutMs: 60_000 })
      .catch(() => undefined)
    if (!r) continue
    for (const line of String(r.stdout).split('\n')) {
      const p = line === '' ? undefined : parsePromptLine(line)
      if (p) prompts.push(p)
    }
  }
  return prompts
}

const ask = async ($: any, cfg: Config, model: string, prompt: string): Promise<string> => {
  const res = await $.http.fetch(`${cfg.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.3 } }),
  })
  if (!res.ok) throw new Error(`Ollama が ${res.status} を返した (${model})`)
  return String(JSON.parse(res.text).response ?? '')
}

const localLlm = ($: any, cfg: Config): Llm => ({
  draft: prompt => ask($, cfg, cfg.draftModel, prompt),
  judge: prompt => ask($, cfg, cfg.judgeModel, prompt),
})

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'retrospective', description: '会話ログの自分のプロンプトを分析し、改善点のレポートを書き出す ([日数] | help)' })
    return next(e)
  })

  on('command.run', { command: 'retrospective' }, async ($, e) => {
    if (typeof e.args === 'string' && e.args.trim() === 'help') return { text: HELP }
    const args = typeof e.args === 'string' ? e.args.trim() : ''
    const wantsImprove = /^improve(\s|$)/.test(args)
    try {
      const days = parseDays(wantsImprove ? args.slice('improve'.length) : args, cfg.days)
      const home = String((await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout)
      const now: number = await $.clock.now()
      const prompts = await collect($, expandHome(cfg.transcriptDir, home), days)
      const analysis = analyze(prompts, now - days * DAY_MS, now)
      const dir = resolveDir(await $.session.root(), expandHome(cfg.reportDir, home))
      const path = `${dir}/${reportFileName(now)}`
      await $.fs.write(path, renderReport(analysis))
      if (!wantsImprove) return { text: summaryText(analysis, path) }
      try {
        const proposals = await improve(localLlm($, cfg), analysis)
        const improvePath = `${dir}/${improvementFileName(now)}`
        await $.fs.write(improvePath, renderImprovements(proposals, { draft: cfg.draftModel, judge: cfg.judgeModel }))
        return { text: `${summaryText(analysis, path)}\n${improveSummary(proposals, improvePath)}` }
      } catch (err) {
        return { text: `${summaryText(analysis, path)}\nローカル LLM での改善案づくりに失敗した: ${err instanceof Error ? err.message : String(err)}` }
      }
    } catch (err) {
      return { text: `分析に失敗した: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
