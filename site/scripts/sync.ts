// ルートの README と plugins/*/README.md から、サイトのページ (site/docs の生成物) を作る。
// README が正本で、生成物はコミットしない。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(SITE, '..')
const DOCS = join(SITE, 'docs')
const BLOB = 'https://github.com/UtakataKyosui/utakata-cc-mod/blob/main'

/** サイドバーの分類。括弧付きのフォルダにして URL には含めない (/mods/<name>)。ここにない Mod は「その他」に入る */
const GROUPS: { dir: string; title: string; mods: string[] }[] = [
  { dir: 'delegation', title: '委譲とルーティング', mods: ['goal-orchestrator', 'subagent-router', 'agent-router', 'execution-budget', 'act-now-guard', 'stack-pr'] },
  { dir: 'state', title: '状態とコンテキスト', mods: ['auto-compact', 'task-checkpoint', 'session-guard'] },
  { dir: 'quality', title: '品質と検証', mods: ['verification-gate', 'change-review', 'lean-spec', 'clarify-fix-request'] },
  { dir: 'research', title: '調査と知識', mods: ['code-finder', 'ctxpack-fetch', 'source-citation', 'notion-knowledge'] },
  { dir: 'safety', title: '操作の安全', mods: ['trust-boundary', 'approval-guard'] },
  { dir: 'workspace', title: '作業環境', mods: ['workspace-isolation', 'ghq-pane', 'repo-storage-manager', 'harness-profile'] },
  { dir: 'shell', title: 'シェルとコマンド', mods: ['advanced-rust-cli', 'bash-hints'] },
  { dir: 'retrospective', title: '振り返り', mods: ['prompt-retrospective'] },
]

/** ルート README の節と、それを載せるページ */
const ROOT_PAGES: Record<string, { slug: string; title: string; description: string }> = {
  導入: { slug: 'install', title: '導入', description: 'marketplace を登録して Mod をインストールする。' },
  組み合わせ: { slug: 'combinations', title: '組み合わせ', description: 'Mod を組み合わせて開発ハーネスにする方法と、同時に入れない組み合わせ。' },
  開発: { slug: 'development', title: '開発', description: 'このリポジトリで Mod を検証・テストする手順。' },
}

const mods = readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(REPO, 'plugins', d.name, 'README.md')))
  .map(d => d.name)
  .sort()

const groupOf = (mod: string) => GROUPS.find(g => g.mods.includes(mod)) ?? { dir: 'others', title: 'その他', mods: [] }

/** リポジトリ内のパスを、サイトのページか GitHub の URL に置き換える */
const linkFor = (repoPath: string, anchor: string): string => {
  const plugin = /^plugins\/([^/]+)\/README\.md$/.exec(repoPath)
  if (plugin && mods.includes(plugin[1]!)) return `/mods/${plugin[1]}${anchor}`
  if (repoPath === 'README.md') {
    const page = ROOT_PAGES[decodeURIComponent(anchor.slice(1))]
    return page ? `/${page.slug}` : `/${anchor}`
  }
  return `${BLOB}/${repoPath}${anchor}`
}

/** fromDir (リポジトリ相対) にある Markdown の相対リンクを書き換える */
const rewriteLinks = (text: string, fromDir: string): string =>
  text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang: string, label: string, target: string) => {
    if (/^[a-z]+:|^#|^\//i.test(target)) return all
    const [path = '', hash = ''] = target.split(/(?=#)/)
    const repoPath = posix.normalize(posix.join(fromDir, path))
    if (repoPath.startsWith('..')) return all
    if (bang) return `![${label}](${BLOB.replace('/blob/', '/raw/')}/${repoPath})`
    return `[${label}](${linkFor(repoPath, hash)})`
  })

const yaml = (s: string) => JSON.stringify(s)

const frontmatter = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${yaml(v)}`).join('\n')}\n---\n\n`

/** 最初の段落を平文にして description にする */
const firstParagraph = (body: string): string => {
  const para = body.trim().split(/\n\s*\n/).find(p => !/^(#|```|\||- |<)/.test(p.trim())) ?? ''
  return para.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
}

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
for (const section of root.split(/^(?=## )/m).slice(1)) {
  const heading = section.split('\n')[0]!.replace(/^##\s+/, '').trim()
  const page = ROOT_PAGES[heading]
  if (!page) continue
  const body = rewriteLinks(section.replace(/^## .*\n/, ''), '')
  write(`${page.slug}.md`, frontmatter({ title: page.title, description: page.description }) + body.trim() + '\n')
}

// Mod ごとのページ
const summaries = new Map<string, string>()
for (const row of root.matchAll(/^\| \[([^\]]+)\]\(plugins\/[^)]+\) \| (.+) \|$/gm)) summaries.set(row[1]!, row[2]!.trim())

for (const mod of mods) {
  const readme = readFileSync(join(REPO, 'plugins', mod, 'README.md'), 'utf8')
  const body = readme.replace(/^# .*\n+/, '')
  const description = summaries.get(mod) ?? firstParagraph(body)
  const source = `\n\n---\n\nこのページは [plugins/${mod}/README.md](${BLOB}/plugins/${mod}/README.md) から生成している。\n`
  write(`mods/(${groupOf(mod).dir})/${mod}.md`, frontmatter({ title: mod, description }) + rewriteLinks(body, `plugins/${mod}`).trim() + source)
}

// 分類ごとの meta.ts と、Mod 一覧の index
const used = [...GROUPS, { dir: 'others', title: 'その他', mods: [] }].filter(g => mods.some(m => groupOf(m).dir === g.dir))
used.forEach((g, i) => {
  const members = mods.filter(m => groupOf(m).dir === g.dir)
  const ordered = [...g.mods.filter(m => members.includes(m)), ...members.filter(m => !g.mods.includes(m))]
  write(`mods/(${g.dir})/meta.ts`, `import { defineMeta } from 'blume'\n\nexport default defineMeta(${JSON.stringify({ title: g.title, order: i + 1, pages: ordered })})\n`)
})
write('mods/meta.ts', `import { defineMeta } from 'blume'\n\nexport default defineMeta(${JSON.stringify({ title: 'Mod 一覧', order: 10, pages: used.map(g => g.dir) })})\n`)

const table = used
  .map(g => {
    const rows = mods.filter(m => groupOf(m).dir === g.dir).sort((a, b) => g.mods.indexOf(a) - g.mods.indexOf(b))
    return `## ${g.title}\n\n| Mod | 役割 |\n|---|---|\n${rows.map(m => `| [${m}](/mods/${m}) | ${(summaries.get(m) ?? '').replace(/\|/g, '\\|')} |`).join('\n')}\n`
  })
  .join('\n')
write('mods/index.md', frontmatter({ title: 'Mod 一覧', description: `このリポジトリにある ${mods.length} 個の Mod を分類ごとに並べる。` }) + table)

const unclassified = mods.filter(m => groupOf(m).dir === 'others')
if (unclassified.length) console.warn(`分類のない Mod (その他に入れた): ${unclassified.join(', ')}。site/scripts/sync.ts の GROUPS に足すこと`)
console.log(`${mods.length} 個の Mod と ${Object.keys(ROOT_PAGES).length} ページを ${relative(REPO, DOCS)} に生成した`)
