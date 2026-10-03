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

const echo = ($: any, on: any) =>
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({
    text: e.text,
    context: e.context,
  }))

test('goal 設定後の最初のプロンプトに手順書が context で付く', async ($, on) => {
  on('command.run', { command: 'goal' }, () => ({ text: 'Goal set' }))
  echo($, on)

  await $.command.run({ command: 'goal', args: 'API を作る' })
  const first = await $.prompt.submit({ text: '/goal API を作る' })

  expect(first.context?.[0]).toContain('ゴール: API を作る')
})

test('手順書は一度しか付かない', async ($, on) => {
  on('command.run', { command: 'goal' }, () => ({ text: 'Goal set' }))
  echo($, on)

  await $.command.run({ command: 'goal', args: 'API を作る' })
  await $.prompt.submit({ text: '1回目' })
  const second = await $.prompt.submit({ text: '2回目' })

  expect(second.context).toBeUndefined()
})

test('goal clear では手順書を付けない', async ($, on) => {
  on('command.run', { command: 'goal' }, () => ({ text: 'ok' }))
  echo($, on)

  await $.command.run({ command: 'goal', args: 'API を作る' })
  await $.command.run({ command: 'goal', args: 'clear' })
  const ran = await $.prompt.submit({ text: 'x' })

  expect(ran.context).toBeUndefined()
})
