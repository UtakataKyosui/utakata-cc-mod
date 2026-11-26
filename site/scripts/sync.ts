// ルートの README と plugins/*/README.md から、サイトのページ (site/docs の生成物) を作る。
// README が正本で、生成物はコミットしない。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(SITE, '..')
const DOCS = join(SITE, 'docs')
const BLOB = 'https://github.com/UtakataKyosui/utakata-cc-mod/blob/main'

/** サイドバーに並べる分類の順。marketplace.json の category で決まり、ここにない分類はこの後ろに、category のない Mod は「その他」に入る */
const CATEGORY_ORDER = ['委譲とルーティング', '状態とコンテキスト', '品質と検証', '調査と知識', '操作の安全', '作業環境', 'シェルとコマンド', '振り返り']
const OTHERS = 'その他'

/** ルート README の節と、それを載せるページ */
const ROOT_PAGES: Record<string, { slug: string; title: string; description: string }> = {
  導入: { slug: 'install', title: '導入', description: 'marketplace を登録して Mod をインストールする。' },
  組み合わせ: { slug: 'combinations', title: '組み合わせ', description: 'Mod を組み合わせて開発ハーネスにする方法と、同時に入れない組み合わせ。' },
  開発: { slug: 'development', title: '開発', description: 'このリポジトリで Mod を検証・テストする手順。' },
}

type Mod = { name: string; description: string; category: string }

// marketplace.json に載っていて README がある Mod をサイトに載せる。並びは marketplace.json の順
const marketplace = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
  plugins: { name: string; source: string; description?: string; category?: string }[]
}
const listed: Mod[] = marketplace.plugins
  .filter(p => p.source === `./plugins/${p.name}` && existsSync(join(REPO, 'plugins', p.name, 'README.md')))
  .map(p => ({ name: p.name, description: p.description ?? '', category: p.category?.trim() || OTHERS }))
const mods = listed.map(m => m.name)

const categories = [...new Set(listed.map(m => m.category))].sort((a, b) => {
  const rank = (c: string) => (c === OTHERS ? Infinity : CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length)
  return rank(a) - rank(b)
})
/** 分類のフォルダ。括弧付きにして URL には含めない (/mods/<name>) */
const groupDir = (category: string) => `g${String(categories.indexOf(category) + 1).padStart(2, '0')}`

/** ルート README の Mod の表がある節。サイトでは Mod 一覧のページになる */
const MOD_LIST_SECTION = 'marketplace登録済み'

const decodeAnchor = (anchor: string): string => {
  try {
    return decodeURIComponent(anchor.slice(1))
  } catch {
    return anchor.slice(1)
  }
}

/** ルート README の節へのリンク先。ページのない節はトップページにする */
const rootLink = (anchor: string): string => {
  const heading = decodeAnchor(anchor)
  if (heading === '' || heading === MOD_LIST_SECTION) return '/mods'
  return ROOT_PAGES[heading] ? `/${ROOT_PAGES[heading]!.slug}` : '/'
}

/** リポジトリ内のパスを、サイトのページか GitHub の URL に置き換える */
const linkFor = (repoPath: string, anchor: string): string => {
  const plugin = /^plugins\/([^/]+)\/README\.md$/.exec(repoPath)
  if (plugin && mods.includes(plugin[1]!)) return `/mods/${plugin[1]}${anchor}`
  if (repoPath === 'README.md') return rootLink(anchor)
  return `${BLOB}/${repoPath}${anchor}`
}

/** ルート README の中で、別のページに分かれた節を指すページ内リンク */
const isRootSectionAnchor = (target: string): boolean => {
  const heading = decodeAnchor(target)
  return heading === MOD_LIST_SECTION || heading in ROOT_PAGES
}

/** fromDir (リポジトリ相対) にある Markdown の相対リンクを書き換える */
const rewriteLinks = (text: string, fromDir: string): string =>
  // コードブロックの中は例として書かれたリンクなので書き換えない
  text.split(/(^```[\s\S]*?^```)/m).map((part, i) => (i % 2 === 1 ? part : part.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang: string, label: string, target: string) => {
    if (fromDir === '' && target.startsWith('#') && isRootSectionAnchor(target)) return `[${label}](${rootLink(target)})`
    if (/^[a-z]+:|^#|^\//i.test(target)) return all
    const [path = '', hash = ''] = target.split(/(?=#)/)
    const repoPath = posix.normalize(posix.join(fromDir, path))
    if (repoPath.startsWith('..')) return all
    if (bang) return `![${label}](${BLOB.replace('/blob/', '/raw/')}/${repoPath})`
    return `[${label}](${linkFor(repoPath, hash)})`
  }))).join('')

const yaml = (s: string) => JSON.stringify(s)

const frontmatter = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${yaml(v)}`).join('\n')}\n---\n\n`

const write = (rel: string, text: string) => {
  const path = join(DOCS, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// 前回の生成物を消してから作り直す (index.md は手書き)
rmSync(join(DOCS, 'mods'), { recursive: true, force: true })
for (const p of Object.values(ROOT_PAGES)) rmSync(join(DOCS, `${p.slug}.md`), { force: true })

// ルート README の節
const root = readFileSync(join(REPO, 'README.md'), 'utf8')
/** `## ` の見出しで分ける。コードブロックの中の行は見出しとみなさない */
const sections = (text: string): string[] => {
  const out: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    if (!fenced && line.startsWith('## ')) out.push('')
    if (out.length > 0) out[out.length - 1] += `${line}\n`
  }
  return out
}

for (const section of sections(root)) {
  const heading = section.split('\n')[0]!.replace(/^##\s+/, '').trim()
  const page = ROOT_PAGES[heading]
  if (!page) continue
  const body = rewriteLinks(section.replace(/^## .*\n/, ''), '')
  write(`${page.slug}.md`, frontmatter({ title: page.title, description: page.description }) + body.trim() + '\n')
}

// Mod ごとのページ
for (const mod of listed) {
  const readme = readFileSync(join(REPO, 'plugins', mod.name, 'README.md'), 'utf8')
  const body = readme.replace(/^# .*\n+/, '')
  const source = `\n\n---\n\nこのページは [plugins/${mod.name}/README.md](${BLOB}/plugins/${mod.name}/README.md) から生成している。\n`
  write(`mods/(${groupDir(mod.category)})/${mod.name}.md`, frontmatter({ title: mod.name, description: mod.description }) + rewriteLinks(body, `plugins/${mod.name}`).trim() + source)
}

// 分類ごとの meta.ts と、Mod 一覧の index
categories.forEach((category, i) => {
  const pages = listed.filter(m => m.category === category).map(m => m.name)
  write(`mods/(${groupDir(category)})/meta.ts`, `import { defineMeta } from 'blume'\n\nexport default defineMeta(${JSON.stringify({ title: category, order: i + 1, pages })})\n`)
})
write('mods/meta.ts', `import { defineMeta } from 'blume'\n\nexport default defineMeta(${JSON.stringify({ title: 'Mod 一覧', order: 10, pages: categories.map(groupDir) })})\n`)

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const table = categories
  .map(category => `## ${category}\n\n| Mod | 役割 |\n|---|---|\n${listed.filter(m => m.category === category).map(m => `| [${m.name}](/mods/${m.name}) | ${cell(m.description)} |`).join('\n')}\n`)
  .join('\n')
write('mods/index.md', frontmatter({ title: 'Mod 一覧', description: `このリポジトリにある ${listed.length} 個の Mod を分類ごとに並べる。` }) + table)

/** GitHub Actions ではジョブの画面に注釈として出す */
const warn = (text: string) => console.warn(process.env.GITHUB_ACTIONS ? `::warning title=docs::${text}` : text)

const uncategorized = listed.filter(m => m.category === OTHERS).map(m => m.name)
if (uncategorized.length) warn(`category のない Mod (${OTHERS}に入れた): ${uncategorized.join(', ')}。.claude-plugin/marketplace.json に category を足すこと`)
const unlisted = readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
  .filter(d => d.isDirectory() && !mods.includes(d.name))
  .map(d => d.name)
if (unlisted.length) warn(`marketplace.json にないため載せなかった: ${unlisted.join(', ')}`)
console.log(`${listed.length} 個の Mod と ${Object.keys(ROOT_PAGES).length} ページを ${relative(REPO, DOCS)} に生成した`)
