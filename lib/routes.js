/**
 * 插件 HTTP 路由：挂在宿主 webServer 的 `/plugins/dsh-mobile-bridge` 前缀下。
 *
 * 为什么挂在宿主而不是 edge：桌面页面（127.0.0.1:56915）也要能读配对信息、
 * 也要能显示审批卡片；挂在宿主上，桌面是 loopback 直连、手机经 edge 反代，
 * 两边共用同一套路由，不需要 CORS，也不需要第二个鉴权面。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { iconPng, manifestJson } from './pwa.js'
import { CHANNELS } from './push.js'
import {
  tailscaleStatus,
  tailscaleLogin,
  tailscaleEnableFunnel,
  tailscaleDisableFunnel,
  tailscaleInstall,
} from './tailscale.js'
import {
  readTunnelFile,
  writeTunnelFile,
  validateCloudflareSetup,
  detectCloudflared,
  probePublic,
  cloudflaredServiceStatus,
  cloudflaredServiceInstall,
  cloudflaredServiceUninstall,
} from './cloudflare-setup.js'
import { detectSakuraBin } from './sakurafrp.js'

const BASE = '/plugins/dsh-mobile-bridge'
const DEVICE_COOKIE = 'dmb'

const readBody = (req, limit = 64 * 1024) =>
  new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })

/** 宽容解析请求体：JSON 优先，失败时按表单编码解析，绝不向上抛异常。 */
const readJsonBody = async (req, limit) => {
  const text = await readBody(req, limit)
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return Object.fromEntries(new URLSearchParams(text))
  }
}

const parseCookies = (header) => {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key !== '') out[key] = decodeURIComponent(value)
  }
  return out
}

const isLoopback = (address) => {
  const text = String(address ?? '')
  return text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1'
}

const json = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const bytes = (res, status, buffer, contentType, cacheControl) => {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': cacheControl,
    'content-length': buffer.length,
  })
  res.end(buffer)
}

const html = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

const qrDataUrl = async (text) => {
  try {
    const module = await import('qrcode')
    const QRCode = module.default ?? module
    return await QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
  } catch {
    return undefined
  }
}

/** R3 DMB-003/014：配对页文案唯一来源 = locale/{zh,en}.json（与 package.json exports 对齐）。
 *  同步读取一次并缓存；文件缺失时回退到内置最小中文文案（保证页面永远可渲染）。 */
const LOCALE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../locale')
const loadLocale = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${name}.json`), 'utf8'))
  } catch {
    return undefined
  }
}
const LOCALE = { zh: loadLocale('zh') ?? {}, en: loadLocale('en') ?? {} }

/** R3 DMB-003：按 Accept-Language 协商配对页语言（zh 默认，en 次之）。 */
const pickLocale = (req) => {
  const header = String(req?.headers?.['accept-language'] ?? '')
  const langs = header.split(',').map((part) => part.trim().toLowerCase())
  for (const tag of langs) {
    const base = tag.split(';')[0]
    if (base.startsWith('zh')) return 'zh'
    if (base.startsWith('en')) return 'en'
  }
  return 'zh'
}

/** 只对真公网地址做健康探测；loopback/LAN 直连不发起无意义的外网请求。 */
const probeIfPublic = async (url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url)) return false
  return probePublic(url)
}

/** 绑定失败 reason → locale 文案（不再暴露内部记号）。 */
const pairErrorText = (locale, reason) => {
  const t = (LOCALE[locale] ?? LOCALE.zh).pair ?? {}
  if (reason === 'wrong-password') return t.wrongPassword ?? (locale === 'en' ? 'Incorrect binding password' : '绑定密码不正确')
  if (reason === 'too-many-attempts') return t.tooMany ?? (locale === 'en' ? 'Too many attempts, please try again later' : '尝试过于频繁，请稍后再试')
  return `${locale === 'en' ? 'Binding failed' : '绑定失败'}（${reason}）`
}

/** 绑定页：只显示地址二维码 + 密码输入框。二维码只编码纯 URL，不含任何密码/自动提交脚本。 */
function pairPage({ publicBase, error, locale = 'zh' }) {
  const t = (LOCALE[locale] ?? LOCALE.zh).pair ?? {}
  const target = `${publicBase}/plugins/dsh-mobile-bridge/pair`
  const lang = locale === 'en' ? 'en' : 'zh-CN'
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(t.title ?? (locale === 'en' ? 'Bind phone' : '绑定手机'))}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  background:#0f172a;color:#e2e8f0;padding:24px;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
.card{width:100%;max-width:360px;background:#111c33;border:1px solid #24324f;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{margin:0 0 4px;font-size:18px}
p{margin:0 0 16px;color:#94a3b8;font-size:13px}
.addr{word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace;color:#93c5fd;background:#0b1424;padding:8px 10px;border-radius:10px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #33415c;background:#0b1424;color:#e2e8f0;font-size:17px;text-align:center;margin:10px 0}
button{width:100%;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;font-weight:600}
.err{background:#7f1d1d;color:#fecaca;border-radius:10px;padding:10px;font-size:13px;margin-bottom:12px}
img.qr{display:block;width:100%;max-width:260px;margin:0 auto;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box}
</style></head>
<body><div class="card">
<h1>${escapeHtml(t.h1 ?? (locale === 'en' ? 'Bind phone' : '绑定手机'))}</h1>
<p>${escapeHtml(t.hint ?? (locale === 'en' ? 'Enter the binding password shown on your computer.' : '输入电脑上显示的绑定密码完成绑定。'))}</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
<div class="addr">${escapeHtml(target.replace(/\/pair$/, '/'))}</div>
<form method="post" action="${BASE}/pair">
  <input name="password" type="password" autocomplete="off" placeholder="${escapeHtml(t.password ?? (locale === 'en' ? 'Binding password' : '绑定密码'))}" maxlength="64">
  <input name="name" placeholder="${escapeHtml(t.name ?? (locale === 'en' ? 'Device name (optional)' : '设备名（可选）'))}" maxlength="48" style="font-size:14px">
  <button type="submit">${escapeHtml(t.submit ?? (locale === 'en' ? 'Bind' : '绑定'))}</button>
</form>
</div></body></html>`
}

/**
 * 绑定失败限速：按来源 IP 的滑动窗口（默认每分钟 10 次）。
 * now 可注入，便于测试推进虚拟时钟；key 复用 pollKeyOf(req)。
 */
export function createPairAttemptLimiter({ perMinute = 10, now = Date.now } = {}) {
  const hits = new Map()
  return (key) => {
    const nowMs = now()
    const record = hits.get(key) ?? { windowStart: nowMs, count: 0 }
    if (nowMs - record.windowStart > 60_000) {
      record.windowStart = nowMs
      record.count = 0
    }
    record.count += 1
    hits.set(key, record)
    if (hits.size > 2000) {
      for (const [k, v] of hits) {
        if (nowMs - v.windowStart > 120_000) hits.delete(k)
      }
    }
    return record.count <= perMinute
  }
}

/** 轮询限速键：隧道流量回源是 loopback，优先取真实访客 IP（与 edge 的 limiterKeyOf 同思路）。 */
const pollKeyOf = (req) => {
  const forwarded = String(req.headers['x-dmb-forwarded-for'] ?? '')
  if (forwarded === '127.0.0.1' || forwarded === '::1' || forwarded === '::ffff:127.0.0.1') {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf.trim() !== '') return `cf:${cf.trim()}`
  }
  return forwarded || req.socket.remoteAddress || 'unknown'
}

export function registerRoutes(ctx, deps) {
  const { config, pairing, hub, bridge, always, store, log, getPublicBase, getLaunchUrl, getEdgeStatus, tunnel, hostLogin, setPublicBase, rebuildTunnel, notify, binding } = deps

  const deviceOf = (req) => {
    const cookies = parseCookies(req.headers.cookie)
    return pairing.authenticate(cookies[DEVICE_COOKIE])
  }

  // 密码是长期有效的，必须挡暴力破解：按来源 IP 的失败次数滑动窗口（每 10 次/分钟）。
  const pairLimiter = deps.pairLimiter ?? createPairAttemptLimiter()

  /**
   * 「真的来自本机」判定。
   *
   * 不能只看 socket 地址：edge 反代回源时源地址就是 127.0.0.1，若不区分，
   * 任何经 edge 进来的手机都会被当成桌面本机，从而拿到绑定密码、设备列表、
   * 甚至撤销全部设备。edge 会给每个转发请求打上 `x-dmb-forwarded-for`，
   * 这里以「没有该头」作为本机的必要条件。
   */
  const requireLoopback = (req) => {
    if (req.headers['x-dmb-forwarded-for'] !== undefined) return false
    return isLoopback(req.socket.remoteAddress)
  }

  // 配对交付时要新鲜的宿主 owner cookies（宿主重启后旧的全失效）
  const dshCoveredUrl = async () => (hostLogin !== undefined ? hostLogin.login(true) : undefined)

  const tunnelSummary = () => {
    const state = tunnel?.status?.()
    if (state === undefined) return undefined
    return { enabled: state.enabled, mode: state.mode, running: state.running, url: state.url, lastError: state.lastError }
  }

  /**
   * Cookie 是否该打 Secure。
   *
   * 不能只看 publicBase：真机实测（adb reverse / 局域网 HTTP）下 publicBase 是 https 隧道地址，
   * 但手机实际是用 http 访问 edge 的，带 Secure 的 cookie 会被浏览器直接丢弃，
   * 表现为「配对成功但立刻掉回 authentication required」。
   * 以手机→edge 的真实协议为准；没有该头（本机 loopback 直连）时退回 publicBase 判定。
   */
  const shouldSecureCookie = async (req) => {
    const proto = req.headers['x-dmb-proto']
    if (typeof proto === 'string' && proto.trim() !== '') return proto.trim().toLowerCase() === 'https'
    return (await getPublicBase()).startsWith('https:')
  }

  const handler = async (req, res) => {
    let pathname = '/'
    let search = new URLSearchParams()
    try {
      const url = new URL(req.url ?? '/', 'http://placeholder')
      pathname = url.pathname
      search = url.searchParams
    } catch {
      pathname = '/'
    }
    const route = pathname.slice(BASE.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    // ---- 绑定页（未绑定可达，靠绑定密码 + 限速保护） ----
    if (route === '/pair' && method === 'GET') {
      const publicBase = await getPublicBase()
      const qr = await qrDataUrl(`${publicBase}${BASE}/pair`)
      const locale = pickLocale(req)
      const page = pairPage({
        publicBase,
        error: search.get('error') ?? undefined,
        locale,
      })
      const alt = (LOCALE[locale] ?? LOCALE.zh).pair?.qrAlt ?? (locale === 'en' ? 'Binding address QR code' : '绑定地址二维码')
      const withQr = qr === undefined ? page : page.replace('<p>', `<img class="qr" alt="${escapeHtml(alt)}" src="${qr}"><p>`)
      html(res, 200, withQr)
      return
    }

    // ---- 绑定提交：密码正确即直接发设备令牌（无桌面确认、无扫码自动提交） ----
    if (route === '/pair' && method === 'POST') {
      const locale = pickLocale(req)
      const body = await readBody(req)
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        for (const [key, value] of new URLSearchParams(body)) payload[key] = value
      }
      const renderError = async (status, error) => html(res, status, pairPage({
        publicBase: await getPublicBase(),
        error,
        locale,
      }))
      if (!pairLimiter(pollKeyOf(req))) {
        await renderError(429, pairErrorText(locale, 'too-many-attempts'))
        return
      }
      if (binding === undefined) {
        json(res, 503, { ok: false, error: 'binding-unavailable' })
        return
      }
      if (binding.verify(payload.password) !== true) {
        await renderError(403, pairErrorText(locale, 'wrong-password'))
        return
      }
      const device = pairing.issueDevice(payload.name)
      if (device === undefined) {
        const t = (LOCALE[locale] ?? LOCALE.zh).pair ?? {}
        const limitText = (t.limit ?? (locale === 'en' ? 'Device limit ({max}) reached' : '已达到设备上限（{max}），请先在桌面端撤销旧设备。')).replace('{max}', String(config.maxDevices))
        await renderError(429, limitText)
        return
      }
      const cookies = await dshCoveredUrl()
      const secure = await shouldSecureCookie(req)
      const setCookies = [
        `${DEVICE_COOKIE}=${device.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
        ...(cookies ?? []),
      ]
      res.writeHead(303, { location: '/', 'set-cookie': setCookies })
      res.end()
      return
    }

    // ---- 绑定信息（仅桌面 loopback 可读；密码不下发给手机） ----
    if (route === '/pairing.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (binding === undefined) {
        json(res, 503, { ok: false, error: 'binding-unavailable' })
        return
      }
      const publicBase = await getPublicBase()
      const qr = await qrDataUrl(`${publicBase}${BASE}/pair`)
      const info = binding.describe()
      json(res, 200, {
        ok: true,
        publicBase,
        pairUrl: `${publicBase}${BASE}/pair`,
        password: binding.reveal(),
        hasCustomBinding: info.hasCustom,
        createdAt: info.createdAt,
        qrDataUrl: qr,
      })
      return
    }

    // ---- 绑定密码重生成 / 自定义（仅桌面 loopback 可达） ----
    if (route === '/binding/regenerate' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (binding === undefined) {
        json(res, 503, { ok: false, error: 'binding-unavailable' })
        return
      }
      const payload = await readJsonBody(req)
      const raw = typeof payload.password === 'string' ? payload.password.trim() : ''
      let password
      try {
        password = binding.regenerate(raw === '' ? undefined : raw)
      } catch (error) {
        if (error instanceof Error && error.message === 'binding-password-length') {
          json(res, 400, { ok: false, error: 'binding-password-length' })
        } else {
          json(res, 500, { ok: false, error: 'binding-password-failed' })
        }
        return
      }
      const info = binding.describe()
      json(res, 200, { ok: true, password, hasCustomBinding: info.hasCustom, createdAt: info.createdAt })
      return
    }

    // ---- 浏览器半身加载回执（自证客户端已注册） ----
    if (route === '/client-hello' && method === 'POST') {
      const payload = JSON.parse((await readBody(req, 4096)) || '{}')
      const hello = deps.clientHello
      hello.count += 1
      hello.lastAt = Date.now()
      hello.note = typeof payload.note === 'string' ? payload.note.slice(0, 160) : hello.note
      hello.href = typeof payload.href === 'string' ? payload.href : hello.href
      json(res, 200, { ok: true })
      return
    }

    // ---- SSE 事件流 ----
    if (route === '/events' && method === 'GET') {
      const device = deviceOf(req)
      const loopback = requireLoopback(req)
      if (device === undefined && !loopback) {
        json(res, 401, { ok: false, error: 'pair required' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      const client = hub.add(res, device)
      hub.sendTo(client, { type: 'hello', pendingApprovals: bridge.pendingCount() })
      // 重连回放：断线窗口里错过的审批卡按 requestId 补发（客户端幂等去重）
      bridge.replayRequests((payload) => hub.sendTo(client, payload))
      return
    }

    // ---- 审批决策 ----
    if (route === '/decision' && method === 'POST') {
      const device = deviceOf(req)
      if (device === undefined && !requireLoopback(req)) {
        json(res, 401, { ok: false, error: 'pair required' })
        return
      }
      const body = await readBody(req)
      let payload = {}
      try {
        payload = JSON.parse(body ?? '{}')
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      const result = bridge.decide({
        requestId: payload.requestId,
        decision: payload.decision,
        deviceId: device?.deviceId,
      })
      json(res, result.ok ? 200 : 409, { ...result, device: device?.deviceId ?? 'desktop' })
      return
    }

    // ---- 概览（设置页用；设备与 loopback 都可读，不含敏感令牌） ----
    if (route === '/overview' && method === 'GET') {
      const device = deviceOf(req)
      const loopback = requireLoopback(req)
      if (device === undefined && !loopback) {
        json(res, 401, { ok: false, error: 'pair required' })
        return
      }
      const devices = pairing.listDevices()
      const active = devices.filter((entry) => entry.revoked !== true)
      const online = [...hub.onlineDeviceIds()]
      json(res, 200, {
        ok: true,
        loopback,
        publicBase: await getPublicBase(),
        edge: getEdgeStatus(),
        tunnel: tunnelSummary(),
        devices: { total: active.length, online: active.filter((entry) => online.includes(entry.deviceId)).length },
        pendingApprovals: bridge.pendingCount(),
        alwaysRules: always.list().length,
        timeout: { local: config.approvalTimeoutMs, remote: config.approvalTimeoutRemoteMs },
        alwaysScope: config.alwaysScope,
        maxDevices: config.maxDevices,
        clientHalf: deps.clientHello.count,
      })
      return
    }

    // ---- 状态（loopback only） ----
    if (route === '/status' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      json(res, 200, {
        ok: true,
        publicBase: await getPublicBase(),
        edge: getEdgeStatus(),
        tunnel: tunnel?.status?.(),
        devices: pairing.listDevices(),
        online: [...hub.onlineDeviceIds()],
        pending: bridge.pending(),
        rules: always.list(),
        clientHalf: deps.clientHello,
        config: {
          approvalTimeoutMs: config.approvalTimeoutMs,
          approvalTimeoutRemoteMs: config.approvalTimeoutRemoteMs,
          alwaysScope: config.alwaysScope,
          maxDevices: config.maxDevices,
        },
      })
      return
    }

    // ---- 设备列表（桌面管理用；loopback only，永不下发 tokenHash） ----
    if (route === '/devices.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      json(res, 200, {
        ok: true,
        devices: pairing.listDevices(),
        online: [...hub.onlineDeviceIds()],
        maxDevices: config.maxDevices,
        now: Date.now(),
      })
      return
    }

    // ---- 撤销设备 / 规则（loopback only） ----
    if (route === '/devices/revoke' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = await readJsonBody(req)
      const ok = pairing.revoke(payload.deviceId)
      const closed = ok ? hub.disconnectDevice(payload.deviceId) : 0
      json(res, 200, { ok, closed })
      return
    }
    if (route === '/devices/revoke-all' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      await readJsonBody(req)
      const count = pairing.revokeAll()
      const closed = hub.disconnectAll()
      json(res, 200, { ok: true, revoked: count, closed })
      return
    }
    if (route === '/devices/purge' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      json(res, 200, { ok: true, purged: pairing.purgeRevoked() })
      return
    }
    if (route === '/rules/revoke' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = JSON.parse((await readBody(req)) || '{}')
      json(res, 200, { ok: always.revoke(payload.ruleId) })
      return
    }

    // ---- Tailscale 一键接入（桌面专属：loopback only） ----
    if (route === '/tailscale.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const status = await tailscaleStatus()
      json(res, 200, { ok: true, ...status, edgePort: config.edgePort, publicBase: await getPublicBase() })
      return
    }
    if (route === '/tailscale/action' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = await readJsonBody(req)
      const action = String(payload.action ?? '')
      let result
      if (action === 'install') result = await tailscaleInstall()
      else if (action === 'login') result = await tailscaleLogin()
      else if (action === 'funnel') result = await tailscaleEnableFunnel(config.edgePort)
      else if (action === 'funnel-off') result = await tailscaleDisableFunnel()
      else result = { ok: false, error: 'unknown-action' }
      json(res, 200, result)
      return
    }
    if (route === '/tailscale/pin' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = await readJsonBody(req)
      const url = typeof payload.publicBase === 'string' ? payload.publicBase.trim().replace(/\/+$/, '') : ''
      if (/^https?:\/\/[^\s]+$/.test(url) !== true) {
        json(res, 400, { ok: false, error: 'bad-url' })
        return
      }
      // 持久化到本地 tunnel.json（不进仓库），并立即应用到运行中的 config。
      try {
        const file = path.join(store.dir, 'tunnel.json')
        let local = {}
        try {
          local = JSON.parse(fs.readFileSync(file, 'utf8'))
          if (local === null || typeof local !== 'object') local = {}
        } catch {
          local = {}
        }
        local.publicBase = url
        fs.writeFileSync(file, JSON.stringify(local, null, 2), { mode: 0o600 })
      } catch {
        /* 落盘失败不影响立即生效 */
      }
      if (typeof setPublicBase === 'function') setPublicBase(url)
      json(res, 200, { ok: true, publicBase: url })
      return
    }

    // ---- Cloudflare 命名隧道（固定域名）一键接入（桌面 loopback only） ----
    if (route === '/cloudflare.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const file = readTunnelFile(store.dir)
      const cf = await detectCloudflared(config.tunnelBin || 'cloudflared')
      const pub = await getPublicBase()
      const reachable = await probePublic(pub)
      const service = await cloudflaredServiceStatus(config.tunnelBin || 'cloudflared')
      json(res, 200, {
        ok: true,
        cloudflaredInstalled: cf.installed,
        version: cf.version,
        mode: config.tunnelMode,
        publicBase: pub,
        hasToken: typeof file.token === 'string' && file.token.trim() !== '',
        configuredPublicBase: typeof file.publicBase === 'string' ? file.publicBase : undefined,
        reachable,
        serviceManaged: file.serviceManaged === true,
        serviceInstalled: service.installed,
        serviceRunning: service.running,
      })
      return
    }
    if (route === '/cloudflare/setup' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = await readJsonBody(req)
      const valid = validateCloudflareSetup(payload)
      if (valid.ok !== true) {
        json(res, 400, { ok: false, error: valid.error })
        return
      }
      const file = readTunnelFile(store.dir)
      file.token = valid.token
      file.publicBase = valid.publicBase
      // 切到 Cloudflare 命名隧道时清掉 SakuraFrp 的模式标记，避免重启后被误恢复为 sakura。
      delete file.mode
      writeTunnelFile(store.dir, file)
      config.tunnelToken = valid.token
      config.publicBase = valid.publicBase
      config.tunnelMode = 'token'
      config.tunnelEnabled = true
      if (typeof setPublicBase === 'function') setPublicBase(valid.publicBase)
      if (typeof rebuildTunnel === 'function') await rebuildTunnel()
      const reachable = await probePublic(valid.publicBase)
      json(res, 200, { ok: true, publicBase: valid.publicBase, reachable })
      return
    }
    if (route === '/cloudflare/clear' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const file = readTunnelFile(store.dir)
      delete file.token
      delete file.publicBase
      writeTunnelFile(store.dir, file)
      config.tunnelToken = ''
      config.publicBase = ''
      config.tunnelMode = 'quick'
      config.tunnelEnabled = true
      if (typeof setPublicBase === 'function') setPublicBase('')
      if (typeof rebuildTunnel === 'function') await rebuildTunnel()
      json(res, 200, { ok: true })
      return
    }
    if (route === '/cloudflare/service-install' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = await readJsonBody(req)
      const file = readTunnelFile(store.dir)
      const token =
        typeof payload.token === 'string' && payload.token.trim() !== ''
          ? payload.token.trim()
          : typeof file.token === 'string'
            ? file.token.trim()
            : ''
      const publicBase =
        typeof payload.publicBase === 'string' && payload.publicBase.trim() !== ''
          ? payload.publicBase.trim().replace(/\/+$/, '')
          : typeof file.publicBase === 'string'
            ? file.publicBase.trim()
            : ''
      if (token.length < 20) {
        json(res, 400, { ok: false, error: 'token-too-short' })
        return
      }
      if (/^https:\/\/[^\s]+$/i.test(publicBase) !== true) {
        json(res, 400, { ok: false, error: 'publicBase-must-be-https' })
        return
      }
      // 先安装系统服务（需管理员权限）；失败则回退为插件托管 token 隧道，不让用户断线。
      const installed = await cloudflaredServiceInstall(token, config.tunnelBin || 'cloudflared')
      if (installed.ok !== true) {
        file.token = token
        file.publicBase = publicBase
        file.serviceManaged = false
        writeTunnelFile(store.dir, file)
        config.tunnelToken = token
        config.publicBase = publicBase
        config.tunnelMode = 'token'
        config.tunnelEnabled = true
        if (typeof setPublicBase === 'function') setPublicBase(publicBase)
        if (typeof rebuildTunnel === 'function') await rebuildTunnel()
        json(res, 200, {
          ok: false,
          error: installed.needsAdmin === true ? 'needs-admin' : 'service-install-failed',
          output: installed.output,
          fallback: 'plugin-managed-token-tunnel',
        })
        return
      }
      // 服务安装成功：隧道交给系统服务托管（开机常驻，与 Desktop 生命周期解耦）。
      file.token = token
      file.publicBase = publicBase
      file.serviceManaged = true
      writeTunnelFile(store.dir, file)
      config.tunnelToken = token
      config.publicBase = publicBase
      config.tunnelMode = 'token'
      config.tunnelEnabled = false
      if (typeof setPublicBase === 'function') setPublicBase(publicBase)
      try {
        await tunnel.stop()
      } catch {
        /* ignore */
      }
      const service = await cloudflaredServiceStatus(config.tunnelBin || 'cloudflared')
      json(res, 200, { ok: true, publicBase, service })
      return
    }
    if (route === '/cloudflare/service-uninstall' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const un = await cloudflaredServiceUninstall(config.tunnelBin || 'cloudflared')
      const file = readTunnelFile(store.dir)
      file.serviceManaged = false
      writeTunnelFile(store.dir, file)
      // 恢复由插件托管 token 隧道（若已配置 token+域名）。
      if (typeof file.token === 'string' && file.token.trim() !== '' && typeof file.publicBase === 'string' && /^https/i.test(file.publicBase)) {
        config.tunnelToken = file.token
        config.publicBase = file.publicBase
        config.tunnelMode = 'token'
        config.tunnelEnabled = true
        if (typeof setPublicBase === 'function') setPublicBase(file.publicBase)
        if (typeof rebuildTunnel === 'function') await rebuildTunnel()
      }
      json(res, 200, { ok: un.ok, output: un.output })
      return
    }

    // ---- SakuraFrp 免费穿透（国内推荐；全部 loopback only） ----
    if (route === '/sakura.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const file = readTunnelFile(store.dir)
      const sakura = file.sakura !== null && typeof file.sakura === 'object' ? file.sakura : {}
      const frpc = await detectSakuraBin(config.sakuraBin || 'frpc')
      const pub = await getPublicBase()
      const state = tunnel?.status?.()
      json(res, 200, {
        ok: true,
        frpcInstalled: frpc.installed,
        version: frpc.version ?? '',
        mode: config.tunnelMode,
        publicBase: pub,
        hasKey: typeof sakura.token === 'string' && sakura.token.trim() !== '',
        hasTunnelId: typeof sakura.tunnelId === 'string' && sakura.tunnelId.trim() !== '',
        tunnelId: typeof sakura.tunnelId === 'string' ? sakura.tunnelId : '',
        customDomain: typeof sakura.domain === 'string' ? sakura.domain : '',
        running: state?.running === true,
        url: state?.url ?? '',
        lastError: state?.lastError ?? '',
        reachable: await probeIfPublic(pub),
      })
      return
    }
    if (route === '/sakura/setup' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (typeof rebuildTunnel !== 'function') {
        json(res, 503, { ok: false, error: 'rebuild-unavailable' })
        return
      }
      const payload = await readJsonBody(req)
      const token = typeof payload.token === 'string' ? payload.token.trim() : ''
      const tunnelId = typeof payload.tunnelId === 'string' ? payload.tunnelId.trim() : ''
      const choice = payload.domainChoice === 'custom' ? 'custom' : 'auto'
      let domain = typeof payload.domain === 'string' ? payload.domain.trim().replace(/\/+$/, '') : ''
      if (token === '') {
        json(res, 400, { ok: false, error: 'sakura-token-required' })
        return
      }
      if (tunnelId === '') {
        json(res, 400, { ok: false, error: 'sakura-tunnelid-required' })
        return
      }
      if (choice === 'custom') {
        if (/^https?:\/\/[^\s]+$/i.test(domain) !== true) {
          json(res, 400, { ok: false, error: 'sakura-domain-invalid' })
          return
        }
      } else {
        domain = ''
      }
      // 向后兼容：只增删 sakura 键，保留 cloudflare 的 token/publicBase/serviceManaged。
      // file.mode 记录用户在设置页显式选择的隧道模式，供插件重启后恢复（否则会被 token+publicBase 推断覆盖）。
      const file = readTunnelFile(store.dir)
      file.sakura = { token, tunnelId, domain }
      file.mode = 'sakura'
      writeTunnelFile(store.dir, file)
      config.sakuraToken = token
      config.sakuraTunnelId = tunnelId
      config.sakuraDomain = domain
      config.tunnelMode = 'sakura'
      config.tunnelEnabled = true
      // auto 模式清空 publicBase，让 resolvePublicBase 采用 frpc 上报的随机子域。
      config.publicBase = domain
      if (typeof setPublicBase === 'function') setPublicBase(domain)
      await rebuildTunnel()
      const pub = await getPublicBase()
      json(res, 200, { ok: true, publicBase: pub, reachable: await probeIfPublic(pub) })
      return
    }
    if (route === '/sakura/clear' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (typeof rebuildTunnel !== 'function') {
        json(res, 503, { ok: false, error: 'rebuild-unavailable' })
        return
      }
      const file = readTunnelFile(store.dir)
      delete file.sakura
      delete file.mode
      writeTunnelFile(store.dir, file)
      config.sakuraToken = ''
      config.sakuraTunnelId = ''
      config.sakuraDomain = ''
      config.tunnelMode = 'quick'
      config.tunnelEnabled = true
      config.publicBase = ''
      if (typeof setPublicBase === 'function') setPublicBase('')
      await rebuildTunnel()
      json(res, 200, { ok: true })
      return
    }

    // ---- PWA：manifest 与图标（同源经 edge 分发；图标不可变，长缓存） ----
    if (route === '/manifest.webmanifest' && method === 'GET') {
      bytes(res, 200, Buffer.from(manifestJson(BASE), 'utf8'), 'application/manifest+json; charset=utf-8', 'no-cache')
      return
    }
    // ---- 外部推送通道：审批卡出现时本机 POST 到已配置通道（不依赖浏览器）。 ----
    // 通知调度器未装配（异常安装）时统一按 not-ready 拒绝。
    if (notify === undefined) {
      json(res, 503, { ok: false, error: 'notify-unavailable' })
      return
    }
    // 外部通道读写：仅桌面本机（通道 webhook 等价于把通知权交出去）。
    if (route === '/push/channel.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'desktop-only' })
        return
      }
      // presets 带全元数据（label/hint/fields/steps），客户端直接渲染配置向导。
      const presets = Object.entries(CHANNELS).map(([name, preset]) => ({
        name,
        label: preset.label,
        hint: preset.hint,
        fields: preset.fields,
        steps: preset.steps ?? [],
      }))
      json(res, 200, { ok: true, channels: notify?.getChannels?.() ?? {}, presets })
      return
    }
    if (route === '/push/channel.json' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'desktop-only' })
        return
      }
      const body = await readJsonBody(req)
      const channel = String(body.channel ?? '')
      if (CHANNELS[channel] === undefined) {
        json(res, 400, { ok: false, error: 'unknown-channel' })
        return
      }
      json(res, 200, notify.setChannel(channel, body.fields ?? {}, body.enabled !== false))
      return
    }
    if (method === 'GET') {
      const iconMatch = route.match(/^\/icon-(192|512)\.png$/)
      if (iconMatch !== null) {
        bytes(res, 200, iconPng(Number(iconMatch[1])), 'image/png', 'public, max-age=604800, immutable')
        return
      }
      if (route === '/apple-touch-icon.png') {
        bytes(res, 200, iconPng(180, { square: true }), 'image/png', 'public, max-age=604800, immutable')
        return
      }
    }

    json(res, 404, { ok: false, error: 'not-found' })
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
  return { dispose, handler }
}

export { BASE as ROUTE_BASE, DEVICE_COOKIE }
