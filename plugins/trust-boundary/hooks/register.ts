import type { Register } from 'claude-code'
import {
  blockedText, failSafe, guardFetch, guardNotion, guidance, isExternalTool, provenanceNote, readConfig, riskOf, scanText,
  statusText, verdictText,
} from './policy'

const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'fetch_page'])
const MCP_WRITE = /(create|update|delete|move|duplicate|send|upload|post|comment|write)/i

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  let tainted = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'trust-boundary', description: '外部内容の取り込み状態と安全設定を表示する (clear で取り込み状態を解除)', argumentHint: '[clear]' })
    return next(e)
  })

  on('command.run', { command: 'trust-boundary' }, (_$, e) => {
    if (e.args.trim() === 'clear') tainted = false
    return { text: statusText(cfg, tainted) }
  })

  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'trust-boundary:guidance', text: guidance, scope: 'session' }] }
  })

  // 外部内容を返すツールの呼び出しを記録し、結果に出所の注記を足す。検査は tool.check で行う。
  on('tool.call', async (_$, e, next) => {
    const tool = e.tool as string
    if (cfg.scanOutbound) {
      // Web 取得の URL や Notion 書き込みの本文に秘密を載せた持ち出しを止める
      const sends = NETWORK_TOOLS.has(tool) || (tool.startsWith('mcp__') && isExternalTool(tool, cfg) && MCP_WRITE.test(tool.split('__').pop() ?? ''))
      if (sends) {
        const v = failSafe(cfg, () => scanText(JSON.stringify(e), cfg), { kind: 'invalid', label: '検査に失敗' } as const)
        if (v !== undefined) return { deny: verdictText(v, tool) }
      }
    }
    if (!isExternalTool(tool, cfg)) return next(e)
    tainted = true
    const ran = await next(e)
    return ran.deny === undefined && ran.isError !== true ? { ...ran, context: [...(ran.context ?? []), provenanceNote(tool)] } : ran
  })

  // 取り込み後の危険な操作を要確認・拒否にする。本体の判断が拒否ならそのまま、許可への変更はしない。
  on('tool.check', async (_$, e, next) => {
    const verdict = await next(e)
    if (cfg.guardMode === 'off' || !tainted || verdict.decision === 'deny') return verdict
    const risk = failSafe(cfg, () => riskOf(e.tool, e.input), '検査に失敗した操作')
    return risk === undefined ? verdict : { ...verdict, decision: cfg.guardMode, reason: blockedText(risk, cfg) }
  })

  // プラグインの外部通信 (ollama など) を allowlist と送信内容の検査で制限する。
  on('http.fetch', (_$, e, next) => {
    const reason = guardFetch(e.url, e.init?.body, cfg)
    return reason === undefined ? next(e) : { deny: reason }
  })

  // ntn による Notion への書き込みを、設定と送信内容の検査で制限する。
  on('process.run', (_$, e, next) => {
    const reason = guardNotion(e.argv, e.init?.stdin, cfg)
    return reason === undefined ? next(e) : { deny: reason }
  })
}
