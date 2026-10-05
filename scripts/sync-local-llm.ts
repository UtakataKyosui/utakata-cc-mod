// 共通のローカルLLM基盤 (shared/local-llm) を、各 plugin の hooks/local-llm へ同梱コピーする。
//   bun run scripts/sync-local-llm.ts          コピーを正本に揃える
//   bun run scripts/sync-local-llm.ts --check  ずれていれば終了コード 1
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 同梱先の plugin。後続の plugin はここへ足す。 */
export const TARGETS = ['subagent-router', 'code-finder', 'ctxpack-fetch', 'verification-gate', 'change-review']

const ROOT = resolve(import.meta.dir, '..')
const SOURCE = join(ROOT, 'shared/local-llm')

/** 同梱するのは実行時に使うソースだけ (テスト・README・設定の雛形は含めない)。 */
const bundled = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()

export const destOf = (plugin: string) => join(ROOT, 'plugins', plugin, 'hooks/local-llm')

/** 正本とずれているコピーの一覧。空なら一致。 */
export const drift = (): string[] => {
  const files = bundled(SOURCE)
  const out: string[] = []
  for (const plugin of TARGETS) {
    const dest = destOf(plugin)
    const have = existsSync(dest) ? bundled(dest) : []
    for (const f of files) {
      if (!have.includes(f)) out.push(`${plugin}: ${f} がない`)
      else if (readFileSync(join(SOURCE, f), 'utf8') !== readFileSync(join(dest, f), 'utf8')) out.push(`${plugin}: ${f} が正本と異なる`)
    }
    for (const f of have) if (!files.includes(f)) out.push(`${plugin}: ${f} は正本にない`)
  }
  return out
}

export const sync = () => {
  const files = bundled(SOURCE)
  for (const plugin of TARGETS) {
    const dest = destOf(plugin)
    mkdirSync(dest, { recursive: true })
    for (const f of existsSync(dest) ? bundled(dest) : []) if (!files.includes(f)) rmSync(join(dest, f))
    for (const f of files) copyFileSync(join(SOURCE, f), join(dest, f))
  }
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const d = drift()
    for (const line of d) console.error(line)
    process.exit(d.length === 0 ? 0 : 1)
  }
  sync()
  console.log(`synced ${bundled(SOURCE).length} files to ${TARGETS.length} plugins`)
}
