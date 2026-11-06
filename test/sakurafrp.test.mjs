/**
 * SakuraFrp 隧道后端测试（Task 3）。
 * 覆盖日志地址解析、入参校验、no-op、假 frpc 进程生命周期、健康探测重启。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseFrpcUrl, detectSakuraBin, createSakuraFrp } from '../lib/sakurafrp.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-sakura-'))
const log = () => undefined
let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeFrpc = () => {
  const file = path.join(tmpRoot, `fake-frpc-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(
    file,
    `console.log('启动成功，访问地址：http://frp-test.natfrp.cloud:12345');\nsetInterval(()=>{}, 60000);\n`,
  )
  return file
}

const baseConfig = (overrides = {}) => ({
  tunnelMode: 'sakura',
  tunnelEnabled: true,
  sakuraBin: 'frpc',
  sakuraToken: 'tok_abcdef',
  sakuraTunnelId: '123456',
  ...overrides,
})

try {
  // S1 parseFrpcUrl fixtures
  {
    assert.equal(parseFrpcUrl('启动成功，访问地址：http://frp-abc123.natfrp.cloud:45678\n'), 'http://frp-abc123.natfrp.cloud:45678')
    assert.equal(parseFrpcUrl('隧道已启动: https://my-sub.frp-3.top\n'), 'https://my-sub.frp-3.top')
    assert.equal(parseFrpcUrl('see https://xxx.natfrp.cloud for details'), 'https://xxx.natfrp.cloud')
    assert.equal(parseFrpcUrl('frpc started, waiting...'), undefined)
    assert.equal(parseFrpcUrl('https://www.natfrp.com/ 是官网，不是访问地址'), undefined)
    assert.equal(parseFrpcUrl(undefined), undefined)
    pass('S1 parseFrpcUrl handles 6 fixtures incl. non-tunnel .com host')
  }

  // S2 空 token / tunnelId → start() 拒绝
  {
    await assert.rejects(
      () => createSakuraFrp({ config: baseConfig({ sakuraToken: '' }), targetPort: 8787, log }).start(),
      /tunnelMode=sakura requires sakuraToken and sakuraTunnelId/,
    )
    await assert.rejects(
      () => createSakuraFrp({ config: baseConfig({ sakuraTunnelId: '' }), targetPort: 8787, log }).start(),
      /tunnelMode=sakura requires sakuraToken and sakuraTunnelId/,
    )
    pass('S2 start() rejects when token or tunnelId is empty')
  }

  // S3 非 sakura 模式 no-op
  {
    const tunnel = createSakuraFrp({ config: baseConfig({ tunnelMode: 'quick' }), targetPort: 8787, log })
    const state = await tunnel.start()
    assert.equal(state.enabled, false)
    assert.equal(state.running, false)
    pass('S3 non-sakura mode is a no-op')
  }

  // S4 假 frpc：解析 URL → running → stop
  {
    const script = fakeFrpc()
    let seen
    const tunnel = createSakuraFrp({
      config: baseConfig(),
      targetPort: 8787,
      log,
      bin: process.execPath,
      binArgs: [script],
      healthUrl: () => undefined,
      onUrl: (url) => {
        seen = url
      },
    })
    await tunnel.start()
    for (let i = 0; i < 40 && seen === undefined; i += 1) await sleep(50)
    assert.equal(seen, 'http://frp-test.natfrp.cloud:12345', 'onUrl got parsed address')
    assert.equal(tunnel.status().running, true)
    assert.equal(tunnel.status().mode, 'sakura')
    assert.equal(tunnel.url(), seen)
    await tunnel.stop()
    for (let i = 0; i < 40 && tunnel.status().running === true; i += 1) await sleep(50)
    assert.equal(tunnel.status().running, false)
    pass('S4 fake frpc: URL parsed, process running, stop() reaps it')
  }

  // S5 健康探测失败累计到阈值 → 重启计数上升
  {
    const script = fakeFrpc()
    const tunnel = createSakuraFrp({
      config: baseConfig(),
      targetPort: 8787,
      log,
      bin: process.execPath,
      binArgs: [script],
      healthUrl: () => 'http://fake-health.invalid',
      healthIntervalMs: 20,
      healthFailLimit: 2,
      probe: async () => false,
    })
    await tunnel.start()
    for (let i = 0; i < 80 && tunnel.status().restarts < 1; i += 1) await sleep(50)
    assert.ok(tunnel.status().restarts >= 1, 'health failures trigger a restart')
    await tunnel.stop()
    pass('S5 health failures kill the child and count a restart')
  }

  // S6 detectSakuraBin
  {
    const missing = await detectSakuraBin(path.join(tmpRoot, 'definitely-not-a-binary'))
    assert.equal(missing.installed, false)
    const present = await detectSakuraBin(process.execPath)
    assert.equal(present.installed, true)
    assert.ok(typeof present.version === 'string')
    pass('S6 detectSakuraBin reports missing/present binaries')
  }

  console.log(`\n${passed} checks passed`)
} finally {
  // 给可能仍在退出的子进程一点时间，再清临时目录
  await sleep(200)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
