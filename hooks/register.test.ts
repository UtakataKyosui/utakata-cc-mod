import { test, expect } from 'claude-code/testing'
import { buildPlaybook, isGoalStatement } from './playbook'

test('goal の文面だけを対象にする', () => {
  expect(isGoalStatement('ログイン機能を実装する')).toBe(true)
  expect(isGoalStatement('  ')).toBe(false)
  expect(isGoalStatement('clear')).toBe(false)
})

test('手順にゴールと委譲の指示が入る', () => {
  const text = buildPlaybook(' API を作る ')
  expect(text).toContain('ゴール: API を作る')
  expect(text).toContain('Agent ツール')
  expect(text).toContain('完了条件')
})

const compose = ($: any) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }).then((r: { sections: { id: string; text: string }[] }) => r.sections)

test('goal 設定後のシステムプロンプトに手順書が入る', async ($, on) => {
  on('command.run', { command: 'goal' }, () => ({ text: 'Goal set' }))
  on('prompt.compose', () => ({ sections: [] }))

  expect(await compose($)).toEqual([])

  await $.command.run({ command: 'goal', args: 'API を作る' })
  const sections = await compose($)

  expect(sections.map(s => s.id)).toEqual(['goal-orchestrator:playbook'])
  expect(sections[0].text).toContain('ゴール: API を作る')
})

test('goal clear で手順書が外れる', async ($, on) => {
  on('command.run', { command: 'goal' }, () => ({ text: 'ok' }))
  on('prompt.compose', () => ({ sections: [] }))

  await $.command.run({ command: 'goal', args: 'API を作る' })
  await $.command.run({ command: 'goal', args: 'clear' })

  expect(await compose($)).toEqual([])
})
