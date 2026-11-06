/**
 * 审批/配对通知 —— 统一走「外部推送通道」。
 *
 * 为什么只有外部通道：浏览器通知（页面内 SW / Web Push）覆盖不了 Android WebView 系
 * （夸克/UC/百度/微信内置）与 iOS 第三方浏览器，且各家权限模型不一致。外部通道由桌面端
 * 直接 POST 到通道服务商的 APP，装一个 APP 就能收，与浏览器完全无关，任何手机通用。
 *
 * 内置通道：ntfy / Bark / 企业微信自建应用（微信官方，直达微信服务通知） / 飞书 / 钉钉 /
 * 企业微信群机器人 / 企业微信智能机器人（新版 BotID+Secret 长连接） / Telegram / 通用 Webhook。全部走各官方 API/Webhook，无第三方中转。
 * 每个通道的 steps 是给设置面板用的「具体配置步骤」，随 presets 下发。
 *
 * 状态：<storeDir>/push.json（{ channels: { name: { fields, enabled } } }），0600。
 * 纯本机存储，不随配对迁移。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

/* ============================ 通道预设 ============================ */

/** 通道预设。payload: { title, body, url }；每个模板返回 { method, url, headers, body }。 */
export const CHANNELS = {
  ntfy: {
    label: 'ntfy（Android/iOS，推荐）',
    hint: '一个 APP 两端通用，无需账号体系；免费公共服务器 ntfy.sh，也可自建。',
    fields: ['topic', 'server'],
    steps: [
      '手机应用商店搜索安装 ntfy（或官网 ntfy.sh/docs/install 下载 APK）。',
      '打开 ntfy APP → 订阅主题 → 随便填一个名字，如 dsh-approval。',
      '在下面「主题」填同样的名字，服务器留空（默认 ntfy.sh）。',
      '保存后回到 ntfy APP，该主题会显示「未收到通知」，配置即完成。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: `${(f.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(f.topic || '')}`,
      headers: { Title: title, Click: url },
      body,
    }),
  },
  bark: {
    label: 'Bark（iOS 专用）',
    hint: 'iPhone 上最省事的推送：装 Bark APP，它给你一个专属推送地址。',
    fields: ['url'],
    steps: [
      'App Store 安装 Bark。',
      '打开 Bark，页面顶部显示一个 https://api.day.app/xxxx 形式的地址 —— 复制它。',
      '把整段地址粘贴到下面「推送 URL」，保存即可。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'GET',
      url: `${(f.url || '').replace(/\/+$/, '')}/${encodeURIComponent(`${title} ${body}`.trim())}?url=${encodeURIComponent(url)}`,
      headers: {},
    }),
  },
  wecomapp: {
    label: '企业微信自建应用（微信官方，直达微信「服务通知」）',
    hint: '腾讯官方 API：企业微信后台建自建应用，微信里关注「微工作台(微信插件)」后消息直达微信服务通知。个人免企业认证可用。',
    fields: ['corpId', 'agentId', 'secret', 'toUser'],
    steps: [
      '电脑打开企业微信管理后台 work.weixin.qq.com，用微信扫码注册/登录（个人可注册，无需企业认证）。',
      '「应用管理」→「应用」→「创建应用」，名称随意（如 DSH 审批），创建后记下 AgentId。',
      '「我的企业」→「企业信息」页最下方复制企业 ID（corpId）。',
      '应用详情里点「查看 Secret」→ 按提示发送到企业微信应用后复制 Secret。',
      '「我的企业」→「微信插件」页，用微信扫码「关注」二维码（把企业微信工作台接入微信）。',
      '把 corpId / AgentId / Secret 填到下面，接收人留空即 @all（全体可见），保存即可。',
    ],
    /** 官方 API 两跳（get access_token → send message），由 sendChannelNotification 特殊分支处理。 */
    build: null,
  },
  feishu: {
    label: '飞书群机器人',
    hint: '飞书/ Lark 群自定义机器人，免费，群成员都能看到。',
    fields: ['url'],
    steps: [
      '手机或电脑打开目标飞书群 → 群设置 → 群机器人 → 添加机器人 → 自定义机器人。',
      '机器人名称随意（如 DSH 审批），安全设置建议勾选「自定义关键词」并填：审批。',
      '创建后复制「Webhook 地址」（https://open.feishu.cn/open-apis/bot/v2/hook/…）。',
      '粘贴到下面「Webhook 地址」保存即可。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${body}\n${url}` } }),
    }),
  },
  dingtalk: {
    label: '钉钉群机器人',
    hint: '钉钉群自定义机器人，免费，群里可见。',
    fields: ['url'],
    steps: [
      '钉钉打开目标群 → 群设置 → 智能群助手 → 添加机器人 → 自定义（通过 Webhook 接入）。',
      '安全设置三选一：自定义关键词填「审批」，或加签/限制 IP —— 以关键词最简单。',
      '复制生成的 Webhook 地址（https://oapi.dingtalk.com/robot/send?access_token=…）。',
      '粘贴到下面「Webhook 地址」保存即可。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}\n${url}` } }),
    }),
  },
  wecom: {
    label: '企业微信群机器人',
    hint: '企业微信群机器人，免费，企业微信里收到。',
    fields: ['url'],
    steps: [
      '企业微信打开目标群 → 群设置 → 群机器人 → 添加（需要群主/管理员）。',
      '复制机器人 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）。',
      '粘贴到下面「Webhook 地址」保存即可。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}\n${url}` } }),
    }),
  },
  wecomaibot: {
    label: '企业微信智能机器人（新版 BotID + Secret）',
    hint: '新版智能机器人（API 模式-长连接）：用 BotID+Secret 走官方 WebSocket 主动推送，无需 IP 白名单、无需公网回调地址。',
    fields: ['botId', 'secret', 'chatId', 'chatType'],
    steps: [
      '企业微信客户端 → 工作台 → 智能机器人 → 创建/API 模式创建 → 连接方式选「使用长连接」。',
      '创建后得到 BotID 与 Secret（Secret 只显示一次，丢失需重新生成）。',
      '先在与机器人的会话里给它发过至少一条消息（官方要求：有消息后机器人才允许主动推送）。',
      '单聊推送：chatId 填接收人 userid（管理后台通讯录成员详情页「账号」，机器人创建者须为企业超级管理员）；群聊推送：chatId 填群 chatid（回调事件里获取）。chatType 填 1=单聊 / 2=群聊。',
      '把 BotID / Secret / chatId / chatType 填到下面保存即可。',
    ],
    /** 官方长连接 WebSocket（aibot_subscribe → aibot_send_msg），由 sendChannelNotification 特殊分支处理。 */
    build: null,
  },
  telegram: {
    label: 'Telegram Bot',
    hint: 'Telegram 机器人，海外可用，需要科学上网或境外网络环境。',
    fields: ['token', 'chatId'],
    steps: [
      'Telegram 里搜索 @BotFather，发送 /newbot 按提示创建机器人，得到 Bot Token（123456:ABC…）。',
      '给你的机器人发一条任意消息（否则拿不到 chat_id）。',
      '浏览器打开 https://api.telegram.org/bot<你的token>/getUpdates，从返回 JSON 里找 chat.id 的值。',
      '把 Token 填到「token」、chat.id 填到「chat_id」，保存即可。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: `https://api.telegram.org/bot${f.token || ''}/sendMessage`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: f.chatId || '', text: `*${title}*\n${body}\n${url}`, parse_mode: 'Markdown' }),
    }),
  },
  webhook: {
    label: '通用 Webhook',
    hint: '任意 HTTP 接口：POST JSON { title, body, url }。可接 PushDeer、自有系统等未内置的官方/自建接口。',
    fields: ['url', 'token'],
    steps: [
      '准备一个可公网访问的 HTTP(S) 接口地址（POST）。',
      '把地址填到「URL」；若接口需要 Bearer Token 鉴权，填到「token」。',
      '保存后本机会向该地址 POST { "title", "body", "url" } JSON。',
      '对接示例：PushDeer（其接口需自定义 JSON 模板时可用此通道）、自建推送服务。',
    ],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: {
        'content-type': 'application/json',
        ...(f.token ? { Authorization: `Bearer ${f.token}` } : {}),
      },
      body: JSON.stringify({ title, body, url }),
    }),
  },
}

/**
 * 通用 HTTP 通道超时。实测 ntfy.sh 在本机（国内网络 + WARP 代理）POST 往返 9.3–10.7s，
 * 原 10_000 会产生「消息已被服务端接收却判定为失败」的假阴性，故放宽到 15s。
 * 通知是 fire-and-forget 旁路，宁可多等几秒也不要误报失败。
 */
const HTTP_TIMEOUT_MS = 15_000

/** 发送外部通道通知。channel: keyof CHANNELS；fields: 用户填的键值。返回 { ok, status, error? }。 */
export async function sendChannelNotification(channel, fields, payload) {
  const preset = CHANNELS[channel]
  if (preset === undefined) return { ok: false, status: 0, error: 'unknown-channel' }
  // 企业微信自建应用：官方 API 两跳（access_token → 应用消息），单独分支。
  if (channel === 'wecomapp') return sendWeComApp(payload, fields || {})
  // 企业微信智能机器人（新版 BotID+Secret）：官方长连接 WebSocket，单独分支。
  if (channel === 'wecomaibot') return sendWeComAibot(payload, fields || {})
  try {
    const request = preset.build(payload, fields || {})
    if (request.url === '' || /\/$/.test(request.url) === true) return { ok: false, status: 0, error: 'not-configured' }
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? undefined : request.body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  }
}

/* ---------- 企业微信自建应用（官方 API） ---------- */

// access_token 有效期 7200s，进程内缓存并提前 5 分钟刷新。
const wecomTokenCache = new Map() // key: corpId|agentId|secret 的 hash → { token, expiresAt }

const wecomCacheKey = (fields) =>
  `${fields.corpId ?? ''}|${fields.agentId ?? ''}|${crypto.createHash('sha256').update(String(fields.secret ?? '')).digest('hex').slice(0, 16)}`

/** 企业微信官方 API：GET gettoken → POST message/send。secret 只参与取 token，不随消息外发。 */
async function sendWeComApp(payload, fields) {
  const corpId = String(fields.corpId ?? '').trim()
  const agentId = Number.parseInt(String(fields.agentId ?? ''), 10)
  const secret = String(fields.secret ?? '').trim()
  if (corpId === '' || Number.isNaN(agentId) || secret === '') return { ok: false, status: 0, error: 'not-configured' }
  const cacheKey = wecomCacheKey(fields)
  const cached = wecomTokenCache.get(cacheKey)
  let token = cached !== undefined && cached.expiresAt > Date.now() ? cached.token : undefined
  if (token === undefined) {
    try {
      const response = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`,
        { signal: AbortSignal.timeout(10_000) },
      )
      const json = await response.json().catch(() => undefined)
      if (json?.errcode !== 0 || typeof json.access_token !== 'string' || json.access_token === '') {
        return { ok: false, status: response.status, error: `gettoken:${json?.errcode ?? response.status}:${json?.errmsg ?? 'no-body'}` }
      }
      token = json.access_token
      wecomTokenCache.set(cacheKey, { token, expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000 - 300_000 })
    } catch (error) {
      return { ok: false, status: 0, error: `gettoken:${String(error?.message ?? error)}` }
    }
  }
  const text = `${payload.title}\n${payload.body}\n${payload.url}`.trim()
  const body = JSON.stringify({
    touser: String(fields.toUser ?? '').trim() || '@all',
    msgtype: 'text',
    agentid: agentId,
    text: { content: text },
  })
  try {
    const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    const json = await response.json().catch(() => undefined)
    // 40014/42001 token 失效：清缓存让下次重取
    if (json?.errcode === 40014 || json?.errcode === 42001) wecomTokenCache.delete(cacheKey)
    return { ok: response.ok === true && json?.errcode === 0, status: response.status, error: json?.errcode !== 0 ? `send:${json?.errcode}:${json?.errmsg ?? ''}` : undefined }
  } catch (error) {
    return { ok: false, status: 0, error: `send:${String(error?.message ?? error)}` }
  }
}

/* ---------- 企业微信智能机器人（新版 BotID + Secret，长连接） ---------- */

/**
 * 智能机器人主动推送（官方协议，developer.work.weixin.qq.com/document/path/101463）：
 *   wss://openws.work.weixin.qq.com
 *   1. aibot_subscribe { body: { bot_id, secret } } 鉴权（errcode=0 即成功）
 *   2. aibot_send_msg { body: { chatid, chat_type?, msgtype: 'markdown', markdown: { content } } }
 *   响应帧按 headers.req_id 关联，errcode=0 为成功。
 * 前置条件：用户需先在对应会话给机器人发过消息；频率限制 30 条/分钟、1000 条/小时。
 * 实现为「每次通知开一条一次性连接，发完即关」，无需常驻心跳（ping 建议间隔 30s，本实现生命周期 <10s）。
 * 用 `ws` 包而非 Node 内置 WebSocket：实测 openws.work.weixin.qq.com 会把 undici 的握手断开（close 1006），
 * `ws`（官方 SDK 同款，ws@^8.16.0）握手正常。
 */

const AIBOT_WS_URL = 'wss://openws.work.weixin.qq.com'

/** 等待 WebSocket 打开（带超时）。 */
function wsOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve() }
    const onError = (error) => { cleanup(); reject(new Error(`websocket error: ${error?.message ?? error}`)) }
    const onClose = () => { cleanup(); reject(new Error('websocket closed before open')) }
    const cleanup = () => {
      ws.off('open', onOpen)
      ws.off('error', onError)
      ws.off('close', onClose)
    }
    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('close', onClose)
    const timer = setTimeout(() => { cleanup(); reject(new Error('websocket open timeout')) }, timeoutMs)
    timer.unref?.()
  })
}

/** 发送一条命令帧并等待同 req_id 的响应帧（带超时）。 */
function wsCall(ws, cmd, body, timeoutMs) {
  const reqId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`${cmd} timeout`))
    }, timeoutMs)
    timer.unref?.()
    const onMessage = (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      if (frame?.headers?.req_id !== reqId) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
    ws.once('error', (error) => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      reject(new Error(`${cmd} websocket error: ${error?.message ?? error}`))
    })
    ws.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }))
  })
}

/** 智能机器人主动推送：一次性连接 订阅→发 markdown 消息→关。 */
async function sendWeComAibot(payload, fields) {
  const botId = String(fields.botId ?? '').trim()
  const secret = String(fields.secret ?? '').trim()
  const chatId = String(fields.chatId ?? '').trim()
  if (botId === '' || secret === '' || chatId === '') return { ok: false, status: 0, error: 'not-configured' }
  const chatType = Number.parseInt(String(fields.chatType ?? ''), 10)
  const content = `${payload.title}\n${payload.body}\n${payload.url}`.trim()
  let ws
  try {
    ws = new WebSocket(AIBOT_WS_URL)
    await wsOpen(ws, 10_000)
    const sub = await wsCall(ws, 'aibot_subscribe', { bot_id: botId, secret }, 10_000)
    if (sub?.errcode !== 0) return { ok: false, status: 0, error: `subscribe:${sub?.errcode ?? 'no-resp'}:${sub?.errmsg ?? ''}` }
    const sendBody = { chatid: chatId, msgtype: 'markdown', markdown: { content } }
    // chat_type: 1 单聊（userid）/ 2 群聊（chatid）；0 或不填由官方自动兼容，建议显式指定。
    if (chatType === 1 || chatType === 2) sendBody.chat_type = chatType
    const sent = await wsCall(ws, 'aibot_send_msg', sendBody, 10_000)
    return {
      ok: sent?.errcode === 0,
      status: 0,
      error: sent?.errcode !== 0 ? `send:${sent?.errcode ?? 'no-resp'}:${sent?.errmsg ?? ''}` : undefined,
    }
  } catch (error) {
    return { ok: false, status: 0, error: `aibot:${String(error?.message ?? error)}` }
  } finally {
    try { ws?.close() } catch {}
  }
}

/* ============================ 调度器 ============================ */

/**
 * 创建通知调度器：审批卡出现时并发打全部已启用通道。
 * 状态持久化在 <storeDir>/push.json（0600）。dispatch 绝不 throw，失败只记日志。
 */
export function createNotifyDispatcher({ storeDir, log, publicBase }) {
  const filePath = path.join(storeDir, 'push.json')
  const readState = () => {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }
  const writeState = (state) => {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 })
    } catch (error) {
      log('push state persist failed:', error?.message ?? error)
    }
  }

  return {
    /** 通道配置（POST /push/channel）。 */
    setChannel: (channel, fields, enabled) => {
      const state = readState()
      state.channels = state.channels ?? {}
      if (enabled === false) delete state.channels[channel]
      else state.channels[channel] = { fields: fields ?? {}, enabled: enabled !== false }
      writeState(state)
      return { ok: true }
    },
    getChannels: () => {
      const state = readState()
      return state.channels ?? {}
    },
    /** 审批卡与任务结束态的事件入口：并发打全部通道，绝不 throw。publicBase 支持函数（实时取）或字符串。 */
    dispatch: async ({ title, body, path: linkPath }) => {
      const base = String(typeof publicBase === 'function' ? publicBase() : publicBase ?? '').replace(/\/+$/, '')
      const url = `${base}${linkPath ?? '/'}`
      const payload = { title, body, url }
      const state = readState()
      const jobs = []
      for (const [channel, config] of Object.entries(state.channels ?? {})) {
        if (config?.enabled !== true) continue
        jobs.push(
          sendChannelNotification(channel, config.fields, payload).then((result) =>
            result.ok ? 'ok' : `fail:${result.status}${result.error ? `:${result.error}` : ''}`,
          ),
        )
      }
      if (jobs.length === 0) return { sent: 0, results: [] }
      const results = await Promise.allSettled(jobs)
      const values = results.map((entry) => (entry.status === 'fulfilled' ? entry.value : `fail:${entry.reason}`))
      const sent = values.filter((value) => value === 'ok').length
      log(`notify dispatch: ${sent}/${values.length} ok`)
      return { sent, results: values }
    },
  }
}
