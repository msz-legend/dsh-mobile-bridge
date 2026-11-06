/**
 * 任务结束态通知测试。
 * 用 stub notify 收集 dispatch 调用，覆盖七种终态、去重、子 agent 过滤、
 * 非 turn/end 过滤、缺参兜底、dispose 复位与长错误截断。
 */
import assert from 'node:assert/strict'

import { createTaskNotifier, describeTurnEnd } from '../lib/task-notify.js'

const log = () => undefined
let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

const makeNotify = () => {
  const calls = []
  return {
    calls,
    dispatch: async (payload) => {
      calls.push(payload)
      return { sent: 1, results: ['ok'] }
    },
  }
}

const sessionOf = (id, origin) => ({ id, header: origin === undefined ? {} : { origin } })
const turnEnd = (turn, reason) => ({ type: 'turn/end', seq: 1, time: 1, data: { turn, reason } })

const run = async (name, body) => {
  await body()
  pass(name)
}

try {
  await run('T1 completed maps to 任务完成 and dispatches once', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(sessionOf('sess-a1b2c3d4e5', undefined), turnEnd(3, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].title, '任务完成')
    assert.match(notify.calls[0].body, /sess-a1b/)
    assert.match(notify.calls[0].body, /第 3 轮/)
    assert.equal(notify.calls[0].path, '/')
    notifier.dispose()
  })

  await run('T2 error includes the failure message', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(
      sessionOf('sess-err001', undefined),
      turnEnd(1, { kind: 'error', error: { message: 'provider exploded', code: 'E500' } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].title, '任务出错')
    assert.match(notify.calls[0].body, /provider exploded/)
    notifier.dispose()
  })

  await run('T3 every non-completed reason maps to its own title', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const cases = [
      [{ kind: 'aborted', reason: { kind: 'user' } }, '任务已中止', /用户中止/],
      [{ kind: 'blocked' }, '任务被阻断', null],
      [{ kind: 'max-tokens' }, '任务达到上限', null],
      [{ kind: 'interrupted' }, '任务被中断', null],
      [{ kind: 'forked' }, '任务已分叉', null],
      [{ kind: 'mystery' }, '任务结束', /mystery/],
    ]
    for (const [index, [reason, title, bodyPattern]] of cases.entries()) {
      notifier.handle(sessionOf('sess-reasons', undefined), turnEnd(index + 1, reason))
      await new Promise((resolve) => setTimeout(resolve, 0))
      const call = notify.calls[notify.calls.length - 1]
      assert.equal(call.title, title)
      if (bodyPattern) assert.match(call.body, bodyPattern)
    }
    assert.equal(notify.calls.length, cases.length)
    notifier.dispose()
  })

  await run('T4 same session+turn is deduped, next turn dispatches again', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-dedup', undefined)
    notifier.handle(session, turnEnd(4, { kind: 'completed' }))
    notifier.handle(session, turnEnd(4, { kind: 'completed' }))
    notifier.handle(session, turnEnd(4, { kind: 'error', error: { message: 'x' } }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1, 'duplicate turn must not re-notify')
    notifier.handle(session, turnEnd(5, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 2)
    notifier.dispose()
  })

  await run('T5 subagent sessions are skipped', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(sessionOf('sess-sub', 'subagent'), turnEnd(1, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 0)
    notifier.dispose()
  })

  await run('T6 non turn/end events are ignored', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(sessionOf('sess-noise', undefined), { type: 'user/message', data: {} })
    notifier.handle(sessionOf('sess-noise', undefined), { type: 'assistant/message', data: {} })
    notifier.handle(sessionOf('sess-noise', undefined), { type: 'tool/call', data: {} })
    notifier.handle(sessionOf('sess-noise', undefined), undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 0)
    notifier.dispose()
  })

  await run('T7 missing notify / session id / turn never crash', async () => {
    const notifier = createTaskNotifier({ log })
    notifier.handle(sessionOf('sess-x', undefined), turnEnd(1, { kind: 'completed' }))
    notifier.handle({ header: {} }, turnEnd(1, { kind: 'completed' }))
    notifier.handle(sessionOf('sess-y', undefined), { type: 'turn/end', data: {} })
    notifier.handle(sessionOf('sess-y', undefined), { type: 'turn/end', data: { turn: Number.NaN } })
    notifier.handle(null, null)
    assert.ok(true, 'no throw')
    notifier.dispose()
  })

  await run('T8 dispose() resets dedup so the same turn can notify again', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-dispose', undefined)
    notifier.handle(session, turnEnd(6, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1)
    notifier.dispose()
    notifier.handle(session, turnEnd(6, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 2)
  })

  await run('T9 long error messages are truncated', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(
      sessionOf('sess-long', undefined),
      turnEnd(1, { kind: 'error', error: { message: 'x'.repeat(500) } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls[0].title, '任务出错')
    assert.ok(notify.calls[0].body.length < 300, `body too long: ${notify.calls[0].body.length}`)
    notifier.dispose()
  })

  await run('T10 a throwing dispatch does not break the event loop', async () => {
    const notify = {
      dispatch: () => {
        throw new Error('sync boom')
      },
    }
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(sessionOf('sess-throw', undefined), turnEnd(1, { kind: 'completed' }))
    assert.ok(true, 'sync throw contained')
    notifier.dispose()
  })

  await run('T11 a rejected dispatch is caught, not unhandled', async () => {
    const notify = {
      dispatch: async () => {
        throw new Error('async boom')
      },
    }
    const notifier = createTaskNotifier({ notify, log })
    notifier.handle(sessionOf('sess-reject', undefined), turnEnd(1, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(true, 'rejection contained')
    notifier.dispose()
  })

  await run('T12 describeTurnEnd() is a pure mapping helper', () => {
    const completed = describeTurnEnd('abcdef123456', 7, { kind: 'completed' })
    assert.equal(completed.title, '任务完成')
    assert.equal(completed.body, '会话 abcdef12 第 7 轮已完成')
    const aborted = describeTurnEnd('abcdef123456', 7, { kind: 'aborted', reason: { kind: 'parent' } })
    assert.equal(aborted.body, '会话 abcdef12 第 7 轮被中止（父任务中止）')
    const fallback = describeTurnEnd('', 1, undefined)
    assert.equal(fallback.title, '任务完成')
    assert.match(fallback.body, /\? 第 1 轮/)
  })

  await run('T13 the session- prefix is stripped so the short id is meaningful', () => {
    const body = describeTurnEnd('session-90757a76-4e62-4ba3', 19, { kind: 'completed' }).body
    assert.equal(body, '会话 90757a76 第 19 轮已完成')
    const legacy = describeTurnEnd('sess-a1b2c3d4e5', 3, { kind: 'completed' }).body
    assert.equal(legacy, '会话 sess-a1b 第 3 轮已完成')
  })

  console.log(`\n${passed} checks passed`)
} catch (error) {
  console.error('FAIL', error?.message ?? error, error?.stack ?? '')
  process.exitCode = 1
}
