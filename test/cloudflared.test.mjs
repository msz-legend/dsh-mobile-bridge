/**
 * cloudflared 模块级行为测试：
 *   1. parseTunnelUrl 对真实日志形态的解析（stdout / stderr / 混合噪声 / 无 URL）；
 *   2. createCloudflared 在二进制不可用时的状态（不抛错、lastError 有记录、running=false）；
 *   3. 未启用时 start() 是 no-op。
 */
import assert from 'node:assert/strict'
import { parseTunnelUrl, createCloudflared } from '../lib/cloudflared.js'

const SAMPLE_LOG = [
  '2026-10-31T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-31T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  '2026-10-31T12:00:00Z INF |  https://wild-cat-dog-1234.trycloudflare.com                                                |',
  '2026-10-31T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
].join('\n')

// 1. 解析（含真实日志形态与服务端点排除）
assert.equal(parseTunnelUrl(SAMPLE_LOG), 'https://wild-cat-dog-1234.trycloudflare.com')
assert.equal(parseTunnelUrl('noise before https://abc-def-ghi.trycloudflare.com trailing'), 'https://abc-def-ghi.trycloudflare.com')
// cloudflared 申请隧道时先打 api 端点，不是隧道地址（真机实测踩过）
assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com'), undefined)
assert.equal(parseTunnelUrl('https://www.trycloudflare.com https://update.trycloudflare.com'), undefined)
// api 端点在前、真地址在后：取第一个非服务端点
assert.equal(
  parseTunnelUrl('POST https://api.trycloudflare.com/tunnel -> https://a-b-c.trycloudflare.com'),
  'https://a-b-c.trycloudflare.com',
)
assert.equal(parseTunnelUrl('https://example.com is not a tunnel'), undefined)
assert.equal(parseTunnelUrl(''), undefined)
assert.equal(parseTunnelUrl(undefined), undefined)
console.log('parseTunnelUrl: ok')

// 2. 二进制不可用：不抛错，状态如实
{
  const logs = []
  const tunnel = createCloudflared({
    config: { tunnelEnabled: true, tunnelMode: 'quick', tunnelToken: '', tunnelBin: 'definitely-not-a-real-binary-8f3a' },
    targetPort: 8787,
    log: (...parts) => logs.push(parts.join(' ')),
  })
  const state = await tunnel.start()
  assert.equal(state.running, false)
  assert.equal(state.enabled, true)
  assert.equal(state.url, undefined)
  assert.ok(typeof state.lastError === 'string' && state.lastError.length > 0, 'lastError should be recorded')
  await tunnel.stop()
  console.log('unavailable binary handled: ok ->', state.lastError.slice(0, 60))
}

// 3. 未启用：start() no-op
{
  const tunnel = createCloudflared({
    config: { tunnelEnabled: false, tunnelMode: 'quick', tunnelToken: '', tunnelBin: 'cloudflared' },
    targetPort: 8787,
    log: () => {},
  })
  const state = await tunnel.start()
  assert.equal(state.running, false)
  assert.equal(state.enabled, false)
  assert.equal(state.lastError, undefined)
  await tunnel.stop()
  console.log('disabled no-op: ok')
}

console.log('cloudflared tests passed')
