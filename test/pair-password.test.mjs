/**
 * 绑定页 HTTP 集成测试：密码是唯一闸门，密码正确即直接发设备令牌。
 *
 * 覆盖测试方案 P1-P9：去扫码自动同意、去桌面确认弹窗、限速、loopback 边界、
 * 已删路由 404、设备上限。真实 http server 包裹 registerRoutes 的 handler。
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
import { registerRoutes, createPairAttemptLimiter, ROUTE_BASE } from '../lib/routes.js'

const PASSWORD = 'test-pass-123'
const log = () => undefined

const makeEnv = ({ maxDevices = 5, pairLimiter, presetDevices = 0, randomPassword = () => PASSWORD } = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-bind-'))
  const config = {
    maxDevices,
    approvalTimeoutMs: 60_000,
    approvalTimeoutRemoteMs: 90_000,
    alwaysScope: 'session',
    tunnelMode: 'quick',
    tunnelEnabled: false,
    sakuraBin: 'frpc',
    tunnelBin: 'cloudflared',
  }
  const store = createStore(tmpRoot)
  const pairing = createPairing({ config, store, log })
  const binding = createBindingManager({ dir: tmpRoot, log, randomPassword })
  binding.ensure()
  for (let i = 0; i < presetDevices; i += 1) pairing.issueDevice(`preset-${i}`)
  const hub = createEventHub(log)
  const broadcasts = []
  hub.broadcastLoopback = (payload) => broadcasts.push(payload)
  const notifyCalls = []
  const publicBaseSets = []
  const rebuildCalls = []

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
    getPublicBase: async () => 'http://127.0.0.1:8787',
    getLaunchUrl: () => undefined,
    getEdgeStatus: () => ({}),
    tunnel: { status: () => ({ enabled: false, mode: 'quick', running: false }), stop: async () => undefined },
    hostLogin: undefined,
    clientHello: { count: 0 },
    setPublicBase: (value) => publicBaseSets.push(value),
    rebuildTunnel: async () => { rebuildCalls.push(1) },
    notify: { getChannels: () => ({}), setChannel: () => ({ ok: true }), dispatch: (payload) => notifyCalls.push(payload) },
    pairLimiter,
  })

  const server = http.createServer((req, res) => captured(req, res))
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = () => `http://127.0.0.1:${server.address().port}`

  const request = async (method, pathname, options = {}) => {
    await ready
    const headers = { ...(options.headers ?? {}) }
    const init = { method, headers, redirect: 'manual' }
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    }
    const response = await fetch(origin() + pathname, init)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    return {
      status: response.status,
      text,
      json: data,
      location: response.headers.get('location'),
      setCookie: response.headers.get('set-cookie') ?? '',
    }
  }

  return {
    request,
    config,
    pairing,
    binding,
    broadcasts,
    notifyCalls,
    publicBaseSets,
    rebuildCalls,
    tmpRoot,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

const form = (fields) => {
  const body = new URLSearchParams(fields).toString()
  return { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }
}

let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

// P1：正确密码 + 手机侧转发头 → 直接 303 + dmb cookie，无桌面确认、无通知、无广播。
{
  const env = makeEnv()
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: PASSWORD, name: 'phone' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '1.2.3.4', 'x-dmb-proto': 'http' },
    })
    assert.equal(res.status, 303)
    assert.equal(res.location, '/')
    assert.match(res.setCookie, /dmb=[^;]+/)
    assert.doesNotMatch(res.setCookie, /; Secure/i, 'http 明文场景不应假装安全')
    assert.equal(env.broadcasts.length, 0, '不得广播 pair-request')
    assert.equal(env.notifyCalls.length, 0, '不得发送配对通知')
    assert.equal(env.pairing.listDevices().length, 1)
    pass('P1 correct password binds directly over HTTP (no confirm, no notify)')

    const httpsRes = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: PASSWORD, name: 'phone-https' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '1.2.3.5', 'x-dmb-proto': 'https' },
    })
    assert.equal(httpsRes.status, 303)
    assert.match(httpsRes.setCookie, /; Secure/i)
    pass('P1b https request gets Secure cookie')
  } finally {
    await env.close()
  }
}

// P2 / P3：错误密码与空密码 → 403 + 错误文案，不下发设备令牌。
{
  const env = makeEnv()
  try {
    const wrong = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: 'wrong-one' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '2.2.2.2' },
    })
    assert.equal(wrong.status, 403)
    assert.match(wrong.text, /绑定密码不正确/)
    assert.doesNotMatch(wrong.setCookie, /dmb=/)

    const empty = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: '' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '2.2.2.3' },
    })
    assert.equal(empty.status, 403)
    assert.doesNotMatch(empty.setCookie, /dmb=/)
    assert.equal(env.pairing.listDevices().length, 0)
    pass('P2/P3 wrong or empty password is 403 without device cookie')
  } finally {
    await env.close()
  }
}

// P4：同一来源 10 次/分钟滑动窗口；窗口推进后恢复。
{
  let clock = 1_000_000
  const limiter = createPairAttemptLimiter({ perMinute: 10, now: () => clock })
  const env = makeEnv({ pairLimiter: limiter })
  const ip = '3.3.3.3'
  const post = (password) => env.request('POST', `${ROUTE_BASE}/pair`, {
    ...form({ password }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': ip },
  })
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await post('nope')
      assert.equal(res.status, 403, `attempt ${i + 1} should be 403`)
    }
    const eleventh = await post('nope')
    assert.equal(eleventh.status, 429)
    assert.match(eleventh.text, /尝试过于频繁/)
    const stillBlocked = await post(PASSWORD)
    assert.equal(stillBlocked.status, 429, '正确密码在窗口内也应被挡住')
    clock += 61_000
    const recovered = await post(PASSWORD)
    assert.equal(recovered.status, 303)
    assert.match(recovered.setCookie, /dmb=/)
    pass('P4 pair limiter 10/min with injectable clock')
  } finally {
    await env.close()
  }
}

// P5：loopback 直发同样密码正确即绑定，无确认弹窗。
{
  const env = makeEnv()
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/pair`, form({ password: PASSWORD, name: 'desktop' }))
    assert.equal(res.status, 303)
    assert.equal(res.location, '/')
    assert.equal(env.broadcasts.length, 0)
    pass('P5 loopback direct POST binds without desktop confirmation')
  } finally {
    await env.close()
  }
}

// P6：绑定信息仅 loopback 可读，含明文密码与纯 URL 二维码，不含一次性 code。
{
  const env = makeEnv()
  try {
    const ok = await env.request('GET', `${ROUTE_BASE}/pairing.json`)
    assert.equal(ok.status, 200)
    assert.equal(ok.json?.password, PASSWORD)
    assert.equal(ok.json?.publicBase, 'http://127.0.0.1:8787')
    assert.equal(ok.json?.pairUrl, `http://127.0.0.1:8787${ROUTE_BASE}/pair`)
    assert.equal(Object.prototype.hasOwnProperty.call(ok.json, 'code'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(ok.json, 'expiresAt'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(ok.json, 'pendingConfirm'), false)
    assert.equal(typeof ok.json?.qrDataUrl, 'string')
    assert.ok(ok.json.qrDataUrl.startsWith('data:image/png;base64,'))

    const blocked = await env.request('GET', `${ROUTE_BASE}/pairing.json`, {
      headers: { 'x-dmb-forwarded-for': '5.5.5.5' },
    })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.json?.error, 'loopback-only')
    pass('P6 /pairing.json reveals password to loopback only, no one-time code')
  } finally {
    await env.close()
  }
}

// P7：绑定页无自动提交脚本、密码输入框、二维码地址不含 #。
{
  const env = makeEnv()
  try {
    const page = await env.request('GET', `${ROUTE_BASE}/pair`)
    assert.equal(page.status, 200)
    assert.match(page.text, /name="password"/)
    assert.doesNotMatch(page.text, /requestSubmit/)
    assert.doesNotMatch(page.text, /location\.hash/)
    assert.match(page.text, /<img class="qr"/)
    const info = await env.request('GET', `${ROUTE_BASE}/pairing.json`)
    assert.equal(info.json?.pairUrl.includes('#'), false)
    pass('P7 pair page has no QR auto-submit and no hash-embedded code')
  } finally {
    await env.close()
  }
}

// P8：旧确认状态机路由已彻底删除（notify stub 已装配，故应落到 404 而非 503）。
{
  const env = makeEnv()
  try {
    const state = await env.request('GET', `${ROUTE_BASE}/pair/state?confirmId=cfm_x`)
    assert.equal(state.status, 404)
    assert.equal(state.json?.error, 'not-found')
    const confirm = await env.request('POST', `${ROUTE_BASE}/devices/confirm`, { body: { confirmId: 'cfm_x', decision: 'allow' } })
    assert.equal(confirm.status, 404)
    pass('P8 removed confirmation routes return 404')
  } finally {
    await env.close()
  }
}

// P9：设备上限时正确密码也被拒绝，且不会多发令牌。
{
  const env = makeEnv({ maxDevices: 1, presetDevices: 1 })
  try {
    const res = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: PASSWORD, name: 'overflow' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '6.6.6.6' },
    })
    assert.equal(res.status, 429)
    assert.match(res.text, /设备上限/)
    assert.doesNotMatch(res.setCookie, /dmb=/)
    assert.equal(env.pairing.listDevices().length, 1)
    pass('P9 device limit rejects a correct password')
  } finally {
    await env.close()
  }
}

// P10：绑定密码重生成 / 自定义（loopback only，长度校验，旧密码立即失效）。
{
  let generated = 0
  const rotating = () => (generated++ === 0 ? PASSWORD : 'regenerated-pass-456')
  const env = makeEnv({ randomPassword: rotating })
  try {
    const regenerated = await env.request('POST', `${ROUTE_BASE}/binding/regenerate`, { body: { password: '' } })
    assert.equal(regenerated.status, 200)
    assert.equal(regenerated.json.ok, true)
    assert.equal(typeof regenerated.json.password, 'string')
    assert.notEqual(regenerated.json.password, PASSWORD)
    assert.equal(regenerated.json.hasCustomBinding, false)
    const rotated = regenerated.json.password

    const tooShort = await env.request('POST', `${ROUTE_BASE}/binding/regenerate`, { body: { password: '12345' } })
    assert.equal(tooShort.status, 400)
    assert.equal(tooShort.json.error, 'binding-password-length')

    const custom = await env.request('POST', `${ROUTE_BASE}/binding/regenerate`, { body: { password: 'my-custom-secret' } })
    assert.equal(custom.status, 200)
    assert.equal(custom.json.password, 'my-custom-secret')
    assert.equal(custom.json.hasCustomBinding, true)

    const denied = await env.request('POST', `${ROUTE_BASE}/binding/regenerate`, {
      body: { password: '' },
      headers: { 'x-dmb-forwarded-for': '9.9.9.9' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error, 'loopback-only')

    const wrong = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: PASSWORD, name: 'old-secret' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '8.8.8.8' },
    })
    assert.equal(wrong.status, 403)
    assert.equal(env.pairing.listDevices().length, 0)

    const good = await env.request('POST', `${ROUTE_BASE}/pair`, {
      ...form({ password: 'my-custom-secret', name: 'new-secret' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dmb-forwarded-for': '8.8.8.8' },
    })
    assert.equal(good.status, 303)
    assert.match(good.setCookie, /dmb=/)
    assert.equal(env.pairing.listDevices().length, 1)
    assert.notEqual(rotated, 'my-custom-secret')
    pass('P10 binding password rotate/custom works, loopback-only, old password invalidated')
  } finally {
    await env.close()
  }
}

// C3 / C4：静态契约——旧状态机符号消失，新 SakuraFrp 符号存在。
{
  const routesText = fs.readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  assert.doesNotMatch(routesText, /confirmWaitPage\(/)
  assert.doesNotMatch(routesText, /stageConfirm\(/)
  assert.doesNotMatch(routesText, /resolveConfirm\(/)
  assert.doesNotMatch(routesText, /pendingConfirm/)
  assert.doesNotMatch(routesText, /type: 'pair-request'/)
  assert.match(routesText, /\/sakura\/setup/)
  assert.match(routesText, /createPairAttemptLimiter/)
  const indexText = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(indexText, /autoApprovePairing/)
  assert.doesNotMatch(indexText, /pairingMaxAttempts/)
  assert.doesNotMatch(indexText, /pairConfirmTtlMs/)
  assert.match(indexText, /createSakuraFrp/)
  assert.match(indexText, /rebuildTunnel/)
  pass('C3/C4 static contracts: old pairing state machine removed, SakuraFrp wired')
}

console.log(`\n${passed} checks passed`)
