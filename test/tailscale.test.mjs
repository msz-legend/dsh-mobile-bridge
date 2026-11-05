/** Tailscale 封装纯函数测试：status/funnel 解析。 */
import assert from 'node:assert/strict'

import { parseStatus, parseFunnel } from '../lib/tailscale.js'

assert.equal(parseStatus('not json').loggedIn, false)

const running = parseStatus(
  JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'host.tail000000.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd00::1'], Online: true, HostName: 'host' },
    Health: [],
  }),
)
assert.equal(running.installed, true)
assert.equal(running.loggedIn, true)
assert.equal(running.ip, '100.64.0.1')
assert.equal(running.dnsName, 'host.tail000000.ts.net')

const stopped = parseStatus(JSON.stringify({ BackendState: 'Stopped', Self: {} }))
assert.equal(stopped.loggedIn, false)

const fOn = parseFunnel('# Funnel on:\n#     - https://host.tail000000.ts.net\nhttps://host.tail000000.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787')
assert.equal(fOn.on, true)
assert.equal(fOn.url, 'https://host.tail000000.ts.net')

const fOff = parseFunnel('No serve config')
assert.equal(fOff.on, false)
assert.equal(fOff.url, undefined)

console.log('tailscale parse: PASS')
