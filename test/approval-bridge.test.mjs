// 审批桥接模块的行为测试（不依赖宿主进程，直接驱动模块）。
// 覆盖：once / reject / always(参数 pattern) / 超时 fail closed / 无设备时远程 vs 本地分流。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createAlways } from '../lib/always.js'
import { createApprovalBridge } from '../lib/approval-bridge.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-test-'))
const store = createStore(tmp)
const logs = []
const log = (...parts) => logs.push(parts.join(' '))

function makeHarness(options = {}) {
  const config = {
    approvalTimeoutMs: options.timeoutMs ?? 5000,
    approvalTimeoutRemoteMs: options.timeoutMs ?? 5000,
    alwaysScope: options.scope ?? 'session',
  }
  const events = []
  let online = options.online ?? true
  let offlineHook = () => {}
  const hub = {
    broadcast: (payload) => events.push(payload),
    hasOnlineDevice: () => online,
    onlineDeviceIds: () => new Set(online ? ['dev_test'] : []),
    onOffline: (hook) => {
      offlineHook = hook
    },
  }
  const always = createAlways({ store, config, log })
  const origins = { originOf: (id) => (options.remote?.includes(String(id)) ? 'remote' : 'local') }
  const args = { take: () => options.observed }
  const bridge = createApprovalBridge({ config, hub, always, args, origins, log, now: Date.now })
  return {
    bridge,
    events,
    always,
    setOnline: (value) => {
      online = value
    },
    goOffline: () => {
      online = false
      offlineHook()
    },
  }
}

const approvalOf = (events) => events.filter((event) => event.type === 'approval').at(-1)?.request

const req = (overrides = {}) => ({
  agent: { id: 'session-x' },
  toolName: 'bash',
  callId: 'call-1',
  ...overrides,
})

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log('PASS', name)
}

// 1) once → allowed-once
await test('once → allowed-once', async () => {
  const h = makeHarness({ observed: { args: { command: 'git status' }, tool: 'bash' } })
  const pending = h.bridge.handler(req(), async () => 'next-value')
  const request = approvalOf(h.events)
  assert.ok(request?.requestId, 'approval pushed to device')
  assert.equal(request.pattern.label, 'bash · git status *', 'pattern preview derived from args')
  const result = h.bridge.decide({ requestId: request.requestId, decision: 'once', deviceId: 'dev_test' })
  assert.equal(result.outcome, 'allowed-once')
  assert.equal(await pending, 'allowed-once')
})

// 2) reject → rejected
await test('reject → rejected', async () => {
  const h = makeHarness()
  const pending = h.bridge.handler(req(), async () => 'next-value')
  const request = approvalOf(h.events)
  h.bridge.decide({ requestId: request.requestId, decision: 'reject' })
  assert.equal(await pending, 'rejected')
})

// 3) always → 对宿主 allowed-once，且规则被记住、第二次不再打扰
await test('always → allowed-once + remembered rule short-circuits', async () => {
  const h = makeHarness({ scope: 'session', observed: { args: { command: 'git status' }, tool: 'bash' } })
  const first = h.bridge.handler(req(), async () => 'next-value')
  const request = approvalOf(h.events)
  const result = h.bridge.decide({ requestId: request.requestId, decision: 'always' })
  assert.equal(result.outcome, 'allowed-once', '宿主词表只有 allowed-once')
  assert.equal(await first, 'allowed-once')
  assert.equal(h.always.list().length, 1, '规则已保存')
  const before = h.events.length
  const second = await h.bridge.handler(req({ callId: 'call-2' }), async () => 'next-value')
  assert.equal(second, 'allowed-once', '命中规则直接放行')
  assert.equal(h.events.length, before, '命中规则时不再向任何端推送卡片')
})

// 4) 超时 → unavailable（fail closed）且不返回 rejected
await test('timeout → unavailable (fail closed)', async () => {
  const h = makeHarness({ timeoutMs: 40 })
  const outcome = await h.bridge.handler(req(), async () => 'next-value')
  assert.equal(outcome, 'unavailable')
})

// 5) 无设备 + 远程会话 → unavailable，绝不 next() 静默放行
await test('no device + remote session → unavailable (no delegation)', async () => {
  let nextCalled = false
  const h = makeHarness({ online: false, remote: ['session-remote'] })
  const outcome = await h.bridge.handler(req({ agent: { id: 'session-remote' } }), async () => {
    nextCalled = true
    return 'allowed-once'
  })
  assert.equal(outcome, 'unavailable')
  assert.equal(nextCalled, false, '远程会话不得交还桌面放行')
})

// 6) 无设备 + 本地会话 → 交还桌面（next()）
await test('no device + local session → delegates to desktop', async () => {
  let nextCalled = false
  const h = makeHarness({ online: false })
  const outcome = await h.bridge.handler(req(), async () => {
    nextCalled = true
    return 'allowed-once'
  })
  assert.equal(nextCalled, true)
  assert.equal(outcome, 'allowed-once')
})

// 7) 等待期间设备掉线：远程 → fail closed；本地 → 交还桌面
await test('device drops mid-wait: remote fails closed, local delegates', async () => {
  const remote = makeHarness({ remote: ['session-remote'] })
  const remotePending = remote.bridge.handler(req({ agent: { id: 'session-remote' } }), async () => 'allowed-once')
  remote.goOffline()
  assert.equal(await remotePending, 'unavailable')

  const local = makeHarness()
  const localPending = local.bridge.handler(req(), async () => 'allowed-once')
  local.goOffline()
  assert.equal(await localPending, 'allowed-once')
})

// 8) 未知 requestId / 重复决策
await test('unknown or duplicate decision is rejected safely', async () => {
  const h = makeHarness()
  assert.equal(h.bridge.decide({ requestId: 'nope', decision: 'once' }).ok, false)
  const pending = h.bridge.handler(req(), async () => 'next-value')
  const request = approvalOf(h.events)
  assert.equal(h.bridge.decide({ requestId: request.requestId, decision: 'once' }).ok, true)
  await pending
  assert.equal(h.bridge.decide({ requestId: request.requestId, decision: 'reject' }).ok, false)
})

// 9) 参数不可得时退化为「仅工具名」规则，并如实标注
await test('unrecognized args degrade to tool-only rule', async () => {
  const h = makeHarness({ observed: { args: { foo: 'bar' }, tool: 'mystery' } })
  const pending = h.bridge.handler(req({ toolName: 'mystery', callId: 'call-9' }), async () => 'next-value')
  const request = approvalOf(h.events)
  assert.equal(request.pattern.key, 'tool:mystery')
  h.bridge.decide({ requestId: request.requestId, decision: 'always' })
  await pending
  const rules = h.always.list()
  assert.equal(rules.at(-1).label.includes('仅工具名'), true)
})

console.log(`\n${passed} checks passed`)
fs.rmSync(tmp, { recursive: true, force: true })
