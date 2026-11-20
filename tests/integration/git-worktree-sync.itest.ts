// 各 plugin に同梱した git-worktree のコピーが、shared/git-worktree の正本と一致するかの検査。
//   bun test ./tests/integration/git-worktree-sync.itest.ts
import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGETS, destOf, drift } from '../../scripts/sync-git-worktree'

describe('git-worktree の同梱コピー', () => {
  const touched: { path: string; before: string | undefined }[] = []
  afterEach(() => {
    for (const { path, before } of touched.splice(0)) before === undefined ? rmSync(path, { force: true }) : writeFileSync(path, before)
  })

  test('ghq-pane と repo-storage-manager の両方が同梱先で、正本と一致する (ずれていたら bun run scripts/sync-git-worktree.ts)', () => {
    expect(TARGETS).toEqual(['ghq-pane', 'repo-storage-manager'])
    expect(drift()).toEqual([])
  })

  test('コピーを書き換えるとずれとして検出する', () => {
    const path = join(destOf('ghq-pane'), 'parse.ts')
    touched.push({ path, before: readFileSync(path, 'utf8') })
    appendFileSync(path, '\n// drift\n')
    expect(drift()).toEqual(['ghq-pane: parse.ts が正本と異なる'])
  })

  test('余分なファイル・欠けたファイルも検出する', () => {
    const extra = join(destOf('repo-storage-manager'), 'extra.ts')
    touched.push({ path: extra, before: undefined })
    writeFileSync(extra, 'export {}\n')
    expect(drift()).toEqual(['repo-storage-manager: extra.ts は正本にない'])
  })
})
