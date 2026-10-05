export const register = (on: any) => {
  on('prompt.compose', () => { throw new Error('boom') })
  on('tool.call', () => { throw new Error('boom') })
  on('agent.spawn', () => { throw new Error('boom') })
  on('prompt.submit', () => { throw new Error('boom') })
}
