/**
 * 任务结束态通知测试。
 * 用 stub notify 收集 dispatch 调用，覆盖七种终态、去重、子 agent 过滤、
 * 非 turn/end 过滤、缺参兜底、dispose 复位与长错误截断。
 */
import assert from 'node:assert/strict'

import { createTaskNotifier, describeTurnEnd, describeUserQuestion } from '../lib/task-notify.js'

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
const assistantMessage = (turn, step, text, interrupted = false) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...(interrupted ? { interrupted: true } : {}),
  },
})
const askCall = (callId, questions, turn = 2) => ({
  type: 'tool/call',
  data: {
    turn,
    step: 1,
    callId,
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions }),
  },
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  await run('T14 a session/title event caches the name used by later turn/end pushes', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-titled', undefined)
    notifier.handle(session, { type: 'session/title', data: { title: '重构缓存层', messageSeqs: [], source: { kind: 'user' } } })
    notifier.handle(session, turnEnd(2, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].body, '会话「重构缓存层」第 2 轮已完成')
    // 空标题不覆盖缓存，也不进入文案
    notifier.handle(session, { type: 'session/title', data: { title: '' } })
    notifier.handle(session, turnEnd(3, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(notify.calls[1].body, /重构缓存层/)
    notifier.dispose()
  })

  await run('T15 getTitle callback is the fallback when no title event arrived', async () => {
    const notify = makeNotify()
    let calls = 0
    const notifier = createTaskNotifier({
      notify,
      log,
      getTitle: (session) => {
        calls += 1
        return session?.id === 'sess-boot' ? '重启前的工作' : undefined
      },
    })
    notifier.handle(sessionOf('sess-boot', undefined), turnEnd(1, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls[0].body, '会话「重启前的工作」第 1 轮已完成')
    // 命中过一次的标题会缓存，后续 turn 不再依赖回调也能取到
    notifier.handle(sessionOf('sess-boot', undefined), turnEnd(2, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(notify.calls[1].body, /重启前的工作/)
    assert.equal(calls, 1, '回调只在缓存未命中时被调用')
    notifier.dispose()
  })

  await run('T16 a throwing getTitle never breaks the notify path', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({
      notify,
      log,
      getTitle: () => {
        throw new Error('service gone')
      },
    })
    notifier.handle(sessionOf('sess-hostile', undefined), turnEnd(1, { kind: 'completed' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].body, '会话 sess-hos 第 1 轮已完成')
    notifier.dispose()
  })

  await run('T17 describeTurnEnd prefers the name but keeps the short-id fallback', () => {
    const named = describeTurnEnd('session-abcdef12-3456', 7, { kind: 'completed' }, '重构缓存层')
    assert.equal(named.body, '会话「重构缓存层」第 7 轮已完成')
    const aborted = describeTurnEnd('session-abcdef12-3456', 7, { kind: 'aborted', reason: { kind: 'parent' } }, '重构缓存层')
    assert.equal(aborted.body, '会话「重构缓存层」第 7 轮被中止（父任务中止）')
    // 空串/非字符串名称一律退回短 id，与旧路径完全一致
    assert.equal(describeTurnEnd('abcdef123456', 7, { kind: 'completed' }, '').body, '会话 abcdef12 第 7 轮已完成')
    assert.equal(describeTurnEnd('abcdef123456', 7, { kind: 'completed' }, undefined).body, '会话 abcdef12 第 7 轮已完成')
    assert.equal(describeTurnEnd('abcdef123456', 7, { kind: 'completed' }, 42).body, '会话 abcdef12 第 7 轮已完成')
  })

  await run('T18 completed notification appends the final assistant result', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-final', undefined)
    notifier.handle(session, assistantMessage(2, 1, '中间步骤结果'))
    notifier.handle(session, assistantMessage(2, 2, '最终答案是 42'))
    notifier.handle(session, turnEnd(2, { kind: 'completed' }))
    await tick()
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].title, '任务完成')
    assert.match(notify.calls[0].body, /最终结果：最终答案是 42/)
    assert.doesNotMatch(notify.calls[0].body, /中间步骤结果/)
    notifier.dispose()
  })

  await run('T19 interrupted assistant message never becomes the final result', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-interrupt', undefined)
    notifier.handle(session, assistantMessage(1, 1, '完整回复'))
    notifier.handle(session, assistantMessage(1, 2, '被截断的前缀', true))
    notifier.handle(session, turnEnd(1, { kind: 'completed' }))
    await tick()
    assert.match(notify.calls[0].body, /最终结果：完整回复/)
    assert.doesNotMatch(notify.calls[0].body, /被截断的前缀/)

    const onlyInterrupted = makeNotify()
    const notifier2 = createTaskNotifier({ notify: onlyInterrupted, log })
    const session2 = sessionOf('sess-only-int', undefined)
    notifier2.handle(session2, assistantMessage(1, 1, '仅有中断前缀', true))
    notifier2.handle(session2, turnEnd(1, { kind: 'completed' }))
    await tick()
    assert.equal(onlyInterrupted.calls[0].body, '会话 sess-onl 第 1 轮已完成')
    assert.doesNotMatch(onlyInterrupted.calls[0].body, /最终结果/)
    notifier.dispose()
    notifier2.dispose()
  })

  await run('T20 ask_user_question tool/call notifies the question and every option', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const questions = [
      {
        id: 'q1',
        header: '确认',
        question: '是否继续执行？',
        options: [
          { label: '是', description: '继续下一步' },
          { label: '否' },
        ],
      },
      {
        id: 'q2',
        question: '选择模式',
        options: [{ label: '快速' }, { label: '稳妥' }],
      },
    ]
    notifier.handle(sessionOf('sess-ask01', undefined), askCall('call-ask-1', questions, 4))
    await tick()
    assert.equal(notify.calls.length, 1)
    assert.equal(notify.calls[0].title, '需要你的选择')
    assert.equal(notify.calls[0].path, '/')
    assert.match(notify.calls[0].body, /会话 sess-ask 第 4 轮等待你的回答/)
    assert.match(notify.calls[0].body, /1\. \[确认\] 是否继续执行？/)
    assert.match(notify.calls[0].body, /1\. 是 — 继续下一步/)
    assert.match(notify.calls[0].body, /1\. 快速/)
    assert.match(notify.calls[0].body, /2\. 选择模式/)
    notifier.dispose()
  })

  await run('T21 ask notifications dedupe by callId and ignore other/malformed calls', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-dedupe-ask', undefined)
    const questions = [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }] }]
    notifier.handle(session, askCall('call-dup', questions))
    notifier.handle(session, askCall('call-dup', questions))
    notifier.handle(session, {
      type: 'tool/call',
      data: { callId: 'call-bash', name: 'bash', arguments: '{}' },
    })
    notifier.handle(session, {
      type: 'tool/call',
      data: { callId: 'call-bad', name: 'ask_user_question', arguments: '{not json' },
    })
    notifier.handle(sessionOf('sess-subask', 'subagent'), askCall('call-sub', questions))
    await tick()
    assert.equal(notify.calls.length, 1)
    assert.match(notify.calls[0].body, /继续吗？/)
    notifier.dispose()
  })

  await run('T22 long final results and question bodies are truncated', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-longfinal', undefined)
    notifier.handle(session, assistantMessage(1, 1, 'x'.repeat(900)))
    notifier.handle(session, turnEnd(1, { kind: 'completed' }))
    await tick()
    assert.ok(notify.calls[0].body.includes('最终结果：'))
    assert.ok(notify.calls[0].body.length < 600, `body too long: ${notify.calls[0].body.length}`)
    assert.ok(notify.calls[0].body.endsWith('…'))

    const askNotify = makeNotify()
    const notifier2 = createTaskNotifier({ notify: askNotify, log })
    const questions = Array.from({ length: 12 }, (_, index) => ({
      id: `q${index}`,
      question: `问题 ${index}？${'y'.repeat(80)}`,
      options: [{ label: `选项 ${index}`, description: 'z'.repeat(200) }],
    }))
    notifier2.handle(sessionOf('sess-longask', undefined), askCall('call-long', questions))
    await tick()
    assert.ok(askNotify.calls[0].body.length <= 901, `ask body too long: ${askNotify.calls[0].body.length}`)
    assert.ok(askNotify.calls[0].body.endsWith('…'))
    notifier.dispose()
    notifier2.dispose()
  })

  await run('T23 describeUserQuestion is a pure mapper with a safe fallback', () => {
    const fromObject = describeUserQuestion(
      'abcdef123456',
      { questions: [{ question: '选哪个？', options: [{ label: 'A' }] }] },
      '重构方案',
    )
    assert.equal(fromObject.title, '需要你的选择')
    assert.equal(fromObject.body, '会话「重构方案」等待你的回答：\n1. 选哪个？\n  选项：\n  1. A')
    assert.equal(describeUserQuestion('abcdef123456', 'broken'), undefined)
    assert.equal(describeUserQuestion('abcdef123456', { questions: [] }), undefined)
  })

  await run('T24 intermediate tool-call assistant messages never become the final result', async () => {
    const notify = makeNotify()
    const notifier = createTaskNotifier({ notify, log })
    const session = sessionOf('sess-toolcall', undefined)
    notifier.handle(session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先查一下' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    })
    notifier.handle(session, assistantMessage(1, 2, '真正的最终答案'))
    notifier.handle(session, turnEnd(1, { kind: 'completed' }))
    await tick()
    assert.match(notify.calls[0].body, /最终结果：真正的最终答案/)
    assert.doesNotMatch(notify.calls[0].body, /我先查一下/)
    notifier.dispose()
  })

  console.log(`\n${passed} checks passed`)
} catch (error) {
  console.error('FAIL', error?.message ?? error, error?.stack ?? '')
  process.exitCode = 1
}
