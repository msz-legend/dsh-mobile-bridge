/**
 * SakuraFrp 隧道后端测试（Task 3）。
 * 覆盖日志地址解析、入参校验、no-op、假 frpc 进程生命周期、健康探测重启。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseFrpcUrl, frpcHttpsHint, detectSakuraBin, createSakuraFrp } from '../lib/sakurafrp.js'

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

// 自动 HTTPS 证据先出现，随后被 2000 字符滚动窗口冲掉，粘性标志仍须保留
const fakeTlsFrpc = () => {
  const file = path.join(tmpRoot, `fake-tls-frpc-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(
    file,
    [
      `console.log('已从服务器为 cn-hk-nf-1.natfrp.cloud 加载证书 [CN = natfrp]');`,
      `setTimeout(() => console.log('x'.repeat(3000)), 30);`,
      `setTimeout(() => console.log('使用 >>cn-hk-nf-1.natfrp.cloud:51906<< 连接你的隧道'), 60);`,
      `setInterval(()=>{}, 60000);`,
    ].join('\n'),
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

  // S7 官方 frpc 日志形态（doc.natfrp.com/app/http.html、/bestpractice/domain-bind.html）
  {
    // 子域绑定：日志用 >>host:port<<，无协议；nyat.app 官方开启 HSTS → https
    assert.equal(
      parseFrpcUrl('TCP 隧道启动成功\n使用 >>www.example.nyat.app:10086<< 连接你的隧道\n'),
      'https://www.example.nyat.app:10086',
    )
    // 同时给出 IP 备选时，域名优先
    assert.equal(
      parseFrpcUrl('使用 >>www.example.nyat.app:10086<< 连接你的隧道\n或使用 IP 地址连接: >>114.51.4.191:10086<<\n'),
      'https://www.example.nyat.app:10086',
    )
    // 节点域名（带协议 + 端口）
    assert.equal(parseFrpcUrl('可访问 http://cn-hk-nf-1.natfrp.cloud:51906'), 'http://cn-hk-nf-1.natfrp.cloud:51906')
    assert.equal(parseFrpcUrl('http://frp-xxx.com:12345'), 'http://frp-xxx.com:12345')
    assert.equal(parseFrpcUrl('https://www.example.nyat.app:10086'), 'https://www.example.nyat.app:10086')
    // 标记形式 + 自动 HTTPS 证据 → https（节点域名本身不是 nyat.app）
    assert.equal(
      parseFrpcUrl('已从服务器为 cn-hk-nf-1.natfrp.cloud 加载证书 [CN = ...]\n使用 >>cn-hk-nf-1.natfrp.cloud:51906<< 连接你的隧道'),
      'https://cn-hk-nf-1.natfrp.cloud:51906',
    )
    assert.equal(parseFrpcUrl('使用 >>cn-hk-nf-1.natfrp.cloud:51906<< 连接你的隧道', { httpsHint: true }), 'https://cn-hk-nf-1.natfrp.cloud:51906')
    // 无 TLS 证据的节点域名 → http
    assert.equal(parseFrpcUrl('使用 >>cn-hk-nf-1.natfrp.cloud:51906<< 连接你的隧道'), 'http://cn-hk-nf-1.natfrp.cloud:51906')
    // 只给 IP 时也能用
    assert.equal(parseFrpcUrl('或使用 IP 地址连接: >>114.51.4.191:10086<<'), 'http://114.51.4.191:10086')
    // 官网/文档/启动器/私网/杂项 URL 一律排除
    for (const bad of [
      'https://www.natfrp.com/tunnel/download',
      'https://doc.natfrp.com/app/http.html',
      'https://launcher.natfrp.com/',
      'http://127.0.0.1:8787/',
      'http://192.168.1.10:8787/',
      'https://github.com/example/repo',
      '隧道已绑定 SRV 域名, 可通过 [mc.example.nyat.app] 进行连接',
    ]) {
      assert.equal(parseFrpcUrl(bad), undefined, `should not pick ${bad}`)
    }
    assert.equal(frpcHttpsHint('已从服务器为 www.example.nyat.app 加载证书 [CN = ...]'), true)
    assert.equal(frpcHttpsHint('TCP 隧道启动成功'), false)
    pass('S7 official frpc log formats: >>host:port<<, nyat.app, frp-*.com/top, auto-HTTPS, official/private exclusion')
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

  // S8 证书证据被日志滚动冲掉后仍按 https 解析（粘性 tlsHint）
  {
    const script = fakeTlsFrpc()
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
    for (let i = 0; i < 60 && seen === undefined; i += 1) await sleep(50)
    assert.equal(seen, 'https://cn-hk-nf-1.natfrp.cloud:51906', 'sticky TLS hint survives log rotation')
    await tunnel.stop()
    pass('S8 sticky auto-HTTPS hint survives log tail rotation')
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
