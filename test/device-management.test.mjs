/**
 * 设备管理端点测试：真实 http server 包裹 registerRoutes 的 handler，
 * 验证 loopback 边界、撤销/清理的真实失效，以及前端契约。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createPairing } from '../lib/pairing.js'
import { createEventHub } from '../lib/events.js'
import { registerRoutes } from '../lib/routes.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-devices-'))
const log = () => undefined
const config = {
  pairingTtlMs: 5 * 60_000,
  pairingMaxAttempts: 3,
  pairConfirmTtlMs: 120_000,
  maxDevices: 5,
  approvalTimeoutMs: 60_000,
  approvalTimeoutRemoteMs: 90_000,
  alwaysScope: 'session',
}

const store = createStore(tmpRoot)
const pairing = createPairing({ config, store, log })
const hub = createEventHub(log)

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
  hub,
  bridge: { pendingCount: () => 0, pending: () => [] },
  always: { list: () => [] },
  store,
  log,
  getPublicBase: async () => 'http://127.0.0.1:1',
  getLaunchUrl: () => undefined,
  getEdgeStatus: () => ({}),
  tunnel: {},
  hostLogin: undefined,
  clientHello: { count: 0 },
})

const server = http.createServer((req, res) => captured(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const request = async (method, pathname, options = {}) => {
  const headers = { ...(options.headers ?? {}) }
  const init = { method, headers }
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  }
  const response = await fetch(origin + pathname, init)
  let json
  try {
    json = await response.json()
  } catch {
    json = undefined
  }
  return { status: response.status, json }
}

let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

const phoneA = pairing.issueDevice('phone-A')
const phoneB = pairing.issueDevice('phone-B')

try {
  assert.ok(phoneA?.token && phoneB?.token)
  assert.equal(pairing.listDevices().length, 2)
  pass('setup two paired devices')

  const blockedList = await request('GET', '/plugins/dsh-mobile-bridge/devices.json', {
    headers: { 'x-dmb-forwarded-for': '1.2.3.4' },
  })
  assert.equal(blockedList.status, 403)
  assert.equal(blockedList.json?.error, 'loopback-only')
  pass('non-loopback GET /devices.json is 403')

  const listed = await request('GET', '/plugins/dsh-mobile-bridge/devices.json')
  assert.equal(listed.status, 200)
  assert.equal(listed.json?.devices?.length, 2)
  assert.equal(listed.json?.maxDevices, 5)
  for (const device of listed.json.devices) {
    assert.equal(Object.prototype.hasOwnProperty.call(device, 'tokenHash'), false)
    assert.ok(device.deviceId && device.name)
  }
  pass('loopback GET /devices.json returns devices without tokenHash')

  const blockedRevoke = await request('POST', '/plugins/dsh-mobile-bridge/devices/revoke', {
    headers: { 'x-dmb-forwarded-for': '1.2.3.4' },
    body: { deviceId: phoneA.deviceId },
  })
  assert.equal(blockedRevoke.status, 403)
  pass('non-loopback POST /devices/revoke is 403')

  const revoked = await request('POST', '/plugins/dsh-mobile-bridge/devices/revoke', {
    body: { deviceId: phoneA.deviceId },
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.json?.ok, true)
  assert.equal(pairing.authenticate(phoneA.token), undefined)
  const afterRevoke = await request('GET', '/plugins/dsh-mobile-bridge/devices.json')
  assert.equal(afterRevoke.json.devices.find((entry) => entry.deviceId === phoneA.deviceId)?.revoked, true)
  pass('loopback revoke invalidates token and marks record')

  const purged = await request('POST', '/plugins/dsh-mobile-bridge/devices/purge', { body: {} })
  assert.equal(purged.status, 200)
  assert.equal(purged.json?.purged, 1)
  const afterPurge = await request('GET', '/plugins/dsh-mobile-bridge/devices.json')
  assert.equal(afterPurge.json.devices.length, 1)
  assert.equal(afterPurge.json.devices[0].deviceId, phoneB.deviceId)
  pass('purge removes revoked records only')

  const revokedAll = await request('POST', '/plugins/dsh-mobile-bridge/devices/revoke-all', {
    body: new URLSearchParams({ reason: 'test' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(revokedAll.status, 200)
  assert.ok(revokedAll.json?.revoked >= 1)
  assert.equal(pairing.authenticate(phoneB.token), undefined)
  pass('revoke-all accepts form body and invalidates tokens')

  const finalPurge = await request('POST', '/plugins/dsh-mobile-bridge/devices/purge', { body: {} })
  assert.equal(finalPurge.json?.purged, 1)
  const empty = await request('GET', '/plugins/dsh-mobile-bridge/devices.json')
  assert.equal(empty.json.devices.length, 0)
  pass('final purge clears all revoked records')

  const clientText = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(clientText, /\/devices\.json/)
  assert.match(clientText, /\/devices\/revoke-all/)
  assert.match(clientText, /\/devices\/purge/)
  assert.match(clientText, /devicesTitle/)
  assert.match(clientText, /devicesLoadError/)
  pass('client.js wires device management endpoints')

  console.log(`\n${passed} checks passed`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
