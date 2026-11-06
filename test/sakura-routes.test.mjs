/**
 * SakuraFrp 设置路由 HTTP 集成测试（测试方案 R1-R8）。
 *
 * 关注点：向后兼容（写 sakura 键不破坏 cloudflare 的 token/publicBase/serviceManaged）、
 * 随机域名/手填域名两条路径、loopback 边界、rebuildTunnel 未装配时的容错。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createPairing } from '../lib/pairing.js'
import { createBindingManager } from '../lib/binding.js'
import { createEventHub } from '../lib/events.js'
import { registerRoutes, ROUTE_BASE } from '../lib/routes.js'
import { readTunnelFile, writeTunnelFile } from '../lib/cloudflare-setup.js'

const log = () => undefined

const makeEnv = ({ rebuildTunnel = true, seedFile } = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-sakura-'))
  const config = {
    maxDevices: 5,
    approvalTimeoutMs: 60_000,
    approvalTimeoutRemoteMs: 90_000,
    alwaysScope: 'session',
    edgePort: 8787,
    tunnelMode: seedFile !== undefined ? 'token' : 'quick',
    tunnelEnabled: false,
    sakuraToken: '',
    sakuraTunnelId: '',
    sakuraDomain: '',
    sakuraBin: 'frpc',
    tunnelToken: '',
    publicBase: '',
    tunnelBin: 'cloudflared',
  }
  if (seedFile !== undefined) {
    config.tunnelToken = seedFile.token
    config.publicBase = seedFile.publicBase
    writeTunnelFile(tmpRoot, seedFile)
  }
  const store = createStore(tmpRoot)
  const pairing = createPairing({ config, store, log })
  const binding = createBindingManager({ dir: tmpRoot, log })
  const hub = createEventHub(log)
  const rebuildCalls = []
  const publicBaseSets = []

  let captured
  const ctx = {
    webServer: {
      register: ({ handler }) => {
        captured = handler
        return () => undefined
      },
    },
  }
  registerRoutes(ctx, {
    config,
    pairing,
    binding,
    hub,
    bridge: { pendingCount: () => 0, pending: () => [], replayRequests: () => undefined, decide: () => ({ ok: false }) },
    always: { list: () => [], revoke: () => true },
    store,
    log,
    getPublicBase: async () => config.publicBase || 'http://127.0.0.1:8787',
    getLaunchUrl: () => undefined,
    getEdgeStatus: () => ({}),
    tunnel: { status: () => ({ enabled: false, mode: config.tunnelMode, running: false }), stop: async () => undefined },
    hostLogin: undefined,
    clientHello: { count: 0 },
    setPublicBase: (value) => {
      publicBaseSets.push(value)
      config.publicBase = value
    },
    rebuildTunnel: rebuildTunnel === true ? async () => { rebuildCalls.push(1) } : undefined,
    notify: { getChannels: () => ({}), setChannel: () => ({ ok: true }) },
  })

  const server = http.createServer((req, res) => captured(req, res))
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const request = async (method, pathname, options = {}) => {
    await ready
    const headers = { ...(options.headers ?? {}) }
    const init = { method, headers, redirect: 'manual' }
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + pathname, init)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    return { status: response.status, text, json: data }
  }

  return {
    request,
    config,
    rebuildCalls,
    publicBaseSets,
    tmpRoot,
    file: () => readTunnelFile(tmpRoot),
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

const phone = (method, pathname, options) => ({ ...options, headers: { ...(options?.headers ?? {}), 'x-dmb-forwarded-for': '9.9.9.9' } })

let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

// R1：初始状态字段齐全。
{
  const env = makeEnv()
  try {
    const res = await env.request('GET', `${ROUTE_BASE}/sakura.json`)
    assert.equal(res.status, 200)
    assert.equal(res.json?.ok, true)
    for (const key of ['frpcInstalled', 'version', 'mode', 'publicBase', 'hasKey', 'hasTunnelId', 'customDomain', 'running', 'url', 'lastError', 'reachable']) {
      assert.equal(Object.prototype.hasOwnProperty.call(res.json, key), true, `missing field ${key}`)
    }
    assert.equal(res.json.mode, 'quick')
    assert.equal(res.json.hasKey, false)
    assert.equal(res.json.reachable, false, 'loopback 地址不应发起外网探测')
    pass('R1 GET /sakura.json returns full initial state')
  } finally {
    await env.close()
  }
}

// R2 / R3：参数校验错误码。
{
  const env = makeEnv()
  try {
    const noToken = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, { body: { token: '', tunnelId: '12345', domainChoice: 'auto' } })
    assert.equal(noToken.status, 400)
    assert.equal(noToken.json?.error, 'sakura-token-required')
    const noId = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, { body: { token: 'abcdefghijklmnop', tunnelId: '', domainChoice: 'auto' } })
    assert.equal(noId.status, 400)
    assert.equal(noId.json?.error, 'sakura-tunnelid-required')
    const badDomain = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, { body: { token: 'abcdefghijklmnop', tunnelId: '12345', domainChoice: 'custom', domain: 'not-a-url' } })
    assert.equal(badDomain.status, 400)
    assert.equal(badDomain.json?.error, 'sakura-domain-invalid')
    assert.equal(env.rebuildCalls.length, 0)
    pass('R2/R3 setup validation error codes')
  } finally {
    await env.close()
  }
}

// R4：auto 随机域名 + 向后兼容（保留 cloudflare 既有键）。
{
  const seed = { token: 'cf-token-abcdefghijklmnop', publicBase: 'https://cf.example.com', serviceManaged: true }
  const env = makeEnv({ seedFile: seed })
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, {
      body: { token: 'sakura-key-xyz', tunnelId: '7605087', domainChoice: 'auto', domain: 'ignored.example.com' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.ok, true)
    const file = env.file()
    assert.equal(file.token, seed.token, 'cloudflare token 必须保留')
    assert.equal(file.publicBase, seed.publicBase, 'cloudflare publicBase 必须保留')
    assert.equal(file.serviceManaged, true, 'serviceManaged 必须保留')
    assert.deepEqual(file.sakura, { token: 'sakura-key-xyz', tunnelId: '7605087', domain: '' })
    assert.equal(env.config.tunnelMode, 'sakura')
    assert.equal(env.config.sakuraToken, 'sakura-key-xyz')
    assert.equal(env.config.sakuraTunnelId, '7605087')
    assert.equal(env.config.sakuraDomain, '')
    assert.equal(env.config.tunnelEnabled, true)
    assert.equal(env.config.publicBase, '', 'auto 模式应清空 publicBase 让 frpc 上报随机子域')
    assert.equal(env.rebuildCalls.length, 1)
    pass('R4 auto-domain setup preserves legacy cloudflare keys')
  } finally {
    await env.close()
  }
}

// R5：custom 手填域名落盘并应用到 publicBase。
{
  const env = makeEnv()
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, {
      body: { token: 'sakura-key-xyz', tunnelId: '7605087', domainChoice: 'custom', domain: 'https://mine.example.com/' },
    })
    assert.equal(res.status, 200)
    assert.equal(env.file().sakura.domain, 'https://mine.example.com')
    assert.equal(env.config.sakuraDomain, 'https://mine.example.com')
    assert.equal(env.config.publicBase, 'https://mine.example.com')
    assert.ok(env.publicBaseSets.includes('https://mine.example.com'))
    assert.equal(env.rebuildCalls.length, 1)
    pass('R5 custom domain is trimmed, persisted and applied')
  } finally {
    await env.close()
  }
}

// R6：clear 只删 sakura 键，回到 quick。
{
  const seed = { token: 'cf-token-abcdefghijklmnop', publicBase: 'https://cf.example.com', serviceManaged: false }
  const env = makeEnv({ seedFile: seed })
  try {
    await env.request('POST', `${ROUTE_BASE}/sakura/setup`, { body: { token: 'sakura-key-xyz', tunnelId: '7605087', domainChoice: 'auto' } })
    const res = await env.request('POST', `${ROUTE_BASE}/sakura/clear`, { body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.json?.ok, true)
    const file = env.file()
    assert.equal(Object.prototype.hasOwnProperty.call(file, 'sakura'), false)
    assert.equal(file.token, seed.token)
    assert.equal(file.publicBase, seed.publicBase)
    assert.equal(file.serviceManaged, false)
    assert.equal(env.config.tunnelMode, 'quick')
    assert.equal(env.config.sakuraToken, '')
    assert.equal(env.config.publicBase, '')
    assert.equal(env.rebuildCalls.length, 2)
    pass('R6 clear removes only sakura key and restores quick mode')
  } finally {
    await env.close()
  }
}

// R7：三条路由都是 loopback-only。
{
  const env = makeEnv()
  try {
    for (const [method, pathname] of [
      ['GET', '/sakura.json'],
      ['POST', '/sakura/setup'],
      ['POST', '/sakura/clear'],
    ]) {
      const res = await env.request(method, `${ROUTE_BASE}${pathname}`, phone(method, pathname, { body: method === 'POST' ? {} : undefined }))
      assert.equal(res.status, 403, `${method} ${pathname}`)
      assert.equal(res.json?.error, 'loopback-only')
    }
    pass('R7 sakura endpoints are loopback-only')
  } finally {
    await env.close()
  }
}

// R8：rebuildTunnel 未装配 → 503（不静默半配置）。
{
  const env = makeEnv({ rebuildTunnel: false })
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/sakura/setup`, {
      body: { token: 'sakura-key-xyz', tunnelId: '7605087', domainChoice: 'auto' },
    })
    assert.equal(res.status, 503)
    assert.equal(res.json?.error, 'rebuild-unavailable')
    assert.equal(Object.prototype.hasOwnProperty.call(env.file(), 'sakura'), false)
    pass('R8 missing rebuildTunnel is reported as 503')
  } finally {
    await env.close()
  }
}

console.log(`\n${passed} checks passed`)
