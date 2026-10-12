import type { Register } from 'claude-code'
import { analyze, expandHome, HELP, parseDays, parsePromptLine, readConfig, renderReport, reportFileName, resolveDir, summaryText } from './policy'
import type { Prompt } from './policy'

const DAY_MS = 86_400_000

async function collect($: any, dir: string, days: number): Promise<Prompt[]> {
  const found = await $.process.run(['find', dir, '-name', '*.jsonl', '-not', '-path', '*/subagents/*', '-mtime', `-${days + 1}`], { timeoutMs: 60_000 })
  if (found.exitCode !== 0 && String(found.stdout).trim() === '') throw new Error(`会話ログのディレクトリを読めなかった: ${dir} (${String(found.stderr).trim() || `exit ${found.exitCode}`})`)
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

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'retrospective', description: '会話ログの自分のプロンプトを分析し、改善点のレポートを書き出す ([日数] | help)' })
    return next(e)
  })

  on('command.run', { command: 'retrospective' }, async ($, e) => {
    if (typeof e.args === 'string' && e.args.trim() === 'help') return { text: HELP }
    try {
      const days = parseDays(e.args, cfg.days)
      const home = String((await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout)
      const now: number = await $.clock.now()
      const prompts = await collect($, expandHome(cfg.transcriptDir, home), days)
      const analysis = analyze(prompts, now - days * DAY_MS, now)
      const path = `${resolveDir(await $.session.root(), expandHome(cfg.reportDir, home))}/${reportFileName(now)}`
      await $.fs.write(path, renderReport(analysis))
      return { text: summaryText(analysis, path) }
    } catch (err) {
      return { text: `分析に失敗した: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
