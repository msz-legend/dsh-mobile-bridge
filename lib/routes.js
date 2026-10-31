/**
 * 插件 HTTP 路由：挂在宿主 webServer 的 `/plugins/dsh-mobile-bridge` 前缀下。
 *
 * 为什么挂在宿主而不是 edge：桌面页面（127.0.0.1:56915）也要能读配对信息、
 * 也要能显示审批卡片；挂在宿主上，桌面是 loopback 直连、手机经 edge 反代，
 * 两边共用同一套路由，不需要 CORS，也不需要第二个鉴权面。
 */
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

function pairPage({ publicBase, code, remainingMs, error }) {
  const target = `${publicBase}/plugins/dsh-mobile-bridge/pair`
  const minutes = Math.max(0, Math.floor(remainingMs / 60000))
  const seconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000))
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>配对手机 · DSH Mobile Bridge</title>
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
img.qr{display:block;width:100%;max-width:260px;margin:0 auto;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box}
a{color:#7dd3fc;font-size:12px}
</style></head>
<body><div class="card">
<h1>配对手机</h1>
<p>用手机扫描二维码，或打开地址后输入配对码。</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
${code ? `<div class="code">${escapeHtml(code)}</div>` : '<div class="err">配对码已过期，刷新页面获取新的。</div>'}
<div class="addr">${escapeHtml(target.replace(/\/pair$/, '/'))}</div>
<div class="expire">剩余有效期 ${minutes}:${String(seconds).padStart(2, '0')}</div>
<form method="post" action="${BASE}/pair">
  <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="配对码" maxlength="8">
  <input name="name" placeholder="设备名（可选）" maxlength="48" style="letter-spacing:normal;font-size:14px">
  <button type="submit">配对</button>
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

export function registerRoutes(ctx, deps) {
  const { config, pairing, hub, bridge, always, store, log, getPublicBase, getLaunchUrl, getEdgeStatus } = deps

  const deviceOf = (req) => {
    const cookies = parseCookies(req.headers.cookie)
    return pairing.authenticate(cookies[DEVICE_COOKIE])
  }

  const requireLoopback = (req) => isLoopback(req.socket.remoteAddress)

  const dshCoveredUrl = async () => {
    const launch = getLaunchUrl()
    if (launch === undefined) return undefined
    try {
      const response = await fetch(launch, { redirect: 'manual' })
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean)
      return cookies
    } catch (error) {
      log('dsh login exchange failed:', error?.message ?? error)
      return undefined
    }
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
      const page = pairPage({
        publicBase,
        code: active?.code,
        remainingMs: active?.remainingMs ?? 0,
        error: search.get('error') ?? undefined,
      })
      const withQr = qr === undefined ? page : page.replace('<p>用手机扫描二维码', `<img class="qr" alt="配对二维码" src="${qr}"><p>用手机扫描二维码`)
      html(res, 200, withQr)
      return
    }

    // ---- 配对提交 ----
    if (route === '/pair' && method === 'POST') {
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
          error: `配对失败（${result.reason}）`,
        }))
        return
      }
      const device = pairing.issueDevice(payload.name)
      if (device === undefined) {
        html(res, 429, pairPage({
          publicBase: await getPublicBase(),
          code: undefined,
          remainingMs: 0,
          error: `已达到设备上限（${config.maxDevices}），请先在桌面端撤销旧设备。`,
        }))
        return
      }
      const cookies = await dshCoveredUrl()
      const secure = (await getPublicBase()).startsWith('https:')
      const setCookies = [
        `${DEVICE_COOKIE}=${device.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
        ...(cookies ?? []),
      ]
      res.writeHead(303, { location: '/', 'set-cookie': setCookies })
      res.end()
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
      hub.add(res, device)
      res.write(`data: ${JSON.stringify({ type: 'hello', pendingApprovals: bridge.pendingCount() })}\n\n`)
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

    // ---- 撤销设备 / 规则（loopback only） ----
    if (route === '/devices/revoke' && method === 'POST') {
      if (!requireLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const payload = JSON.parse((await readBody(req)) || '{}')
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
      const count = pairing.revokeAll()
      const closed = hub.disconnectAll()
      json(res, 200, { ok: true, revoked: count, closed })
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

    json(res, 404, { ok: false, error: 'not-found' })
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
  return { dispose, handler }
}

export { BASE as ROUTE_BASE, DEVICE_COOKIE }
