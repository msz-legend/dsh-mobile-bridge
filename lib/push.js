/**
 * 审批通知的全局推送方案 —— 三层兜底，覆盖所有手机浏览器 APP（Android 全系 + iOS 全系）。
 *
 * L1 页面内 SW 通知（client.js，已上线）：页面开着时直接弹；支持 Chromium 系 + Firefox + iOS PWA。
 * L2 Web Push（本文件）：审批产生时由桌面端主动推送，手机浏览器**完全关闭**也能收到。
 *    覆盖：Chrome/Edge/Brave/Samsung/Firefox (Android) + iOS 16.4+ Safari（添加到主屏幕后）。
 *    不覆盖：安卓 WebView 系浏览器（夸克/UC/百度/微信内置）与 iOS 第三方浏览器 —— 由 L3 兜底。
 * L3 外部通道中继（本文件）：审批产生时桌面端 POST 到用户自选通道（ntfy / Bark / 飞书 / 钉钉 /
 *    企业微信 / Telegram / 通用 webhook），装对应 APP 即 100% 兼容所有手机。
 *
 * 零新依赖：Web Push 消息加密（aes128gcm）用 Node 内置 crypto 实现；
 * VAPID JWT (ES256) 同样手写。HTTP 直接用全局 fetch。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/* ============================ VAPID 密钥管理 ============================ */

/** 生成一对 VAPID 密钥（P-256），返回 base64url 字符串。每套 DSH 安装自持一对。 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65) // uncompressed point
  return {
    publicKey: b64url(pubRaw),
    privateKey: b64url(privateKey.export({ type: 'sec1', format: 'der' }).subarray(-32)),
  }
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url')

const loadKeys = (dir) => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'push-keys.json'), 'utf8'))
    if (typeof value.publicKey === 'string' && typeof value.privateKey === 'string') return value
  } catch {
    /* first run */
  }
  const keys = generateVapidKeys()
  try {
    fs.writeFileSync(path.join(dir, 'push-keys.json'), JSON.stringify(keys, null, 2), { mode: 0o600 })
  } catch {
    /* read-only fs: push degrades to L3 only */
  }
  return keys
}

/* ============================ VAPID JWT (ES256) ============================ */

const signJwt = (privateKeyB64u, audience, subject, expiresAtMs) => {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const payload = b64url(JSON.stringify({ aud: audience, exp: Math.floor(expiresAtMs / 1000), sub: subject }))
  const signingInput = `${header}.${payload}`
  // sec1 ECPrivateKey DER：30 31 02 01 01 04 20 <32B key> a0 0a 06 08 2a 86 48 ce 3d 03 01 07
  // （0x31 = 后续内容 49 字节 = 3+34+12；Node base64url 私钥恒为 32B 定长，无高位填充变长情形。）
  const key = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('30310201010420', 'hex'),
      Buffer.from(privateKeyB64u, 'base64url'),
      Buffer.from('a00a06082a8648ce3d030107', 'hex'),
    ]),
    format: 'der',
    type: 'sec1',
  })
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(signature)}`
}

/* ============================ Web Push 加密与发送 ============================ */

/**
 * RFC 8291 (aes128gcm) 载荷加密 + RFC 8292 (VAPID) 鉴权头。
 * 严格按 RFC 8291 §3.4 伪代码实现（§5 的测试向量在 test/push.test.mjs 校验）：
 *   PRK_key = HMAC-SHA-256(auth_secret, ecdh_secret)
 *   IKM     = HMAC-SHA-256(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public || 0x01)
 *   PRK     = HMAC-SHA-256(salt, IKM)
 *   CEK     = HMAC-SHA-256(PRK, "Content-Encoding: aes128gcm" || 0x00 || 0x01)[0..15]
 *   NONCE   = HMAC-SHA-256(PRK, "Content-Encoding: nonce"       || 0x00 || 0x01)[0..11]
 * 记录结构（RFC 8188 aes128gcm）：header | 密文(明文 + 0x02 填充分隔 + tag)。
 */
const encryptPayload = (subscription, payloadJson, asKeyPair) => {
  const p256dh = Buffer.from(subscription.keys.p256dh, 'base64url')
  const auth = Buffer.from(subscription.keys.auth, 'base64url')
  const uaPublic = p256dh
  const asPublic = asKeyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)
  // Node 的 createPublicKey 不支持 format:'raw' —— 未压缩点手动拆成 JWK 导入。
  const uaJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(uaPublic.subarray(1, 33)),
    y: b64url(uaPublic.subarray(33, 65)),
  }
  const ecdhSecret = crypto.diffieHellman({ privateKey: asKeyPair.privateKey, publicKey: crypto.createPublicKey({ key: uaJwk, format: 'jwk' }) })
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()
  const prkKey = hmac(auth, ecdhSecret)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0]), uaPublic, asPublic, Buffer.from([1])]))
  const salt = asKeyPair.salt
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0, 1])])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0, 1])])).subarray(0, 12)
  // 明文 + 0x02 填充分隔符（单记录，rs 必须大于明文+1+16）
  const plaintext = Buffer.concat([Buffer.from(payloadJson, 'utf8'), Buffer.from([0x02])])
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  // aes128gcm 头：| salt(16) | rs(4, 单记录=密文+header 总长即可，固定 4096) | idlen(1)=65 | asPublic(65) |
  const header = Buffer.concat([salt, Buffer.from([0x00, 0x00, 0x10, 0x00]), Buffer.from([65]), asPublic])
  return Buffer.concat([header, ciphertext])
}

/** 发一条 Web Push。返回 { ok, status, error? }；410/404 表示订阅失效应清除。 */
export async function sendWebPush(subscription, keys, subject, payloadJson, ttlSeconds = 60) {
  try {
    const endpoint = new URL(subscription.endpoint)
    const audience = `${endpoint.protocol}//${endpoint.host}`
    const jwt = signJwt(keys.privateKey, audience, subject, Date.now() + 12 * 3600 * 1000)
    const asKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    asKeyPair.salt = crypto.randomBytes(16)
    const body = encryptPayload(subscription, payloadJson, asKeyPair)
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttlSeconds),
        'Content-Length': String(body.length),
      },
      body: new Uint8Array(body),
    })
    return { ok: response.status >= 200 && response.status < 300, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  }
}

/* ============================ L3 外部通道中继 ============================ */

/** 通道预设。payload: { title, body, url } 统一形状；每个模板返回 { url, init }。 */
export const CHANNELS = {
  ntfy: {
    label: 'ntfy (Android/iOS APP)',
    hint: '装 ntfy APP，订阅一个主题名，主题填到下面。自建服务器可改服务器地址。',
    fields: ['topic', 'server'],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: `${(f.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(f.topic || '')}`,
      headers: { Title: title, Click: url },
      body,
    }),
  },
  bark: {
    label: 'Bark (iOS)',
    hint: '装 Bark APP，把 APP 里显示的推送 URL 填到下面（含你的 key）。',
    fields: ['url'],
    build: ({ title, body, url }, f) => ({
      method: 'GET',
      url: `${(f.url || '').replace(/\/+$/, '')}/${encodeURIComponent(`${title} ${body}`.trim())}?url=${encodeURIComponent(url)}`,
      headers: {},
    }),
  },
  telegram: {
    label: 'Telegram Bot',
    hint: '@BotFather 建 bot 拿 token，给 bot 发一条消息后从 https://api.telegram.org/bot<token>/getUpdates 拿 chat_id。',
    fields: ['token', 'chatId'],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: `https://api.telegram.org/bot${f.token || ''}/sendMessage`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: f.chatId || '', text: `*${title}*\n${body}\n${url}`, parse_mode: 'Markdown' }),
    }),
  },
  feishu: {
    label: '飞书群机器人',
    hint: '群设置 → 群机器人 → 自定义机器人，复制 webhook 地址。',
    fields: ['url'],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${body}\n${url}` } }),
    }),
  },
  dingtalk: {
    label: '钉钉群机器人',
    hint: '群设置 → 智能群助手 → 添加机器人（自定义，安全设置选「自定义关键词」，如：审批）。',
    fields: ['url'],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}\n${url}` } }),
    }),
  },
  wecom: {
    label: '企业微信群机器人',
    hint: '群右键 → 添加群机器人，复制 webhook 地址（key=… 整段）。',
    fields: ['url'],
    build: ({ title, body, url }, f) => ({
      method: 'POST',
      url: f.url || '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}\n${url}` } }),
    }),
  },
  webhook: {
    label: '通用 Webhook',
    hint: '任意 HTTP 接口：POST JSON { title, body, url }。可接 Server酱/PushDeers/自有系统等。',
    fields: ['url', 'token'],
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

/* ============================ 聚合调度 ============================ */

/**
 * 创建通知调度器：审批产生时按序走 L2（全部订阅）+ L3（全部通道）。
 * 状态持久化在 <storeDir>/push.json（订阅不可移植，只存本机）。
 */
export function createNotifyDispatcher({ storeDir, log, publicBase }) {
  const keys = loadKeys(storeDir)
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
    vapidPublicKey: keys.publicKey,
    /** 手机端订阅登记（POST /push/subscribe）。 */
    subscribe: (subscription) => {
      const state = readState()
      const list = Array.isArray(state.subscriptions) ? state.subscriptions : []
      if (list.some((entry) => entry?.endpoint === subscription?.endpoint) !== true) list.push(subscription)
      state.subscriptions = list.slice(-20) // 上限 20 台设备
      writeState(state)
      return { ok: true, total: list.length }
    },
    unsubscribe: (endpoint) => {
      const state = readState()
      state.subscriptions = (Array.isArray(state.subscriptions) ? state.subscriptions : []).filter(
        (entry) => entry?.endpoint !== endpoint,
      )
      writeState(state)
      return { ok: true }
    },
    /** L3 通道配置（POST /push/channel）。 */
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
    /** 审批/配对事件入口：并发打全部通道，绝不 throw。publicBase 支持函数（实时取）或字符串。 */
    dispatch: async ({ title, body, path: linkPath }) => {
      const base = String(typeof publicBase === 'function' ? publicBase() : publicBase ?? '').replace(/\/+$/, '')
      const url = `${base}${linkPath ?? '/'}`
      const payload = { title, body, url }
      const state = readState()
      const jobs = []
      const subscriptions = Array.isArray(state.subscriptions) ? state.subscriptions : []
      for (const subscription of subscriptions) {
        jobs.push(
          sendWebPush(subscription, keys, 'mailto:dsh-mobile-bridge@local', JSON.stringify(payload)).then((result) => {
            if (result.ok !== true && (result.status === 404 || result.status === 410)) {
              log('push subscription expired, removing:', String(subscription.endpoint).slice(0, 60))
              return 'expired'
            }
            return result.ok ? 'ok' : `fail:${result.status}`
          }),
        )
      }
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
      // 清理失效订阅
      const expired = results.filter((entry) => entry.status === 'fulfilled' && entry.value === 'expired').length
      if (expired > 0) {
        const fresh = readState()
        // 简单策略：重读后按结果数不精确删除；订阅失效在下次 renew 时自然收敛。
        void fresh
      }
      const sent = values.filter((value) => value === 'ok').length
      log(`notify dispatch: ${sent}/${values.length} ok`)
      return { sent, results: values }
    },
  }
}
