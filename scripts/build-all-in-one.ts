/**
 * オールインワン版リポジトリの中身を生成する。
 *
 *   bun run scripts/build-all-in-one.ts [--out <dir>] [--repo <owner>/<name>]
 *
 * 既定の出力先は dist/all-in-one。出力先に既存の git チェックアウト (オールインワン版リポジトリ) を
 * 指定してもよい。そのとき置き換えるのは生成物 (.claude-plugin/, plugins/, README.md, LICENSE) だけで、
 * .git や .github などそれ以外は残す。
 *
 * 生成物:
 * - plugins/<name>/        : plugins/ の各プラグインのコピー (テストとテスト用フィクスチャを除く)
 * - plugins/utakata-all-in-one/ : 全プラグインを dependencies に持つ親プラグイン (all-in-one/plugin)
 * - .claude-plugin/marketplace.json
 * - README.md, LICENSE
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { CONFLICTS, MARKETPLACE, NEEDS, SELF } from '../all-in-one/plugin/hooks/policy'

const ROOT = resolve(import.meta.dir, '..')
const PLUGINS = join(ROOT, 'plugins')
const META = join(ROOT, 'all-in-one', 'plugin')

const outArg = process.argv.indexOf('--out')
const OUT = resolve(outArg >= 0 && process.argv[outArg + 1] !== undefined ? process.argv[outArg + 1]! : join(ROOT, 'dist', 'all-in-one'))

const repoArg = process.argv.indexOf('--repo')
/** README の導入手順に書く、オールインワン版リポジトリの owner/name。 */
const REPO = repoArg >= 0 && process.argv[repoArg + 1] !== undefined ? process.argv[repoArg + 1]! : 'UtakataKyosui/utakata-cc-mod-all-in-one'

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))

/** テストとテスト専用のファイルはコピーしない。 */
const isTestOnly = (path: string): boolean => {
  const name = basename(path)
  if (/\.(i?test)\.tsx?$/.test(name)) return true
  return statSync(path).isDirectory() && (name === 'tests' || name === 'fixtures' || name === 'node_modules')
}

const copyPlugin = (from: string, to: string) => {
  cpSync(from, to, { recursive: true, filter: src => src === from || !isTestOnly(src) })
}

// 1. 収録するプラグインと判定表の対応を確かめる
const names = readdirSync(PLUGINS).filter(n => existsSync(join(PLUGINS, n, '.claude-plugin', 'plugin.json'))).sort()
const unknown = names.filter(n => !Object.hasOwn(NEEDS, n))
const stale = Object.keys(NEEDS).filter(n => !names.includes(n))
if (unknown.length > 0 || stale.length > 0) {
  if (unknown.length > 0) console.error(`all-in-one/plugin/hooks/policy.ts の NEEDS に無いプラグイン: ${unknown.join(', ')}`)
  if (stale.length > 0) console.error(`NEEDS にあるが plugins/ に無いプラグイン: ${stale.join(', ')}`)
  process.exit(1)
}

// 2. 出力先の生成物だけを入れ替える
mkdirSync(OUT, { recursive: true })
for (const managed of ['.claude-plugin', 'plugins', 'README.md', 'LICENSE']) rmSync(join(OUT, managed), { recursive: true, force: true })
mkdirSync(join(OUT, '.claude-plugin'), { recursive: true })
mkdirSync(join(OUT, 'plugins'), { recursive: true })

const manifests = new Map<string, any>()
for (const name of names) {
  copyPlugin(join(PLUGINS, name), join(OUT, 'plugins', name))
  manifests.set(name, readJson(join(PLUGINS, name, '.claude-plugin', 'plugin.json')))
}

// 3. 親プラグイン: dependencies に全プラグインを入れる
const metaDir = join(OUT, 'plugins', SELF)
copyPlugin(META, metaDir)
const metaManifest = readJson(join(META, '.claude-plugin', 'plugin.json'))
metaManifest.dependencies = names
writeFileSync(join(metaDir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(metaManifest, null, 2)}\n`)

// 4. marketplace.json
const source = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'))
const descriptionOf = (name: string): string =>
  source.plugins.find((p: any) => p.name === name)?.description ?? manifests.get(name)?.description ?? ''
const marketplace = {
  name: MARKETPLACE,
  description: 'utakata-cc-mod の全プラグインを1回のインストールで入れるオールインワン版',
  owner: source.owner,
  plugins: [
    { name: SELF, source: `./plugins/${SELF}`, description: metaManifest.description },
    ...names.map(name => ({ name, source: `./plugins/${name}`, description: descriptionOf(name) })),
  ],
}
writeFileSync(join(OUT, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`)

// 5. README と LICENSE
const commit = (() => {
  const r = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })
  return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown'
})()
const needText = (name: string): string => {
  const need = NEEDS[name]!
  const parts = [
    ...(need.cmds ?? []).map(c => `\`${c}\``),
    ...(need.ollama === true ? ['ollama'] : []),
    ...(need.localJev === true ? ['LocalJev'] : []),
    ...(need.options ?? []).map(o => `設定 \`${o}\``),
  ]
  return parts.length === 0 ? 'なし' : parts.join('、')
}
const defaultOff = new Set(CONFLICTS.map(([, drop]) => drop))
const template = readFileSync(join(ROOT, 'all-in-one', 'README.template.md'), 'utf8')
const table = [
  '| プラグイン | 必要なもの | 既定 | 役割 |',
  '|---|---|---|---|',
  ...names.map(n => `| [${n}](plugins/${n}/README.md) | ${needText(n)} | ${defaultOff.has(n) ? '無効 (競合)' : '有効'} | ${descriptionOf(n)} |`),
].join('\n')
const readme = template
  .replaceAll('{{MARKETPLACE}}', MARKETPLACE)
  .replaceAll('{{SELF}}', SELF)
  .replaceAll('{{REPO}}', REPO)
  .replaceAll('{{COUNT}}', String(names.length))
  .replaceAll('{{COMMIT}}', commit)
  .replaceAll('{{PLUGIN_TABLE}}', table)
  .replaceAll('{{CONFLICTS}}', CONFLICTS.map(([keep, drop]) => `- ${keep} と ${drop}: 既定で ${drop} を止める`).join('\n'))
writeFileSync(join(OUT, 'README.md'), readme)
cpSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'))

console.log(`${relative(process.cwd(), OUT) || '.'} に ${names.length} 本 + ${SELF} を生成した (元コミット ${commit.slice(0, 7)})`)
