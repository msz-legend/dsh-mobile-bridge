/**
 * 配对确认状态机测试（不依赖宿主进程）：
 *   stage → 桌面 allow/deny → 手机 poll 领取 token，含过期、重复、上限路径。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createPairing } from '../lib/pairing.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-confirm-'))
const logs = []
const log = (...parts) => logs.push(parts.join(' '))

const makePairing = (overrides = {}) => {
  // 每用例独立 store：设备表是落盘状态，共享会跨用例泄漏
  const store = createStore(fs.mkdtempSync(path.join(tmpRoot, 'case-')))
  let clock = overrides.startAt ?? 1_000_000
  const pairing = createPairing({
    config: {
      pairingTtlMs: 5 * 60_000,
      pairingMaxAttempts: 3,
      pairConfirmTtlMs: overrides.confirmTtlMs ?? 120_000,
      maxDevices: overrides.maxDevices ?? 5,
    },
    store,
    log,
    now: () => clock,
  })
  return {
    pairing,
    advance: (ms) => {
      clock += ms
    },
  }
}

let passed = 0
const test = (name, fn) => {
  fn()
  passed += 1
  console.log('PASS', name)
}

test('stage → allow → poll delivers token exactly once', () => {
  const { pairing } = makePairing()
  pairing.issueCode()
  assert.equal(pairing.verifyCode(pairing.current().code).ok, true, '前置：码已验证')

  const staged = pairing.stageConfirm('我的手机', '192.168.1.5')
  assert.ok(staged?.confirmId, 'stage 返回 confirmId')
  assert.equal(pairing.stageConfirm('另一台'), undefined, '同一时刻只允许一个待确认请求')

  assert.equal(pairing.resolveConfirm('cfm_wrong', true).ok, false, '未知 confirmId 拒绝')
  assert.equal(pairing.resolveConfirm(staged.confirmId, true).ok, true, '桌面允许')

  const view = pairing.pendingConfirm()
  assert.equal(view?.resolved, 'allowed', '桌面状态可查')

  const first = pairing.pollConfirm(staged.confirmId)
  assert.equal(first.ok, true, '轮询领取 token')
  assert.ok(first.token?.length > 20, 'token 已交付')
  assert.equal(pairing.pollConfirm(staged.confirmId).state, 'unknown', '领取后记录即清，不可二次领取')
  assert.equal(pairing.authenticate(first.token)?.deviceId, first.deviceId, 'token 可通过设备闸门')
  assert.equal(pairing.pendingConfirm(), undefined, '完成后无残留')
})

test('deny path → poll reports denied', () => {
  const { pairing } = makePairing()
  pairing.issueCode()
  pairing.verifyCode(pairing.current().code)
  const staged = pairing.stageConfirm('phone')
  assert.equal(pairing.resolveConfirm(staged.confirmId, false).ok, true)
  assert.equal(pairing.pollConfirm(staged.confirmId).state, 'denied')
  assert.equal(pairing.pollConfirm(staged.confirmId).state, 'unknown', '终态后即清')
  assert.equal(pairing.listDevices().length, 0, '拒绝后未发设备')
})

test('confirm expiry frees the slot and poll reports expired', () => {
  const { pairing, advance } = makePairing({ confirmTtlMs: 1000 })
  pairing.issueCode()
  pairing.verifyCode(pairing.current().code)
  const staged = pairing.stageConfirm('phone')
  advance(1500)
  assert.equal(pairing.pollConfirm(staged.confirmId).state, 'expired')
  const restaged = pairing.stageConfirm('phone-2')
  assert.ok(restaged?.confirmId, '过期后可以再次发起')
})

test('allow beyond device limit → poll reports limit', () => {
  const { pairing } = makePairing({ maxDevices: 1 })
  pairing.issueCode()
  pairing.verifyCode(pairing.current().code)
  const first = pairing.stageConfirm('first')
  assert.equal(pairing.resolveConfirm(first.confirmId, true).ok, true)
  assert.equal(pairing.pollConfirm(first.confirmId).ok, true)

  pairing.issueCode()
  pairing.verifyCode(pairing.current().code)
  const second = pairing.stageConfirm('second')
  assert.equal(pairing.resolveConfirm(second.confirmId, true).ok, false, '桌面允许但超限')
  assert.equal(pairing.pollConfirm(second.confirmId).state, 'limit')
})

console.log(`\n${passed} checks passed`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
