/**
 * 隧道健康探测单元测试（不依赖真实隧道）：
 * probeUrl 对 200/401 视为通，对 530/5xx 与连不上视为不健康。
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { probeUrl } from '../lib/cloudflared.js'

const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200)
    res.end('ok')
  } else if (req.url === '/auth') {
    res.writeHead(401)
    res.end('no')
  } else if (req.url === '/bad') {
    res.writeHead(530)
    res.end('tunnel down')
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log('PASS', name)
}

await test('200 视为隧道健康', async () => {
  assert.equal(await probeUrl(base + '/ok', 3000), true)
})
await test('401 也视为健康（入口活着）', async () => {
  assert.equal(await probeUrl(base + '/auth', 3000), true)
})
await test('530 视为不健康（隧道已死）', async () => {
  assert.equal(await probeUrl(base + '/bad', 3000), false)
})

await new Promise((resolve) => server.close(resolve))
await test('连不上视为不健康', async () => {
  assert.equal(await probeUrl(base + '/ok', 2000), false)
})

console.log(`\n${passed} checks passed`)
