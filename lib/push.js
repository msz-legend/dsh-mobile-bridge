/**
 * 审批/配对通知 —— 统一走「外部推送通道」。
 *
 * 为什么只有外部通道：浏览器通知（页面内 SW / Web Push）覆盖不了 Android WebView 系
 * （夸克/UC/百度/微信内置）与 iOS 第三方浏览器，且各家权限模型不一致。外部通道由桌面端
 * 直接 POST 到通道服务商的 APP，装一个 APP 就能收，与浏览器完全无关，任何手机通用。
 *
 * 内置通道：ntfy / Bark / 企业微信自建应用（微信官方，直达微信服务通知） / 飞书 / 钉钉 /
 * 企业微信群机器人 / Telegram / 通用 Webhook。全部走各官方 API/Webhook，无第三方中转。
 * 每个通道的 steps 是给设置面板用的「具体配置步骤」，随 presets 下发。
 *
 * 状态：<storeDir>/push.json（{ channels: { name: { fields, enabled } } }），0600。
 * 纯本机存储，不随配对迁移。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

/** 发送外部通道通知。channel: keyof CHANNELS；fields: 用户填的键值。返回 { ok, status, error? }。 */
export async function sendChannelNotification(channel, fields, payload) {
  const preset = CHANNELS[channel]
  if (preset === undefined) return { ok: false, status: 0, error: 'unknown-channel' }
  // 企业微信自建应用：官方 API 两跳（access_token → 应用消息），单独分支。
  if (channel === 'wecomapp') return sendWeComApp(payload, fields || {})
  try {
    const request = preset.build(payload, fields || {})
    if (request.url === '' || /\/$/.test(request.url) === true) return { ok: false, status: 0, error: 'not-configured' }
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? undefined : request.body,
      signal: AbortSignal.timeout(10_000),
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
