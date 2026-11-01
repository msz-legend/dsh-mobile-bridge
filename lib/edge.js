/**
 * 边缘网关：手机唯一入口。
 *
 * 职责：
 *   1. 设备令牌闸门（未配对一律拒绝，不把请求转给宿主）；
 *   2. 反向代理到 DSH 自己的 webServer，并把 Host/Origin 改写成 loopback；
 *   3. 透传 WebSocket 升级（`/api/remote.mux` 是流式输出的唯一通道，必须透传）；
 *   4. 配对接口的按 IP 限速与防爆破；
 *   5. 观察 `POST /api/session/create` 的响应，登记「远程发起」会话；
 *   6. 公网档加固：安全响应头（nosniff / no-referrer / 同源内嵌限制），
 *      经 cloudflared 隧道的访客按真实客户端 IP 独立限速。
 *
 * 为什么改写 Host/Origin 就能免配置：宿主 Connection 的信任围栏接受
 * loopback 的 Host，并要求 Origin 与之同 authority。我们把两者都改写成
 * `127.0.0.1:<port>` 后，既不需要 connection.trustedHosts，也不需要 publicUrl。
 *
 * 多地址监听：同一个 handler 可以绑多个具体地址（loopback + LAN）。
 * 这样桌面本机自测走 127.0.0.1，手机在局域网走 LAN IP，两者同时可用。
 */
import http from 'node:http'
import net from 'node:net'
import { URL } from 'node:url'
import { preferredLanAddress } from './tunnel.js'
import { mergeCookieHeader } from './host-login.js'

const PAIR_PREFIX = '/plugins/dsh-mobile-bridge/pair'
const DEVICE_COOKIE = 'dmb'

/**
 * 公网档安全响应头：覆盖 edge 自有响应与反代响应。
 * - nosniff / no-referrer：无副作用，纯收紧；
 * - SAMEORIGIN / frame-ancestors 'self'：只挡「别人嵌我们」，同源预览 iframe 不受影响；
 * - 不设 permissions-policy：宿主 UI 可能用到麦克风/剪贴板等能力（HTTPS 化后），不预关。
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'",
}

const withSecurityHeaders = (headers) => ({ ...headers, ...SECURITY_HEADERS })

const LOOPBACK_SOCKET = /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/
const PLAUSIBLE_IP = /^[0-9a-fA-F.:]+$/

/**
 * 限速键。
 *
 * 经 cloudflared 进来的流量源地址一律是 127.0.0.1（本机隧道进程回源），
 * 若按 socket 地址限速，全体公网访客共享一个桶：单个攻击者就能把配对接口
 * 熔断 10 分钟，等于变相 DoS。因此 loopback 回源时优先取 cloudflared 注入的
 * `cf-connecting-ip`（Cloudflare 边缘会剥掉客户端伪造的同名头）。
 * 直连场景（LAN/loopback）源地址本身可区分，不读该头，伪造无效。
 */
const limiterKeyOf = (req) => {
  const remote = req.socket.remoteAddress ?? 'unknown'
  if (LOOPBACK_SOCKET.test(remote)) {
    const forwarded = req.headers['cf-connecting-ip']
    if (typeof forwarded === 'string' && PLAUSIBLE_IP.test(forwarded.trim())) {
      return `cf:${forwarded.trim()}`
    }
  }
  return remote
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

/** 按 IP 滑动窗口限速 + 超限熔断。 */
function createLimiter({ perMinute, blockMsOnExceed, log }) {
  const hits = new Map()

  const allow = (address) => {
    const key = String(address ?? 'unknown')
    const now = Date.now()
    const record = hits.get(key) ?? { windowStart: now, count: 0, blockedUntil: 0 }
    if (record.blockedUntil > now) return false
    if (now - record.windowStart > 60_000) {
      record.windowStart = now
      record.count = 0
    }
    record.count += 1
    if (record.count > perMinute) {
      record.blockedUntil = now + blockMsOnExceed
      hits.set(key, record)
      log(`rate limit tripped for ${key}`)
      return false
    }
    hits.set(key, record)
    if (hits.size > 2000) {
      for (const [k, v] of hits) {
        if (v.blockedUntil < now && now - v.windowStart > 120_000) hits.delete(k)
      }
    }
    return true
  }

  return { allow }
}

export function createEdge({ config, log, pairing, hub, origins, hostLogin }) {
  const limiter = createLimiter({ perMinute: 20, blockMsOnExceed: 10 * 60_000, log })
  const servers = []

  const upstream = () => ({ host: '127.0.0.1', port: config.dshPort, authority: `127.0.0.1:${config.dshPort}` })

  /** 把外部请求头改写成 loopback authority，避免宿主 403。 */
  const rewriteHeaders = (rawHeaders, authority) => {
    const headers = {}
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]
      const value = rawHeaders[i + 1]
      const lower = String(name).toLowerCase()
      if (lower === 'host') {
        headers.host = authority
        continue
      }
      if (lower === 'origin') {
        headers.origin = `http://${authority}`
        continue
      }
      if (lower === 'referer') {
        headers.referer = `http://${authority}/`
        continue
      }
      if (lower === 'connection' || lower === 'proxy-connection' || lower === 'keep-alive') continue
      headers[lower] = value
    }
    return headers
  }

  const authenticate = (req) => {
    const cookies = parseCookies(req.headers.cookie)
    return pairing.authenticate(cookies[DEVICE_COOKIE])
  }

  /**
   * 观察「手机驱动的会话」并登记 remote 来源：
   *   1. 响应侧：POST /session/create|fork|prompt 的响应体里的 sessionId
   *      （手机从 home composer 发首条消息走 prompt 自动创建，不只是 create）；
   *   2. 请求侧：已配对设备 POST 请求体里出现的 sessionId —— 手机在继续
   *      一个桌面创建的会话时，该会话同样由手机驱动，离线兜底应 fail closed。
   * 误标方向是安全的：多标 remote 只会让兜底更保守（fail closed 而非交还桌面）。
   */
  const SESSION_CREATING = /\/session\/(?:create|fork|prompt)$/
  const SESSION_ID_IN_BODY = /"sessionId"\s*:\s*"([^"]{1,128})"/g

  const watchSessionOrigin = (pathname, method, res) => {
    if (method !== 'POST' || !SESSION_CREATING.test(pathname)) return
    const chunks = []
    let size = 0
    const originalWrite = res.write.bind(res)
    res.write = (chunk, encoding, callback) => {
      if (size < 64 * 1024 && chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? 'utf8')
        chunks.push(buffer)
        size += buffer.length
      }
      return originalWrite(chunk, encoding, callback)
    }
    res.on('finish', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        for (const match of text.matchAll(/"sessionId"\s*:\s*"([^"]+)"/g)) {
          origins.markRemote(match[1])
          log(`remote session registered: ${match[1]}`)
        }
      } catch {
        /* 观察失败不影响主流程 */
      }
    })
  }

  /** 请求侧登记：已配对设备 POST 请求体里的 sessionId 全部标记 remote。 */
  const markRemoteFromRequest = (body) => {
    if (body === undefined || body.length === 0 || body.length > 256 * 1024) return
    const text = body.toString('utf8')
    let count = 0
    for (const match of text.matchAll(SESSION_ID_IN_BODY)) {
      origins.markRemote(match[1])
      count += 1
      if (count >= 16) break
    }
  }

  const proxy = (req, res) => {
    const target = upstream()
    const headers = rewriteHeaders(req.rawHeaders ?? [], target.authority)
    headers['x-dmb-forwarded-for'] = req.socket.remoteAddress ?? ''
    const originalCookie = headers.cookie
    // 宿主模块表的 rev 不随插件内容变化，浏览器会长期缓存旧的 client 半身
    // （真机实测：升级后手机仍渲染旧卡片布局）。插件资源一律 no-cache。
    let pluginPath = false
    try {
      pluginPath = new URL(req.url ?? '/', 'http://placeholder').pathname.startsWith('/plugins/')
    } catch {
      pluginPath = false
    }

    // 缓冲请求体（上限 2MB）：宿主 401 重登后要带着原体重放。
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= 2 * 1024 * 1024) chunks.push(chunk)
      else overflow = true
    })
    req.on('end', () => {
      const body = overflow ? undefined : Buffer.concat(chunks)
      // 手机驱动指纹：请求体里出现的 sessionId 记为 remote（手机在继续该会话）
      if (body !== undefined && authenticate(req) !== undefined) markRemoteFromRequest(body)
      attempt(0, undefined, body)
    })

    const attempt = (count, reloginCookies, body) => {
      const upstreamRequest = http.request(
        { host: target.host, port: target.port, method: req.method, path: req.url, headers },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502
          // 宿主重启会让 owner cookie 全部失效：对已配对设备自动重新登录并重放一次。
          if (status === 401 && count < 1 && authenticate(req) !== undefined) {
            upstreamResponse.resume()
            log('host returned 401; re-authenticating paired device')
            Promise.resolve(hostLogin?.login?.(true))
              .then((cookies) => {
                if (Array.isArray(cookies) && cookies.length > 0) {
                  headers.cookie = mergeCookieHeader(originalCookie, cookies)
                  attempt(count + 1, cookies, body)
                  return
                }
                deliver(401, undefined, undefined)
              })
              .catch(() => deliver(401, undefined, undefined))
            return
          }
          deliver(status, reloginCookies, upstreamResponse)
        },
      )

      const deliver = (status, setCookies, upstreamResponse) => {
        const outHeaders =
          upstreamResponse === undefined
            ? { 'content-type': 'text/plain; charset=utf-8' }
            : { ...upstreamResponse.headers }
        if (pluginPath) outHeaders['cache-control'] = 'no-cache, max-age=0'
        if (Array.isArray(setCookies) && setCookies.length > 0) {
          const existing = outHeaders['set-cookie']
          outHeaders['set-cookie'] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), ...setCookies]
        }
        res.writeHead(status, withSecurityHeaders(outHeaders))
        if (upstreamResponse === undefined) {
          res.end('mobile-bridge: host session expired and re-authentication failed; reload the page')
          return
        }
        upstreamResponse.pipe(res)
      }

      upstreamRequest.on('error', (error) => {
        log('proxy error:', error?.message ?? error)
        if (!res.headersSent) deliver(502, undefined, undefined)
        else res.end()
      })

      if (body === undefined) upstreamRequest.end()
      else upstreamRequest.end(body)
    }
  }

  const proxyUpgrade = (req, socket, head) => {
    const target = upstream()
    const headers = rewriteHeaders(req.rawHeaders ?? [], target.authority)
    headers.connection = 'Upgrade'

    const upstreamSocket = net.connect(target.port, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })

    upstreamSocket.on('error', (error) => {
      log('upgrade proxy error:', error?.message ?? error)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })
    socket.on('error', () => {
      try {
        upstreamSocket.destroy()
      } catch {
        /* ignore */
      }
    })
  }

  const requestHandler = (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://placeholder').pathname
    } catch {
      pathname = '/'
    }

    const device = authenticate(req)

    // 配对入口：未配对也可达，但严格限速。
    // /pair/state 是确认轮询（不收配对码，confirmId 不可枚举），不占配对限速桶，
    // 否则 2.5s 一次的轮询自己就会触发 20/min 熔断。
    if (pathname.startsWith(PAIR_PREFIX)) {
      const isStatePoll = pathname === `${PAIR_PREFIX}/state`
      if (!isStatePoll && !limiter.allow(limiterKeyOf(req))) {
        res.writeHead(429, withSecurityHeaders({ 'content-type': 'text/plain; charset=utf-8' }))
        res.end('too many pairing attempts')
        return
      }
      proxy(req, res)
      return
    }

    // 其余一律要求已配对设备
    if (device === undefined) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(302, withSecurityHeaders({ location: PAIR_PREFIX }))
        res.end()
        return
      }
      res.writeHead(401, withSecurityHeaders({ 'content-type': 'text/plain; charset=utf-8' }))
      res.end('mobile-bridge: pair this device first')
      return
    }

    // 走到这里说明请求已带有效设备令牌 —— 只可能是手机侧，因此一律观察会话创建/分叉/prompt。
    // 注意不能用来源 IP 判断：Tailscale serve / cloudflared 都会以 loopback 回源。
    watchSessionOrigin(pathname, req.method, res)
    proxy(req, res)
  }

  const upgradeHandler = (req, socket, head) => {
    if (authenticate(req) === undefined) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nx-content-type-options: nosniff\r\nconnection: close\r\n\r\n',
      )
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head)
  }

  /** 需要绑定的地址集合：显式 edgeHost + （可选）局域网地址。 */
  const bindAddresses = () => {
    const list = []
    const push = (address) => {
      if (typeof address !== 'string' || address === '') return
      if (!list.includes(address)) list.push(address)
    }
    if (config.edgeHost === 'auto') {
      const lan = preferredLanAddress()
      push(lan === undefined ? '127.0.0.1' : lan.address)
      push('127.0.0.1')
    } else {
      push(config.edgeHost)
      if (config.enableLan !== false) {
        const lan = preferredLanAddress()
        if (lan !== undefined) push(lan.address)
      }
    }
    return list
  }

  let activeBindings = []

  const start = async () => {
    if (servers.length > 0) return { ok: true, bindings: activeBindings }
    const addresses = bindAddresses()
    const results = await Promise.all(
      addresses.map(
        (address) =>
          new Promise((resolve) => {
            const server = http.createServer(requestHandler)
            server.on('upgrade', upgradeHandler)
            const onError = (error) => {
              log(`edge bind failed on ${address}:${config.edgePort}: ${error?.message ?? error}`)
              resolve({ address, ok: false })
            }
            server.once('error', onError)
            server.listen(config.edgePort, address, () => {
              server.removeListener('error', onError)
              server.on('error', (error) => log(`edge error on ${address}: ${error?.message ?? error}`))
              servers.push(server)
              log(`edge listening on ${address}:${config.edgePort}`)
              resolve({ address, ok: true })
            })
          }),
      ),
    )
    activeBindings = results.filter((entry) => entry.ok).map((entry) => entry.address)
    return { ok: activeBindings.length > 0, bindings: activeBindings }
  }

  const stop = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            try {
              server.close(() => resolve())
            } catch {
              resolve()
            }
          }),
      ),
    )
    servers.length = 0
    activeBindings = []
  }

  return {
    start,
    stop,
    isListening: () => servers.length > 0,
    bindings: () => [...activeBindings],
  }
}
