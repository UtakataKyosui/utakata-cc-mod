// 各 plugin に同梱した local-llm のコピーが、shared/local-llm の正本と一致するかの検査。
//   bun test ./tests/integration/local-llm-sync.itest.ts
import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGETS, destOf, drift } from '../../scripts/sync-local-llm'

describe('local-llm の同梱コピー', () => {
  const touched: { path: string; before: string | undefined }[] = []
  afterEach(() => {
    for (const { path, before } of touched.splice(0)) before === undefined ? rmSync(path, { force: true }) : writeFileSync(path, before)
  })

  test('全ての同梱先が正本と一致する (ずれていたら bun run scripts/sync-local-llm.ts)', () => {
    expect(drift()).toEqual([])
  })

  test('コピーを書き換えるとずれとして検出する', () => {
    const path = join(destOf(TARGETS[0]!), 'call.ts')
    touched.push({ path, before: readFileSync(path, 'utf8') })
    appendFileSync(path, '\n// drift\n')
    expect(drift()).toEqual([`${TARGETS[0]}: call.ts が正本と異なる`])
  })

  test('余分なファイルも検出する', () => {
    const path = join(destOf(TARGETS[0]!), 'extra.ts')
    touched.push({ path, before: undefined })
    writeFileSync(path, 'export {}\n')
    expect(drift()).toEqual([`${TARGETS[0]}: extra.ts は正本にない`])
  })
})
