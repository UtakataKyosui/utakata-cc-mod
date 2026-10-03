import type { Register } from 'claude-code'
import { TOOLS, denyText, findBlocked, guidance } from './policy'

let detected: Promise<Set<string>> | undefined

async function which($: any, name: string): Promise<string | undefined> {
  try {
    const { exitCode } = await $.process.run(['sh', '-c', `command -v ${name}`])
    return exitCode === 0 ? name : undefined
  } catch {
    return undefined
  }
}

function detect($: any): Promise<Set<string>> {
  detected ??= Promise.all(TOOLS.map(name => which($, name))).then(
    names => new Set(names.filter((n): n is string => n !== undefined)),
  )
  return detected
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = guidance(await detect($))
    return text === undefined
      ? composed
      : { sections: [...composed.sections, { id: 'advanced-rust-cli:policy', text, scope: 'session' }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const rule = findBlocked(e.command, await detect($))
    return rule === undefined ? next(e) : { deny: denyText(rule) }
  })
}
