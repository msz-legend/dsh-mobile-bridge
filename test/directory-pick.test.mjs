/**
 * 手机创建工作区：桌面目录选择路由 + 客户端目录流契约回归。
 *
 * 覆盖：
 *  - `/directory/pick` 只接受已配对设备；
 *  - 选中路径 / 取消 / 失败三类响应；
 *  - 同一时刻只允许一个系统对话框（连点保护）；
 *  - client.js 真的把目录流 occupant 注册进三个槽位，并修掉标题截断。
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
import { registerRoutes } from '../lib/routes.js'

const log = () => undefined
const ROOT = path.resolve(import.meta.dirname, '..')

const makeEnv = ({ pickDirectory } = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-dirpick-'))
  const config = {
    maxDevices: 5,
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
  const binding = createBindingManager({ dir: tmpRoot, log, randomPassword: () => 'pw' })
  binding.ensure()
  const hub = createEventHub(log)
  let captured
  registerRoutes({
    webServer: {
      register: ({ handler }) => {
        captured = handler
        return () => undefined
      },
    },
  }, {
    config,
    pairing,
    binding,
    hub,
    bridge: { pendingCount: () => 0, pending: () => [], replayRequests: () => undefined, decide: () => ({ ok: false }) },
    always: { list: () => [], revoke: () => true, clear: () => undefined },
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
    notify: { getChannels: () => ({}), setChannel: () => ({ ok: true }), dispatch: () => ({ sent: 0 }) },
    pickDirectory,
  })

  const server = http.createServer((req, res) => captured(req, res))
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = () => `http://127.0.0.1:${server.address().port}`
  const device = pairing.issueDevice('test-phone')
  const request = async (method, pathname, options = {}) => {
    await ready
    const headers = { ...(options.headers ?? {}) }
    const init = { method, headers, redirect: 'manual' }
    if (headers.cookie === undefined && options.auth !== false) headers.cookie = `dmb=${device.token}`
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    if (init.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    const response = await fetch(origin() + pathname, init)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    return { status: response.status, json: data, text }
  }
  return {
    request,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// D1 未配对访客不能弹桌面对话框
{
  const env = makeEnv({ pickDirectory: async () => 'C:/should-not-happen' })
  const response = await env.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { auth: false, body: {} })
  assert.equal(response.status, 401, 'D1 未配对应 401')
  assert.equal(response.json.ok, false)
  await env.close()
  console.log('D1 directory/pick requires paired device: PASS')
}

// D2 选中路径 → 原样回给客户端目录流
{
  let seenSignal = false
  const env = makeEnv({
    pickDirectory: async (signal) => {
      seenSignal = signal instanceof AbortSignal
      return 'D:\\work\\my-project'
    },
  })
  const response = await env.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { body: {} })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { ok: true, path: 'D:\\work\\my-project' })
  assert.equal(seenSignal, true, 'D2 应把 AbortSignal 传给宿主 picker')
  await env.close()
  console.log('D2 directory/pick returns chosen path: PASS')
}

// D3 用户取消 → cancelled:true；D4 宿主失败 → 透传错误码
{
  const cancelled = makeEnv({ pickDirectory: async () => null })
  const c = await cancelled.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { body: {} })
  assert.deepEqual(c.json, { ok: true, path: null, cancelled: true })
  await cancelled.close()

  const failing = makeEnv({
    pickDirectory: async () => {
      const error = new Error('no native chooser')
      error.code = 'directory-picker/unavailable'
      throw error
    },
  })
  const f = await failing.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { body: {} })
  assert.equal(f.json.ok, false)
  assert.equal(f.json.error, 'directory-picker/unavailable')
  assert.match(f.json.message, /no native chooser/)
  await failing.close()
  console.log('D3/D4 cancel and error propagation: PASS')
}

// D5 连点保护：第一个 dialog 未结束时第二个请求 409
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = makeEnv({ pickDirectory: async () => { await gate; return 'C:/one' } })
  const first = env.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { body: {} })
  await sleep(30)
  const second = await env.request('POST', '/plugins/dsh-mobile-bridge/directory/pick', { body: {} })
  assert.equal(second.status, 409, 'D5 第二个选择请求应 409')
  assert.equal(second.json.error, 'directory-picker-busy')
  release()
  const firstResult = await first
  assert.equal(firstResult.json.path, 'C:/one')
  await env.close()
  console.log('D5 concurrent picker guarded with 409: PASS')
}

// D6 静态契约：客户端真的注册了目录流，并把标题产品名换成固定图标
{
  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  assert.match(client, /function MobileDirectoryFlow\(props\)/, 'D6 目录流 occupant 必须存在')
  assert.match(client, /conversation\.hero\.workspace\.directoryFlow/)
  assert.match(client, /sidebar\.workspaces\.directoryFlow/)
  assert.match(client, /workspace\.picker\.directoryFlow/)
  assert.match(client, /fetch\(BASE \+ '\/directory\/pick'/, 'D6 目录流必须打自己的同源路由')
  assert.match(client, /installDirectoryFlow\(slots\)/, 'D6 apply 必须安装目录流')
  assert.match(client, /function installTitleFix\(\)/, 'D6 标题修复必须存在')
  assert.match(client, /— ⬤/, 'D6 固定图标后缀必须存在')
  assert.match(index, /pickDirectory: async \(signal\)/, 'D6 Host 必须提供目录选择回调')
  assert.match(index, /capability\.pick\(signal\)/, 'D6 Host 必须调原生 capability.pick')
  console.log('D6 client/index static contracts: PASS')
}

console.log('directory-pick: all checks passed')
