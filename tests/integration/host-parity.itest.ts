// harness-profile の allowedHosts 照合が、trust-boundary の hostAllowed と食い違わないことの検査。
// harness-profile は単体で配布されるため trust-boundary を import できず、同じ規則を持っている。
//   bun test ./tests/integration/host-parity.itest.ts
import { describe, expect, test } from 'bun:test'
import { hostAllowedStatus } from '../../plugins/harness-profile/hooks/policy'
import { hostAllowed } from '../../plugins/trust-boundary/hooks/policy'

const URLS = [
  'http://localhost:11434',
  'http://LOCALHOST:11434/api/tags',
  'http://127.0.0.1:11434',
  'http://[::1]:11434',
  'http://gpu.lan:11434',
  'https://sub.gpu.lan',
  'http://user:pw@gpu.lan:1',
  'https://api.notion.com/v1',
  'https://evilgpu.lan',
  'http://gpu.lan.evil.example',
]
const LISTS = ['localhost,127.0.0.1,::1,api.notion.com', 'gpu.lan', 'lan', 'GPU.LAN, localhost', 'example']

describe('harness-profile と trust-boundary の宛先照合', () => {
  test('allowedHosts と URL の組み合わせで同じ判定になる', () => {
    for (const list of LISTS) {
      const allowedHosts = list.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '')
      for (const url of URLS) {
        const expected = hostAllowed(url, { allowedHosts }) ? 'ok' : 'missing'
        expect(hostAllowedStatus({ 'trust-boundary@m': { options: { allowedHosts: list } } }, url)).toBe(expected)
      }
    }
  })

  test('設定が無いときは trust-boundary の既定の許可先と同じ', () => {
    const allowedHosts = ['localhost', '127.0.0.1', '::1', 'api.notion.com']
    for (const url of URLS) expect(hostAllowedStatus({}, url)).toBe(hostAllowed(url, { allowedHosts }) ? 'ok' : 'missing')
  })
})
