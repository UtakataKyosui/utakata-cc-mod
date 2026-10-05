import type { Register } from 'claude-code'
import { denyText, guidance, hasSource, isDocPath, isResearchTool, readConfig } from './policy'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  let researched = false

  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    if (isResearchTool(tool)) {
      researched = true
      return next(e)
    }
    if (!researched || (tool !== 'Write' && tool !== 'Edit')) return next(e)

    const input = e as unknown as { file_path: string; content?: string; new_string?: string }
    if (!isDocPath(input.file_path, cfg)) return next(e)

    if (hasSource(tool === 'Write' ? input.content : input.new_string)) return next(e)
    // Edit は断片だけが渡るので、書き込み先に出典がすでにあれば通す
    if (tool === 'Edit') {
      const current = await $.fs.read(input.file_path).catch(() => '')
      if (hasSource(current)) return next(e)
    }
    return { deny: denyText }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'source-citation:guidance', text: guidance, scope: 'session' }] }
  })
}
