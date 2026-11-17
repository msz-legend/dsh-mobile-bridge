/**
 * 体验优化专项回归（v0.7 优化项）：
 *  #1 always 规则可视管理 —— GET /rules.json + POST /rules/clear（loopback）。
 *  #2 推送通道测试 —— POST /push/test（loopback，直接试发，透传 {ok,status,error}）。
 *  #4 绑定表单 —— 错误后保留用户名输入；限速前剩余次数提示；密码可见切换按钮。
 *  #9 手机端解绑本机 —— GET /session.json + POST /session/unbind（设备令牌认证，只能解绑自己）。
 * 复用 pair-password.test.mjs 的 makeEnv/http-server 包裹模式。
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
import { createAlways } from '../lib/always.js'
import { createPairAttemptLimiter, registerRoutes } from '../lib/routes.js'

const PASSWORD = 'test-pass-123'
const log = () => undefined

const makeEnv = ({ maxDevices = 5, pairLimiter, randomPassword = () => PASSWORD, alwaysImpl } = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-opt-'))
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
  const hub = createEventHub(log)
  const notifyCalls = []

  const always = alwaysImpl ?? { list: () => [], revoke: () => true, clear: () => undefined }

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
    always,
    store,
    log,
    getPublicBase: async () => 'http://127.0.0.1:8787',
    getLaunchUrl: () => undefined,
    getEdgeStatus: () => ({}),
    tunnel: { status: () => ({ enabled: false, mode: 'quick', running: false }), stop: async () => undefined },
    hostLogin: undefined,
    clientHello: { count: 0 },
    setPublicBase: () => undefined,
    rebuildTunnel: async () => undefined,
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
    notifyCalls,
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

const edgeHeaders = () => ({ 'x-dmb-forwarded-for': '198.51.100.7' })
// 直连 127.0.0.1 且无转发头 = 桌面本机；带 x-dmb-forwarded-for = 手机经 edge 转发（loopback-only 路由应拒绝）。

let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

// R1：#1 —— GET /rules.json loopback 列出规则；公网 403。
{
  const rules = [
    { id: 'rule_a', toolName: 'bash', key: 'cmd:git *', label: 'bash · git *', scope: 'global', createdAt: 1 },
    { id: 'rule_b', toolName: 'write', key: 'path:/tmp/**', label: 'write · /tmp/**', scope: 'session', sessionId: 's1', createdAt: 2 },
  ]
  const env = await makeEnv({ alwaysImpl: { list: () => rules, revoke: () => true, clear: () => undefined } })
  try {
    const denied = await env.request('GET', '/plugins/dsh-mobile-bridge/rules.json', { headers: edgeHeaders() })
    assert.equal(denied.status, 403, '经 edge 转发的来源不得读取规则列表')
    const ok = await env.request('GET', '/plugins/dsh-mobile-bridge/rules.json')
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.total, 2)
    assert.equal(ok.json.rules.length, 2)
    assert.equal(ok.json.rules[0].id, 'rule_a')
    pass('R1 rules.json loopback-only + full list')
  } finally {
    await env.close()
  }
}

// R2：#1 —— POST /rules/clear loopback 清空规则并返回清除数；公网 403。
{
  let cleared = false
  let count = 2
  const env = await makeEnv({
    alwaysImpl: {
      list: () => (cleared ? [] : [{ id: 'rule_a' }, { id: 'rule_b' }]),
      revoke: () => true,
      clear: () => { cleared = true; count = 0 },
    },
  })
  try {
    const base = '/plugins/dsh-mobile-bridge'
    const denied = await env.request('POST', `${base}/rules/clear`, { body: {}, headers: edgeHeaders() })
    assert.equal(denied.status, 403, '经 edge 转发的来源不得清空规则')
    const ok = await env.request('POST', `${base}/rules/clear`, { body: {} })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.cleared, 2)
    assert.equal(cleared, true)
    const after = await env.request('GET', `${base}/rules.json`)
    assert.equal(after.json.total, 0)
    pass('R2 rules/clear loopback-only + cleared count')
  } finally {
    await env.close()
  }
}

// R3：#2 —— POST /push/test loopback 试发成功透传 {ok,status}；未配置通道透传 not-configured；未知通道 400；公网 403。
{
  const env = await makeEnv()
  try {
    const base = '/plugins/dsh-mobile-bridge'
    const denied = await env.request('POST', `${base}/push/test`, { body: { channel: 'ntfy' }, headers: edgeHeaders() })
    assert.equal(denied.status, 403, '经 edge 转发的来源不得试发推送')

    const unknown = await env.request('POST', `${base}/push/test`, { body: { channel: 'nope' } })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error, 'unknown-channel')

    // ntfy 未配置 topic → sendChannelNotification 返回 not-configured，路由透传。
    const missing = await env.request('POST', `${base}/push/test`, { body: { channel: 'ntfy' } })
    assert.equal(missing.status, 200)
    assert.equal(missing.json.ok, false)
    assert.equal(missing.json.error, 'not-configured')

    // 配置一个本地 webhook 接收器验证真实试发。
    const received = []
    const receiver = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        received.push(raw)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`
    try {
      const sent = await env.request('POST', `${base}/push/test`, { body: { channel: 'webhook', fields: { url: hookUrl } } })
      assert.equal(sent.status, 200)
      assert.equal(sent.json.ok, true, `webhook 试发应成功：${JSON.stringify(sent.json)}`)
      assert.equal(typeof sent.json.status, 'number')
      assert.equal(received.length, 1, '测试推送应到达接收端')
    } finally {
      await new Promise((resolve) => receiver.close(resolve))
    }
    pass('R3 push/test loopback-only + passthrough + real webhook')
  } finally {
    await env.close()
  }
}

// R4：#4 —— 绑定失败后表单保留 name 输入（密码不回填），并显示剩余次数提示。
{
  const env = await makeEnv({ pairLimiter: createPairAttemptLimiter({ perMinute: 10 }) })
  try {
    const response = await env.request('POST', '/plugins/dsh-mobile-bridge/pair', form({ password: 'wrong', name: '我的手机' }))
    assert.equal(response.status, 403)
    assert.match(response.text, /绑定密码不正确|绑定失败|incorrect/, '应显示绑定失败文案')
    assert.match(response.text, /value="我的手机"/, '错误后应保留设备名输入')
    assert.ok(!response.text.includes('value="wrong"'), '密码绝不回填进 HTML')
    // 剩余提示按设计在 4 次失败后才亮出（remaining<=4），连续失败 6 次后必然可见。
    let lastResponse = response
    for (let i = 0; i < 6; i += 1) {
      lastResponse = await env.request('POST', '/plugins/dsh-mobile-bridge/pair', form({ password: 'wrong', name: '我的手机' }))
    }
    assert.equal(lastResponse.status, 403)
    assert.match(lastResponse.text, /还可再试 \d+ 次/, '剩余次数提示应出现在页面上')
    // 密码可见切换按钮存在（#4）。
    assert.match(response.text, /data-toggle-pw/, '应渲染密码可见性切换按钮')
    pass('R4 pair error keeps name + remaining hint + pw toggle')
  } finally {
    await env.close()
  }
}

// R5：#9 —— session.json / session/unbind 只作用于调用设备自身。
{
  const env = await makeEnv({ maxDevices: 5 })
  try {
    const base = '/plugins/dsh-mobile-bridge'
    const first = await env.request('POST', `${base}/pair`, form({ password: PASSWORD, name: 'phone-a' }))
    assert.equal(first.status, 303)
    const cookieA = first.setCookie.split(';')[0]
    const second = await env.request('POST', `${base}/pair`, form({ password: PASSWORD, name: 'phone-b' }))
    assert.equal(second.status, 303)
    const cookieB = second.setCookie.split(';')[0]

    const noAuth = await env.request('GET', `${base}/session.json`)
    assert.equal(noAuth.status, 401, '无设备令牌不得读取会话')

    const sessionA = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieA } })
    assert.equal(sessionA.status, 200)
    assert.equal(sessionA.json.ok, true)
    assert.equal(sessionA.json.name, 'phone-a')
    const deviceIdA = sessionA.json.deviceId

    // A 只能解绑自己：解绑成功后 B 依然可用。
    const unbind = await env.request('POST', `${base}/session/unbind`, { body: {}, headers: { cookie: cookieA } })
    assert.equal(unbind.status, 200)
    assert.equal(unbind.json.ok, true)

    const afterA = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieA } })
    assert.equal(afterA.status, 401, '解绑后原令牌应失效')
    const sessionB = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieB } })
    assert.equal(sessionB.status, 200, '其他设备不应被牵连')
    assert.equal(sessionB.json.name, 'phone-b')

    // 试图借道解绑他人：路由无条件只撤销调用方自己（B），传入他人 deviceId 也无法伤及 C。
    const third = await env.request('POST', `${base}/pair`, form({ password: PASSWORD, name: 'phone-c' }))
    assert.equal(third.status, 303)
    const cookieC = third.setCookie.split(';')[0]
    const sessionC = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieC } })
    assert.equal(sessionC.status, 200)
    const deviceIdC = sessionC.json.deviceId

    const hijack = await env.request('POST', `${base}/session/unbind`, { body: { deviceId: deviceIdC }, headers: { cookie: cookieB } })
    assert.equal(hijack.status, 200)
    assert.equal(hijack.json.ok, true, '解绑自身始终成功')
    const stillB = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieB } })
    assert.equal(stillB.status, 401, '解绑只会作用于调用方自身')
    const afterC = await env.request('GET', `${base}/session.json`, { headers: { cookie: cookieC } })
    assert.equal(afterC.status, 200, '传入他人 deviceId 也不能撤销他人')
    assert.equal(afterC.json.name, 'phone-c')

    assert.ok(deviceIdA.startsWith('dev_'))
    pass('R5 session.json/unbind self-only')
  } finally {
    await env.close()
  }
}

console.log(`optimization-routes: ${passed} checks passed`)

