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
import { serviceWorkerScript } from './notify.js'
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

/** DMB-013：verifyCode 的内部 reason → locale 文案键（不再暴露 no-code 等记号）。 */
const pairErrorText = (locale, reason) => {
  const t = LOCALE[locale] ?? LOCALE.zh
  if (reason === 'no-code') return t.pair.noCode
  if (reason === 'too-many-attempts') return t.pair.tooMany
  if (reason === 'mismatch') return t.pair.mismatch
  return `${locale === 'en' ? 'Pairing failed' : '配对失败'}（${reason}）`
}

function pairPage({ publicBase, code, remainingMs, error, locale = 'zh' }) {
  const t = (LOCALE[locale] ?? LOCALE.zh).pair
  const target = `${publicBase}/plugins/dsh-mobile-bridge/pair`
  const minutes = Math.max(0, Math.floor(remainingMs / 60000))
  const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000))
  const hasCode = typeof code === 'string' && code !== ''
  // DMB-013：无有效码时展示引导文案 + 隐藏倒计时（不再出现「剩余 0:00」矛盾态）。
  const expireLine = hasCode
    ? `<div class="expire">${escapeHtml(t.expires)} ${minutes}:${String(seconds).padStart(2, '0')}</div>`
    : ''
  const noCodeBox = hasCode ? '' : `<div class="err warn">${escapeHtml(t.noCode)}</div>`
  const lang = locale === 'en' ? 'en' : 'zh-CN'
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(t.title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  background:#0f172a;color:#e2e8f0;padding:24px;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
.card{width:100%;max-width:360px;background:#111c33;border:1px solid #24324f;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{margin:0 0 4px;font-size:18px}
p{margin:0 0 16px;color:#94a3b8;font-size:13px}
.code{font:600 34px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.32em;text-align:center;
  padding:14px 6px;background:#0b1424;border:1px dashed #334a72;border-radius:12px;color:#7dd3fc;margin:14px 0}
.addr{word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace;color:#93c5fd;background:#0b1424;padding:8px 10px;border-radius:10px}
.expire{text-align:center;color:#fbbf24;font-size:12px;margin-top:10px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #33415c;background:#0b1424;color:#e2e8f0;font-size:17px;letter-spacing:.2em;text-align:center;margin:10px 0}
button{width:100%;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;font-weight:600}
button:disabled{opacity:.5}
.err{background:#7f1d1d;color:#fecaca;border-radius:10px;padding:10px;font-size:13px;margin-bottom:12px}
/* DMB-013：无码引导用琥珀色（信息而非错误），与真正的错误区分。 */
.err.warn{background:#3a2a10;color:#fcd34d;border:1px solid #92650e}
img.qr{display:block;width:100%;max-width:260px;margin:0 auto;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box}
a{color:#7dd3fc;font-size:12px}
</style></head>
<body><div class="card">
<h1>${escapeHtml(t.h1)}</h1>
<p>${escapeHtml(t.hint)}</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
${hasCode ? `<div class="code">${escapeHtml(code)}</div>` : noCodeBox}
<div class="addr">${escapeHtml(target.replace(/\/pair$/, '/'))}</div>
${expireLine}
<form method="post" action="${BASE}/pair">
  <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeHtml(t.code)}" maxlength="8">
  <input name="name" placeholder="${escapeHtml(t.name)}" maxlength="48" style="letter-spacing:normal;font-size:14px">
  <button type="submit">${escapeHtml(t.submit)}</button>
</form>
</div>
<script>
(function(){
  var code=(location.hash||'').replace('#','').trim();
  var input=document.querySelector('input[name=code]');
  if(code&&input){input.value=code;input.form&&input.form.requestSubmit&&input.form.requestSubmit();}
})();
</script>
</body></html>`
}

/** 公网/LAN 配对提交后的「等待桌面确认」页：轮询 /pair/state 直到桌面决策。 */
function confirmWaitPage({ confirmId, name, locale = 'zh' }) {
  const pack = LOCALE[locale] ?? LOCALE.zh
  const t = pack.pair.wait
  const lang = locale === 'en' ? 'en' : 'zh-CN'
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(t.title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  background:#0f172a;color:#e2e8f0;padding:24px}
.card{width:100%;max-width:360px;background:#111c33;border:1px solid #24324f;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{margin:0 0 8px;font-size:18px}
p{margin:0;color:#94a3b8;font-size:13px}
.name{margin:14px 0;font-size:15px;color:#7dd3fc;background:#0b1424;border:1px solid #334a72;border-radius:10px;padding:10px;text-align:center}
.state{margin-top:14px;text-align:center;color:#fbbf24;font-size:13px;min-height:20px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;margin-right:6px;animation:p 1.2s infinite alternate}
@keyframes p{from{opacity:.3}to{opacity:1}}
</style></head>
<body><div class="card">
<h1>${escapeHtml(t.h1)}</h1>
<p>${escapeHtml(t.p)}</p>
<div class="name"></div>
<div class="state"><span class="dot"></span>${escapeHtml(t.waiting)}</div>
</div>
<script>
(function(){
  var id=${JSON.stringify(String(confirmId ?? ''))};
  document.querySelector('.name').textContent=${JSON.stringify(String(name ?? 'phone'))};
  var state=document.querySelector('.state');
  var TEXT={enter:${JSON.stringify(t.entering)},denied:${JSON.stringify(t.denied)},limit:${JSON.stringify(t.limit)},expired:${JSON.stringify(t.expired)}};
  var done=false;
  var timer=setInterval(function(){
    if(done)return;
    fetch(${JSON.stringify(BASE)}+'/pair/state?confirmId='+encodeURIComponent(id),{credentials:'same-origin'})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j)return;
        if(j.ok===true){done=true;clearInterval(timer);state.textContent=TEXT.enter;location.href='/';return;}
        if(j.state==='denied'){done=true;clearInterval(timer);state.textContent=TEXT.denied;return;}
        if(j.state==='limit'){done=true;clearInterval(timer);state.textContent=TEXT.limit;return;}
        if(j.state==='expired'||j.state==='unknown'){done=true;clearInterval(timer);state.textContent=TEXT.expired;return;}
      }).catch(function(){});
  },2500);
})();
</script>
</body></html>`
}

/** 轻量滑动窗口限速：/pair/state 轮询兜底用（edge 限速器管不到挂在宿主上的这条路由）。 */
function createPollLimiter({ perMinute = 60 } = {}) {
  const hits = new Map()
  return (key) => {
    const nowMs = Date.now()
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
  const { config, pairing, hub, bridge, always, store, log, getPublicBase, getLaunchUrl, getEdgeStatus, tunnel, hostLogin, setPublicBase, restartTunnel, notify } = deps

  const deviceOf = (req) => {
    const cookies = parseCookies(req.headers.cookie)
    return pairing.authenticate(cookies[DEVICE_COOKIE])
  }

  const pollLimiter = createPollLimiter()

  /**
   * 「真的来自本机」判定。
   *
   * 不能只看 socket 地址：edge 反代回源时源地址就是 127.0.0.1，若不区分，
   * 任何经 edge 进来的手机都会被当成桌面本机，从而拿到配对码、设备列表、
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

    // ---- 配对页（未配对可达，靠 edge 限速） ----
    if (route === '/pair' && method === 'GET') {
      const existing = pairing.current()
      const publicBase = await getPublicBase()
      if (existing === undefined && requireLoopback(req)) pairing.issueCode()
      const active = existing ?? (requireLoopback(req) ? pairing.current() : undefined)
      const qr = active === undefined ? undefined : await qrDataUrl(`${publicBase}${BASE}/pair#${active.code}`)
      const locale = pickLocale(req)
      const page = pairPage({
        publicBase,
        code: active?.code,
        remainingMs: active?.remainingMs ?? 0,
        error: search.get('error') ?? undefined,
        locale,
      })
      const withQr = qr === undefined ? page : page.replace('<p>', `<img class="qr" alt="${escapeHtml((LOCALE[locale] ?? LOCALE.zh).pair.qrAlt)}" src="${qr}"><p>`)
      html(res, 200, withQr)
      return
    }

    // ---- 配对提交 ----
    if (route === '/pair' && method === 'POST') {
      const locale = pickLocale(req)
      const body = await readBody(req)
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        for (const [key, value] of new URLSearchParams(body)) payload[key] = value
      }
      const result = pairing.verifyCode(payload.code)
      if (result.ok !== true) {
        html(res, 403, pairPage({
          publicBase: await getPublicBase(),
          code: undefined,
          remainingMs: 0,
          error: pairErrorText(locale, result.reason),
          locale,
        }))
        return
      }
      // 非 loopback 来源（手机经 edge：LAN / 隧道）：码只证明「看到了桌面屏幕」，
      // 还需桌面点击确认才算配对成功（对齐 Cloud Link 的桌面确认语义）。
      // autoApprovePairing 开启时跳过桌面确认直接发设备（用户明确要求免弹窗自动通过）。
      // 等待页被刷新/重放时会带着同一个码再次提交 —— 幂等复用待确认请求，不再 409 卡死。
      if (!requireLoopback(req) && config.autoApprovePairing !== true) {
        const existing = pairing.pendingConfirm()
        const staged =
          existing === undefined
            ? pairing.stageConfirm(payload.name, req.headers['x-dmb-forwarded-for'])
            : {
                confirmId: existing.confirmId,
                name: existing.name,
                source: existing.source,
                expiresAt: existing.expiresAt,
              }
        if (staged === undefined) {
          html(res, 409, pairPage({
            publicBase: await getPublicBase(),
            code: undefined,
            remainingMs: 0,
            error: (LOCALE[locale] ?? LOCALE.zh).pair.busy,
            locale,
          }))
          return
        }
        if (existing === undefined) {
          hub.broadcastLoopback({
            type: 'pair-request',
            confirmId: staged.confirmId,
            name: staged.name,
            source: staged.source,
            expiresAt: staged.expiresAt,
          })
          // 全局通知（L2/L3）：配对确认也推给手机/外部通道，人在外面也能放行新设备。
          if (notify !== undefined && typeof notify.dispatch === 'function') {
            void notify.dispatch({ title: '配对请求', body: `设备「${staged.name}」请求接入`, path: '/' })
          }
        }
        html(res, 200, confirmWaitPage({ confirmId: staged.confirmId, name: staged.name, locale }))
        return
      }
      const device = pairing.issueDevice(payload.name)
      if (device === undefined) {
        const limitText = ((LOCALE[locale] ?? LOCALE.zh).pair.limit ?? '').replace('{max}', String(config.maxDevices))
        html(res, 429, pairPage({
          publicBase: await getPublicBase(),
          code: undefined,
          remainingMs: 0,
          error: limitText,
          locale,
        }))
        return
      }
      if (!requireLoopback(req) && config.autoApprovePairing === true) {
        log(`pairing auto-approved for "${payload.name ?? 'phone'}" from ${req.headers['x-dmb-forwarded-for'] ?? 'unknown'}`)
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

    // ---- 配对确认轮询（手机等待页调用；决策结果在此以 Set-Cookie 交付） ----
    if (route === '/pair/state' && method === 'GET') {
      if (!pollLimiter(pollKeyOf(req))) {
        json(res, 429, { ok: false, state: 'slow-down' })
        return
      }
      const confirmId = search.get('confirmId') ?? ''
      const outcome = pairing.pollConfirm(confirmId)
      if (outcome.ok !== true) {
        json(res, 200, { ok: false, state: outcome.state })
        return
      }
      const cookies = await dshCoveredUrl()
      const secure = await shouldSecureCookie(req)
      const setCookies = [
        `${DEVICE_COOKIE}=${outcome.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
        ...(cookies ?? []),
      ]
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': setCookies,
      })
      res.end(JSON.stringify({ ok: true, redirect: '/' }))
      return
    }

    // ---- 配对信息（仅供桌面/loopback 读取，避免局域网内他人拿到码） ----
    if (route === '/pairing.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (pairing.current() === undefined) pairing.issueCode()
      const active = pairing.current()
      const publicBase = await getPublicBase()
      const qr = active === undefined ? undefined : await qrDataUrl(`${publicBase}${BASE}/pair#${active.code}`)
      json(res, 200, {
        ok: true,
        publicBase,
        pairUrl: `${publicBase}${BASE}/pair`,
        code: active?.code,
        expiresAt: active?.expiresAt,
        remainingMs: active?.remainingMs,
        pendingConfirm: pairing.pendingConfirm(),
        qrDataUrl: qr,
      })
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
        pendingConfirm: pairing.pendingConfirm(),
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

    // ---- 配对确认决策（桌面专属：同意/拒绝非 loopback 来源的配对请求） ----
    if (route === '/devices/confirm' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = JSON.parse((await readBody(req)) || '{}')
      const result = pairing.resolveConfirm(payload.confirmId, payload.decision === 'allow')
      hub.broadcastLoopback({ type: 'pair-request-resolved', confirmId: String(payload.confirmId ?? '') })
      json(res, result.ok ? 200 : 409, result)
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
      writeTunnelFile(store.dir, file)
      config.tunnelToken = valid.token
      config.publicBase = valid.publicBase
      config.tunnelMode = 'token'
      config.tunnelEnabled = true
      if (typeof setPublicBase === 'function') setPublicBase(valid.publicBase)
      if (typeof restartTunnel === 'function') await restartTunnel()
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
      if (typeof restartTunnel === 'function') await restartTunnel()
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
        if (typeof restartTunnel === 'function') await restartTunnel()
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
        if (typeof restartTunnel === 'function') await restartTunnel()
      }
      json(res, 200, { ok: un.ok, output: un.output })
      return
    }

    // ---- PWA：manifest 与图标（同源经 edge 分发；图标不可变，长缓存） ----
    if (route === '/manifest.webmanifest' && method === 'GET') {
      bytes(res, 200, Buffer.from(manifestJson(BASE), 'utf8'), 'application/manifest+json; charset=utf-8', 'no-cache')
      return
    }
    // ---- 审批系统通知的 Service Worker（Android Chrome 禁止页面直接 new Notification，
    //      必须经 SW showNotification；点击通知聚焦已开的桥接页。不缓存任何资源。）
    //      桥接页面挂在根路径而本文件在插件前缀下，默认 scope 只覆盖插件前缀；
    //      Service-Worker-Allowed: / 允许页面以 scope '/' 注册，控制根页面。 ----
    if (route === '/sw.js' && method === 'GET') {
      const body = Buffer.from(serviceWorkerScript('/'), 'utf8')
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': body.length,
        'service-worker-allowed': '/',
      })
      res.end(body)
      return
    }

    // ---- 全局通知：Web Push (L2) + 外部通道 (L3)。手机端/设置面板调用。 ----
    // 通知调度器未装配（异常安装）时统一按 not-ready 拒绝。
    if (notify === undefined) {
      json(res, 503, { ok: false, error: 'notify-unavailable' })
      return
    }
    // VAPID 公钥：订阅时 client 需要它做 applicationServerKey。
    if (route === '/push/vapid.json' && method === 'GET') {
      json(res, 200, { ok: true, publicKey: notify?.vapidPublicKey ?? '' })
      return
    }
    // 登记订阅：body = PushSubscription JSON。仅已配对设备可写。
    if (route === '/push/subscribe.json' && method === 'POST') {
      const device = deviceOf(req)
      if (device === undefined) {
        json(res, 401, { ok: false, error: 'unpaired' })
        return
      }
      const body = await readJsonBody(req)
      const subscription = body.subscription
      if (
        subscription === null ||
        typeof subscription !== 'object' ||
        typeof subscription.endpoint !== 'string' ||
        subscription.keys === null ||
        typeof subscription.keys !== 'object' ||
        typeof subscription.keys.p256dh !== 'string' ||
        typeof subscription.keys.auth !== 'string'
      ) {
        json(res, 400, { ok: false, error: 'bad-subscription' })
        return
      }
      json(res, 200, notify.subscribe(subscription))
      return
    }
    // 退订（关开关/换浏览器时清理）。
    if (route === '/push/unsubscribe.json' && method === 'POST') {
      const device = deviceOf(req)
      if (device === undefined) {
        json(res, 401, { ok: false, error: 'unpaired' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body.endpoint !== 'string' || body.endpoint === '') {
        json(res, 400, { ok: false, error: 'bad-endpoint' })
        return
      }
      json(res, 200, notify.unsubscribe(body.endpoint))
      return
    }
    // 外部通道读写：仅桌面本机（通道 webtoken 等价于把通知权交出去）。
    if (route === '/push/channel.json' && method === 'GET') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'desktop-only' })
        return
      }
      // presets 带全元数据，客户端直接渲染，不必硬编码通道清单。
      const presets = Object.entries(CHANNELS).map(([name, preset]) => ({
        name,
        label: preset.label,
        hint: preset.hint,
        fields: preset.fields,
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
