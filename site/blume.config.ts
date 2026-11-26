import { defineConfig } from 'blume'

export default defineConfig({
  title: 'utakata-cc-mod',
  description: 'Claude Code の動作をカスタマイズする Mod 集のドキュメント',
  i18n: {
    defaultLocale: 'ja',
    locales: [{ code: 'ja', label: '日本語' }],
  },
  github: {
    owner: 'UtakataKyosui',
    repo: 'utakata-cc-mod',
    dir: 'site',
  },
  // GitHub Pages のプロジェクトサイト (https://utakatakyosui.github.io/utakata-cc-mod/) に置く
  deployment: {
    site: 'https://utakatakyosui.github.io',
    base: process.env.DOCS_BASE ?? '/utakata-cc-mod',
  },
})
