/**
 * push.js 外部通道调度测试。
 *
 * 通知统一走外部通道（ntfy/Bark/Server酱/飞书/钉钉/企业微信/Telegram/通用 webhook），
 * 本文件校验：通道预设完整性、参数校验、调度器的订阅/去重/派发/并发。
 */
import assert from 'node:assert/strict'

import { CHANNELS, sendChannelNotification, createNotifyDispatcher } from '../lib/push.js'

const run = async () => {
  // 1. 预设清单：所有宣传支持的通道都在。
  {
    const names = Object.keys(CHANNELS)
    for (const name of ['ntfy', 'bark', 'wecomapp', 'feishu', 'dingtalk', 'wecom', 'wecomaibot', 'telegram', 'webhook']) {
      assert.ok(names.includes(name), `missing channel preset: ${name}`)
    }
    // 每个通道都带配置步骤（用户要照着配）；build 可为 null（wecomapp 走官方 API、wecomaibot 走 WebSocket 特殊分支）。
    for (const [name, preset] of Object.entries(CHANNELS)) {
      assert.ok(Array.isArray(preset.steps) && preset.steps.length > 0, `${name} must carry setup steps`)
      assert.ok(Array.isArray(preset.fields) && preset.fields.length > 0, `${name} must declare fields`)
      if (name !== 'wecomapp' && name !== 'wecomaibot') assert.equal(typeof preset.build, 'function', `${name} must have build()`)
    }
    console.log('ok  channel presets complete with setup steps')
  }

  // 1.5 企业微信自建应用：参数校验 + 官方 API 流程（gettoken → message/send，fetch mock）。
  {
    const missing = await sendChannelNotification('wecomapp', { corpId: '', agentId: '', secret: '' }, { title: 't', body: 'b', url: 'u' })
    assert.equal(missing.error, 'not-configured')

    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-push-'))
    const dispatcher = createNotifyDispatcher({ storeDir: dir, log: () => {}, publicBase: 'https://example.test' })
    dispatcher.setChannel('wecomapp', { corpId: 'ww1', agentId: '1000002', secret: 's3cret', toUser: '@all' }, true)
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body })
      if (String(url).includes('/gettoken')) {
        return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: 'T0KEN', expires_in: 7200 }) }
      }
      return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) }
    }
    try {
      const result = await dispatcher.dispatch({ title: '工具审批', body: 'bash', path: '/' })
      assert.equal(result.sent, 1, 'wecomapp dispatch ok')
      assert.equal(calls.length, 2, 'two official API calls: gettoken + message/send')
      assert.ok(calls[0].url.includes('corpid=ww1'), 'gettoken carries corpId')
      assert.ok(calls[0].url.includes('corpsecret=s3cret'), 'gettoken carries secret')
      assert.ok(calls[1].url.includes('access_token=T0KEN'), 'send uses fetched token')
      const sentBody = JSON.parse(calls[1].body)
      assert.equal(sentBody.agentid, 1000002)
      assert.equal(sentBody.touser, '@all')
      assert.ok(sentBody.text.content.includes('工具审批'), 'message body includes title')

      // 第二次 dispatch 走 token 缓存：只有 message/send 一跳。
      calls.length = 0
      await dispatcher.dispatch({ title: 'T', body: 'B', path: '/' })
      assert.equal(calls.length, 1, 'second dispatch uses cached access_token')
      assert.ok(calls[0].url.includes('message/send'))
    } finally {
      globalThis.fetch = original
    }
    fs.rmSync(dir, { recursive: true, force: true })
    console.log('ok  wecomapp official-API flow (token cache + message/send)')
  }

  // 2. 参数校验：未配置 / 未知通道。
  {
    const bad = await sendChannelNotification('ntfy', { topic: '' }, { title: 't', body: 'b', url: 'u' })
    assert.equal(bad.error, 'not-configured')
    const unknown = await sendChannelNotification('nope', {}, { title: 't', body: 'b', url: 'u' })
    assert.equal(unknown.error, 'unknown-channel')
    console.log('ok  channel validation')
  }

  // 3. 调度器：通道配置落盘 / 去重 / 派发（fetch 全 mock）。
  {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-push-'))
    const dispatcher = createNotifyDispatcher({ storeDir: dir, log: () => {}, publicBase: 'https://example.test' })

    // 空配置 → 不派发
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      calls += 1
      return { ok: true, status: 201 }
    }
    try {
      const empty = await dispatcher.dispatch({ title: 'T', body: 'B', path: '/' })
      assert.equal(empty.sent, 0, 'no channels → nothing sent')

      dispatcher.setChannel('ntfy', { topic: 'demo' }, true)
      dispatcher.setChannel('wecom', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc' }, true)
      calls = 0
      const one = await dispatcher.dispatch({ title: 'T', body: 'B', path: '/' })
      assert.equal(one.sent, 2, 'two channels → two requests')
      assert.equal(calls, 2)

      // 删一个通道后只剩一个
      dispatcher.setChannel('ntfy', {}, false)
      calls = 0
      const two = await dispatcher.dispatch({ title: 'T', body: 'B', path: '/' })
      assert.equal(two.sent, 1)
      assert.equal(calls, 1)

      // 落盘内容检查：channels 落盘、其他键不残留。
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8'))
      assert.deepEqual(Object.keys(state.channels), ['wecom'])
    } finally {
      globalThis.fetch = original
    }
    fs.rmSync(dir, { recursive: true, force: true })
    console.log('ok  dispatcher set/remove/dispatch/persist')
  }

  // 4. 请求形状：ntfy 的 POST（Title 头 + 纯文本 body）。
  {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-push-'))
    const dispatcher = createNotifyDispatcher({ storeDir: dir, log: () => {}, publicBase: 'https://example.test' })
    dispatcher.setChannel('ntfy', { topic: 'demo' }, true)
    const captured = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
      return { ok: true, status: 201 }
    }
    try {
      await dispatcher.dispatch({ title: '审批', body: '工具 bash', path: '/' })
    } finally {
      globalThis.fetch = original
    }
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.includes('/demo'), 'ntfy url contains topic')
    assert.equal(captured[0].method, 'POST')
    assert.equal(captured[0].headers.Title, '审批')
    assert.equal(captured[0].body, '工具 bash')
    fs.rmSync(dir, { recursive: true, force: true })
    console.log('ok  ntfy request shape')
  }

  console.log('push tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
