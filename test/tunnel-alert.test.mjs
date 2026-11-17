/**
 * #10 隧道持续失败推送告警 —— createTunnelAlert 行为测试。
 *
 * 覆盖：running true→false 立即告警；未运行但 lastError 变化告警；
 * 同签名 10 分钟节流；不同签名不受节流影响；notify 缺席不炸；
 * stop 后不再告警；alertsSent 计数。
 */
import assert from 'node:assert/strict'
import { createTunnelAlert } from '../lib/tunnel-alert.js'

let clock = 1_000_000
const now = () => clock

function makeHarness() {
  const dispatches = []
  const notify = {
    dispatch: ({ title, body }) => {
      dispatches.push({ title, body })
      return Promise.resolve({ sent: 1, results: ['ok'] })
    },
  }
  let status = { enabled: true, running: true, lastError: '' }
  const alert = createTunnelAlert({
    tunnel: { status: () => status },
    notify,
    log: () => undefined,
    pollMs: 30_000,
    throttleMs: 10 * 60_000,
    now,
  })
  return {
    alert,
    dispatches,
    setStatus(next) {
      status = { ...status, ...next }
    },
  }
}

// A1：running true→false —— 立即告警一次。
{
  const { alert, dispatches, setStatus } = makeHarness()
  alert.check()
  assert.equal(dispatches.length, 0, '初始运行态不应告警')
  setStatus({ running: false, lastError: 'exited unexpectedly (code=1); tail: ...' })
  alert.check()
  assert.equal(dispatches.length, 1, '掉线应立即告警')
  assert.match(dispatches[0].title, /隧道已断开|disconnected/)
  assert.match(dispatches[0].body, /exited unexpectedly/)

  // A2：同签名节流 —— 10 分钟内不再重复。
  clock += 5 * 60_000
  alert.check()
  assert.equal(dispatches.length, 1, '同签名 10 分钟内应节流')

  // A3：超过节流窗口后同签名可再发。
  clock += 11 * 60_000
  alert.check()
  assert.equal(dispatches.length, 2, '超过节流窗口后同签名应再发')
  assert.equal(alert.alertsSent, 2)
}

// A4：从运行态掉线走「已断开」；持续未运行期间新错误签名立即告警（不受上一条节流影响）。
{
  const { alert, dispatches, setStatus } = makeHarness()
  alert.check()
  setStatus({ running: false, lastError: 'health check failed (3/3): http://x' })
  alert.check()
  assert.equal(dispatches.length, 1)
  assert.match(dispatches[0].title, /已断开|disconnected/, '运行态掉线应报「已断开」')
  // 掉线后进程未恢复，健康检查又攒出新错误：签名变化 → 立即再告警。
  setStatus({ running: false, lastError: 'health check failed (3/3): http://y' })
  alert.check()
  assert.equal(dispatches.length, 2, '新错误签名应立即告警')
  assert.match(dispatches[1].title, /持续失败|keeps failing/)

  // A5：错误未变化 → 节流窗口内不重复告警。
  alert.check()
  assert.equal(dispatches.length, 2, '错误未变化不应重复告警')
}

// A6：恢复运行后不再告警，再次掉线才告警。
{
  const { alert, dispatches, setStatus } = makeHarness()
  alert.check()
  setStatus({ running: false, lastError: 'boom' })
  alert.check()
  assert.equal(dispatches.length, 1)
  setStatus({ running: true, lastError: '' })
  alert.check()
  assert.equal(dispatches.length, 1, '恢复运行不应告警')
  setStatus({ running: false, lastError: 'boom again' })
  alert.check()
  assert.equal(dispatches.length, 2, '再次掉线应再告警')
}

// A7：notify 缺席 / status 缺席不炸。
{
  const bare = createTunnelAlert({ tunnel: { status: () => ({ running: false, lastError: 'x' }) }, log: () => undefined, now })
  bare.check() // 无 notify —— 静默
  assert.equal(bare.alertsSent, 0)
  const noStatus = createTunnelAlert({ notify: { dispatch: () => undefined }, tunnel: { status: () => undefined }, log: () => undefined, now })
  noStatus.check() // status undefined —— 静默
  const throwing = createTunnelAlert({
    tunnel: { status: () => { throw new Error('socket gone') } },
    notify: { dispatch: () => undefined },
    log: () => undefined,
    now,
  })
  throwing.check() // status 抛错 —— 记日志不炸
}

// A8：stop 后 check 不再告警。
{
  const { alert, dispatches, setStatus } = makeHarness()
  alert.check()
  alert.stop()
  setStatus({ running: false, lastError: 'after stop' })
  alert.check()
  assert.equal(dispatches.length, 0, 'stop 后不应告警')
}

// A9：start/stop 幂等（timer 不重复）。
{
  const alert = createTunnelAlert({ tunnel: { status: () => ({ running: true, lastError: '' }) }, notify: { dispatch: () => undefined }, log: () => undefined, now })
  alert.start()
  alert.start()
  alert.stop()
  alert.stop()
}

console.log('tunnel-alert: 9 checks passed')
