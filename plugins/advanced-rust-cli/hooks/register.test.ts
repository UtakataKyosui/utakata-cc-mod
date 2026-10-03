import { test, expect } from 'claude-code/testing'
import { findBlocked, guidance } from './policy'

const all = new Set(['eza', 'bat', 'fd', 'rg', 'zoxide'])

test('標準コマンドを検出して代替を返す', () => {
  expect(findBlocked('ls -la', all)?.to).toBe('eza')
  expect(findBlocked('cat a.txt', all)?.to).toBe('bat')
  expect(findBlocked('find . -name "*.ts"', all)?.to).toBe('fd')
  expect(findBlocked('git log | grep fix', all)?.to).toBe('rg')
  expect(findBlocked('cd src && /bin/ls', all)?.to).toBe('eza')
  expect(findBlocked('FOO=1 grep x y', all)?.to).toBe('rg')
})

test('引用符の中・別コマンドの引数・Rust 製コマンドは対象外', () => {
  expect(findBlocked('git commit -m "a; ls"', all)).toBeUndefined()
  expect(findBlocked('echo ls', all)).toBeUndefined()
  expect(findBlocked('eza -la && rg foo && bat x', all)).toBeUndefined()
  expect(findBlocked('cd src', all)).toBeUndefined()
})

test('ファイルを書き出す cat は対象外', () => {
  expect(findBlocked("cat <<'EOF' > f.txt", all)).toBeUndefined()
  expect(findBlocked('cat a b > c', all)).toBeUndefined()
})

test('未インストールの代替は強制しない', () => {
  expect(findBlocked('find .', new Set(['eza']))).toBeUndefined()
  expect(findBlocked('ls', new Set())).toBeUndefined()
  expect(guidance(new Set())).toBeUndefined()
  expect(guidance(new Set(['rg']))).toContain('rg')
  expect(guidance(new Set(['rg']))).not.toContain('zoxide')
})
